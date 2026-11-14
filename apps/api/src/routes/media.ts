import type { FastifyPluginAsync } from 'fastify';
import { billMediaSchema, createMediaOrderSchema, MEDIA_CHANNEL_LABELS, paginationSchema, vendorInvoiceSchema, type MediaChannel } from '@hiva/contracts';
import { Prisma } from '@prisma/client';
import { prisma, type Tx } from '../db.js';
import { narrowed, reachFor } from '../auth/visibility.js';
import { actorFrom, page, parse } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { nextCode } from '../lib/codes.js';
import { AppError, forbidden, notFound } from '../lib/errors.js';
import { allowedFor } from '../workflow/engine.js';
import { MEDIA_BUYING_UNITS, mediaTolerance } from '../workflow/guards.js';
import { convertMany, D } from '../finance/fx.js';
import { capped, FACT_CAP, over } from '../lib/limits.js';
import { money, rounded, sumOf, toMoney } from '../lib/money.js';

const FA = '۰۱۲۳۴۵۶۷۸۹';
const fa = (v: string | number) => String(v).replace(/\d/g, (c) => FA[Number(c)]!);
const n = (v: unknown) => (v == null ? 0 : Number(v));

/**
 * The media order's money, from the vendor's quote (roadmap #31).
 *   COMMISSION: the client pays the gross; the vendor is owed gross less the agency commission.
 *   MARKUP:     the vendor is owed the net; the client pays net plus the agency markup.
 * The vendor's net is a pass-through either way; the difference is the agency's revenue.
 */
export function priceMedia(model: 'COMMISSION' | 'MARKUP', quoted: Prisma.Decimal.Value, percent: Prisma.Decimal.Value) {
  const q = D(quoted), p = D(percent).div(100);
  const client = model === 'COMMISSION' ? q : q.mul(D(1).add(p));
  const net = model === 'COMMISSION' ? q.mul(D(1).sub(p)) : q;
  return { client: client.toDecimalPlaces(2), net: net.toDecimalPlaces(2) };
}

async function priced(tx: Tx, organizationId: string, input: { pricingModel: 'COMMISSION' | 'MARKUP'; amount: number; commissionPercent: number; currency?: string }) {
  const { client, net } = priceMedia(input.pricingModel, input.amount, input.commissionPercent);
  // Booked at today's rate (#28): the order is the commitment, and it is made today.
  const fx = await convertMany(tx, organizationId, input.currency, { client, net }, new Date());
  return {
    pricingModel: input.pricingModel, commissionPercent: input.commissionPercent, quotedAmount: input.amount,
    clientAmount: fx.base.client, netAmount: fx.base.net, agencyRevenue: fx.base.client.sub(fx.base.net),
    currency: fx.currency, fxRate: fx.fxRate, fxRateDate: fx.fxRateDate,
    originalClientAmount: fx.original?.client ?? null, originalNetAmount: fx.original?.net ?? null,
  };
}

/** Who may write media orders: the media unit, Account, management — or anyone who prices. */
async function assertMediaBuyer(actor: ReturnType<typeof actorFrom>) {
  if (actor.permissions.includes('pricing.set_price')) return;
  if (!MEDIA_BUYING_UNITS.includes(actor.departmentCode ?? '')) {
    throw forbidden('سفارش خرید رسانه را واحد رسانه، اکانت یا مدیریت ثبت می‌کند.');
  }
}

const mediaRoutes: FastifyPluginAsync = async (app) => {
  const include = {
    project: { select: { id: true, code: true, name: true, companyId: true } },
    supplier: { select: { id: true, name: true } },
    clientInvoice: { select: { id: true, code: true, number: true, state: true } },
  } as const;

  app.get('/media-orders', { preHandler: [app.authenticate, app.requirePermissions('pricing.read')] }, async (req) => {
    const actor = actorFrom(req);
    const q = parse(paginationSchema, req.query);
    const { projectId, state, supplierId } = req.query as Record<string, string | undefined>;
    const where = narrowed('mediaOrder', await reachFor(req, actor), { organizationId: actor.organizationId, ...(projectId ? { projectId } : {}), ...(state ? { state } : {}), ...(supplierId ? { supplierId } : {}) });
    const [items, total] = await Promise.all([
      prisma.mediaOrder.findMany({ where, include, orderBy: { flightStart: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      prisma.mediaOrder.count({ where }),
    ]);
    return page(items.map((o) => ({ ...o, availableTransitions: allowedFor('mediaOrder', o.state, actor.permissions) })), total, q);
  });

  app.get('/media-orders/:id', { preHandler: [app.authenticate, app.requirePermissions('pricing.read')] }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const o = await prisma.mediaOrder.findFirst({ where: { id, organizationId: actor.organizationId }, include: { ...include, payments: true } });
    if (!o) throw notFound('سفارش رسانه');
    return { ...o, availableTransitions: allowedFor('mediaOrder', o.state, actor.permissions) };
  });

  app.post('/media-orders', { preHandler: [app.authenticate, app.requirePermissions('media.buy')] }, async (req, reply) => {
    const actor = actorFrom(req);
    const input = parse(createMediaOrderSchema, req.body);
    await assertMediaBuyer(actor);
    const [project, supplier] = await Promise.all([
      prisma.project.findFirst({ where: { id: input.projectId, organizationId: actor.organizationId, deletedAt: null }, select: { id: true } }),
      prisma.supplier.findFirst({ where: { id: input.supplierId, organizationId: actor.organizationId, isActive: true }, select: { id: true } }),
    ]);
    if (!project) throw notFound('پروژه');
    if (!supplier) throw notFound('رسانه (تأمین‌کننده)');
    if (input.workOrderId && !await prisma.workOrder.findFirst({ where: { id: input.workOrderId, projectId: input.projectId }, select: { id: true } })) throw notFound('سفارش کار');

    const order = await prisma.mediaOrder.create({
      data: {
        organizationId: actor.organizationId, code: await nextCode(prisma, 'mediaOrder'),
        projectId: input.projectId, supplierId: input.supplierId, workOrderId: input.workOrderId ?? null,
        channel: input.channel, placement: input.placement, flightStart: input.flightStart, flightEnd: input.flightEnd,
        ...(await priced(prisma, actor.organizationId, input)), createdById: actor.id,
      },
      include,
    });
    await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'CREATE', entityType: 'mediaOrder', entityId: order.id, after: order, ipAddress: actor.ipAddress, requestId: actor.requestId });
    return reply.code(201).send(order);
  });

  /** A draft can still change; a booked order is a commitment to the vendor. */
  app.patch('/media-orders/:id', { preHandler: [app.authenticate, app.requirePermissions('media.buy')] }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    await assertMediaBuyer(actor);
    const before = await prisma.mediaOrder.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!before) throw notFound('سفارش رسانه');
    if (before.state !== 'DRAFT') throw new AppError(422, 'MEDIA_ORDER_NOT_DRAFT', 'سفارش رزروشده تغییر نمی‌کند؛ برای تغییر، آن را لغو و سفارش تازه ثبت کنید.');
    const merged = parse(createMediaOrderSchema, {
      projectId: before.projectId, supplierId: before.supplierId, workOrderId: before.workOrderId ?? undefined,
      channel: before.channel, placement: before.placement, flightStart: before.flightStart, flightEnd: before.flightEnd,
      pricingModel: before.pricingModel, amount: Number(before.quotedAmount), commissionPercent: Number(before.commissionPercent), currency: before.currency,
      ...(req.body as object),
    });
    const updated = await prisma.mediaOrder.update({
      where: { id },
      data: {
        channel: merged.channel, placement: merged.placement, flightStart: merged.flightStart, flightEnd: merged.flightEnd,
        supplierId: merged.supplierId, ...(await priced(prisma, actor.organizationId, merged)),
      },
      include,
    });
    await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE', entityType: 'mediaOrder', entityId: id, before, after: updated, ipAddress: actor.ipAddress, requestId: actor.requestId });
    return updated;
  });

  /** The vendor's invoice, in the order's currency, set against what was booked. */
  app.post('/media-orders/:id/vendor-invoice', { preHandler: [app.authenticate, app.requirePermissions('finance.payment')] }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(vendorInvoiceSchema, req.body);
    const before = await prisma.mediaOrder.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!before) throw notFound('سفارش رسانه');
    if (!['BOOKED', 'AIRED'].includes(before.state)) throw new AppError(422, 'MEDIA_ORDER_NOT_OPEN', 'صورت‌حساب رسانه برای سفارش رزروشده یا اجراشده ثبت می‌شود.');
    const expected = n(before.originalNetAmount ?? before.netAmount);
    const difference = toMoney(money(input.amount).sub(money(expected)));
    const updated = await prisma.mediaOrder.update({
      where: { id },
      data: { vendorInvoiceNumber: input.number, vendorInvoiceAmount: input.amount, vendorInvoiceDate: input.invoiceDate, discrepancyNote: input.discrepancyNote ?? null },
    });
    await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE', entityType: 'mediaOrder', entityId: id, before, after: updated, reason: input.discrepancyNote ?? 'vendor invoice', ipAddress: actor.ipAddress, requestId: actor.requestId });
    return {
      order: updated, expected, difference,
      matches: Math.abs(difference) <= mediaTolerance(expected),
    };
  });

  /**
   * The intermediary invoice: the client billed for media orders with the vendor's net (a
   * pass-through, marked as such on its line) and the agency's commission on separate lines.
   */
  app.post('/projects/:id/media-billing', { preHandler: [app.authenticate, app.requirePermissions('finance.invoice')] }, async (req, reply) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(billMediaSchema, req.body);
    const project = await prisma.project.findFirst({ where: { id, organizationId: actor.organizationId, deletedAt: null } });
    if (!project) throw notFound('پروژه');
    const orders = await prisma.mediaOrder.findMany({ where: { id: { in: input.orderIds }, projectId: id, organizationId: actor.organizationId } });
    const problems: string[] = [];
    if (orders.length !== input.orderIds.length) problems.push('سفارشی از پروژهٔ دیگر یا ناموجود در فهرست است');
    for (const o of orders) {
      if (!['BOOKED', 'AIRED', 'RECONCILED'].includes(o.state)) problems.push(`${o.code}: سفارش ${o.state === 'DRAFT' ? 'هنوز رزرو نشده' : 'لغو شده'} است`);
      if (o.clientInvoiceId) problems.push(`${o.code}: پیش‌تر صورت‌حساب شده است`);
    }
    const currencies = [...new Set(orders.map((o) => o.currency))];
    if (currencies.length > 1) problems.push('سفارش‌های یک صورت‌حساب باید یک ارز داشته باشند');
    if (problems.length) throw new AppError(422, 'MEDIA_BILLING_INVALID', 'برخی سفارش‌ها قابل صورت‌حساب نیستند', { problems });

    const lines = orders.flatMap((o) => {
      const client = n(o.originalClientAmount ?? o.clientAmount), net = n(o.originalNetAmount ?? o.netAmount);
      return [
        { description: `${MEDIA_CHANNEL_LABELS[o.channel as MediaChannel] ?? o.channel} — ${o.placement} (هزینهٔ عبوری رسانه، ${o.code})`, quantity: 1, unitPrice: net, passThrough: true, mediaOrderId: o.id },
        { description: `${o.pricingModel === 'COMMISSION' ? 'کمیسیون' : 'کارمزد'} آژانس — ${o.code} (${fa(n(o.commissionPercent))}٪)`, quantity: 1, unitPrice: toMoney(money(client).sub(money(net))), passThrough: false, mediaOrderId: o.id },
      ];
    });
    const subtotal = lines.reduce((s, l) => s.add(l.unitPrice), D(0));
    const taxAmount = subtotal.mul(input.taxPercent).div(100);
    const fx = await convertMany(prisma, actor.organizationId, currencies[0], { subtotal, taxAmount }, input.issueDate);

    const invoice = await prisma.$transaction(async (tx) => {
      const inv = await tx.invoice.create({
        data: {
          organizationId: actor.organizationId, code: await nextCode(tx, 'invoice'), kind: 'INVOICE', number: input.number,
          companyId: project.companyId, projectId: id, issueDate: input.issueDate, dueDate: input.dueDate ?? null,
          lines: lines as object, subtotal: fx.base.subtotal, taxPercent: input.taxPercent, taxAmount: fx.base.taxAmount,
          total: fx.base.subtotal.add(fx.base.taxAmount),
          currency: fx.currency, fxRate: fx.fxRate, fxRateDate: fx.fxRateDate,
          originalSubtotal: fx.original?.subtotal ?? null, originalTaxAmount: fx.original?.taxAmount ?? null,
          originalTotal: fx.original ? fx.original.subtotal.add(fx.original.taxAmount) : null, originalPaidAmount: fx.original ? 0 : null,
          notes: 'صورت‌حساب رسانه: هزینهٔ عبوری رسانه و کمیسیون آژانس در ردیف‌های جدا.',
          createdById: actor.id,
        },
      });
      await tx.mediaOrder.updateMany({ where: { id: { in: input.orderIds } }, data: { clientInvoiceId: inv.id } });
      return inv;
    });
    await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'CREATE', entityType: 'invoice', entityId: invoice.id, after: { ...invoice, mediaOrders: input.orderIds }, ipAddress: actor.ipAddress, requestId: actor.requestId });
    return reply.code(201).send(invoice);
  });

  /**
   * Media, the agency's way: what was billed, how much of it passed through to the vendors, what
   * the agency kept — and the four places money gets lost between them.
   */
  app.get('/reports/media', { preHandler: [app.authenticate, app.requirePermissions('pricing.read')] }, async (req) => {
    const actor = actorFrom(req);
    const { from, to } = req.query as { from?: string; to?: string };
    // The newest FACT_CAP orders in the window (audit PERF-4); `truncated` says when there were more.
    const read = await prisma.mediaOrder.findMany({
      where: {
        organizationId: actor.organizationId, state: { not: 'CANCELLED' },
        ...(from || to ? { flightStart: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lt: new Date(to) } : {}) } } : {}),
      },
      include, orderBy: { flightStart: 'desc' }, take: over(FACT_CAP),
    });
    const { rows: orders, truncated } = capped(read, FACT_CAP);
    const now = new Date();
    const sum = (xs: typeof orders) => {
      // Decimals (audit CALC-2): each figure rounded once, revenue as the difference of the two printed.
      const client = rounded(sumOf(xs.map((o) => o.clientAmount))), net = rounded(sumOf(xs.map((o) => o.netAmount)));
      const revenue = client.sub(net);
      return { orders: xs.length, billings: client.toNumber(), passThrough: net.toNumber(), revenue: revenue.toNumber(), effectivePercent: client.isZero() ? null : toMoney(revenue.div(client).mul(100)) };
    };
    const by = (key: (o: (typeof orders)[number]) => string, label: (o: (typeof orders)[number]) => string) =>
      [...new Set(orders.map(key))].map((k) => ({ key: k, labelFa: label(orders.find((o) => key(o) === k)!), ...sum(orders.filter((o) => key(o) === k)) }))
        .sort((a, b) => b.billings - a.billings);
    const brief = (o: (typeof orders)[number]) => ({ id: o.id, code: o.code, placement: o.placement, project: o.project, supplier: o.supplier, state: o.state, flightEnd: o.flightEnd, clientAmount: n(o.clientAmount), netAmount: n(o.netAmount), currency: o.currency });
    return {
      truncated,
      totals: sum(orders),
      byChannel: by((o) => o.channel, (o) => MEDIA_CHANNEL_LABELS[o.channel as MediaChannel] ?? o.channel),
      byVendor: by((o) => o.supplierId, (o) => o.supplier.name),
      byProject: by((o) => o.projectId, (o) => `${o.project.name} (${o.project.code})`),
      exceptions: {
        /** Run, and nobody billed the client: the agency is financing the client's media. */
        unbilled: orders.filter((o) => ['AIRED', 'RECONCILED'].includes(o.state) && !o.clientInvoiceId).map(brief),
        /** Billed, flight over, and still no proof it ran. */
        unproven: orders.filter((o) => o.state === 'BOOKED' && o.flightEnd < now).map(brief),
        /** Run, and the vendor's invoice has not arrived — a payable nobody has seen yet. */
        awaitingVendorInvoice: orders.filter((o) => o.state === 'AIRED' && o.vendorInvoiceAmount == null).map(brief),
        /** The vendor billed something other than what was booked. */
        discrepancies: orders.filter((o) => o.vendorInvoiceAmount != null && Math.abs(n(o.vendorInvoiceAmount) - n(o.originalNetAmount ?? o.netAmount)) > mediaTolerance(n(o.originalNetAmount ?? o.netAmount)))
          .map((o) => ({ ...brief(o), vendorInvoiceAmount: n(o.vendorInvoiceAmount), expected: n(o.originalNetAmount ?? o.netAmount), discrepancyNote: o.discrepancyNote })),
      },
    };
  });
};

export default mediaRoutes;
