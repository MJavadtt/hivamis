import type { FastifyPluginAsync } from 'fastify';
import {
  createContractSchema, createAmendmentSchema, createInvoiceSchema,
  createPaymentSchema, paginationSchema,
} from '@hiva/contracts';
import { prisma } from '../db.js';
import { registerCrud } from '../lib/crud.js';
import { actorFrom, page, parse } from '../lib/http.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { nextCode } from '../lib/codes.js';
import { baseCurrency, convert, convertMany, currencyFa, D, rateFor, settledEpsilon } from '../finance/fx.js';
import { money, sumOf, toMoney, type Money } from '../lib/money.js';
import { assertOwnReferences } from '../lib/scope.js';

const commercialRoutes: FastifyPluginAsync = async (app) => {
  /* ── Contracts ───────────────────────────────────────────────────────── */
  registerCrud(app, {
    path: 'contracts', model: 'contract', workflowEntity: 'contract', codeScope: 'contract',
    permissions: { read: 'contract.read', write: 'contract.request' },
    createSchema: createContractSchema, updateSchema: createContractSchema.partial(),
    sortable: ['createdAt', 'startDate', 'contractValue'],
    searchable: ['title', 'contractNumber', 'scopeSummary'],
    filter: (req) => {
      const { state, companyId, projectId } = req.query as Record<string, string | undefined>;
      return {
        ...(state ? { state } : {}), ...(companyId ? { companyId } : {}),
        ...(projectId ? { projectId } : {}),
      };
    },
    listInclude: {
      company: { select: { id: true, legalName: true } },
      project: { select: { id: true, code: true, name: true } },
    },
    detailInclude: {
      company: true, project: true, proposal: { select: { id: true, code: true, title: true } },
      amendments: { orderBy: { effectiveDate: 'desc' } }, documents: { where: { supersededAt: null } },
    },
    // Roadmap #28: a contract written in another currency is booked at today's rate, and keeps it.
    toCreate: async (input, actor) => {
      const { currency, ...rest } = input as { currency?: string; contractValue: number } & Record<string, unknown>;
      const fx = await convert(prisma, actor.organizationId, currency, rest.contractValue, new Date());
      return { ...rest, contractValue: fx.base, currency: fx.currency, fxRate: fx.fxRate, fxRateDate: fx.fxRateDate, originalValue: fx.original, createdById: actor.id };
    },
    toUpdate: async (input, before, actor) => {
      const { currency, ...rest } = input as { currency?: string; contractValue?: number } & Record<string, unknown>;
      if (rest.contractValue === undefined && currency === undefined) return rest;
      const value = rest.contractValue ?? Number(before.originalValue ?? before.contractValue);
      const fx = await convert(prisma, actor.organizationId, currency ?? before.currency, value, new Date());
      return { ...rest, contractValue: fx.base, currency: fx.currency, fxRate: fx.fxRate, fxRateDate: fx.fxRateDate, originalValue: fx.original };
    },
  });

  app.post('/contracts/:id/amendments', {
    preHandler: [app.authenticate, app.requirePermissions('contract.amend')],
  }, async (req, reply) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(createAmendmentSchema, { ...(req.body as object), contractId: id });

    const contract = await prisma.contract.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!contract) throw notFound('قرارداد');
    if (!['SIGNED', 'REGISTERED'].includes(contract.state)) {
      throw badRequest('CONTRACT_NOT_ACTIVE', 'الحاقیه فقط برای قرارداد امضاشده/ثبت‌شده قابل صدور است.');
    }

    // A delta on a contract in another currency is written in that currency (roadmap #28) and
    // booked at today's rate; the contract's base value moves by exactly that booked amount.
    const fx = await convert(prisma, actor.organizationId, contract.currency, input.valueDelta, new Date());
    const amendment = await prisma.$transaction(async (tx) => {
      const created = await tx.amendment.create({
        data: { ...input, valueDelta: fx.base, originalValueDelta: fx.original, fxRate: fx.fxRate, fxRateDate: fx.fxRateDate, createdById: actor.id },
      });
      // An amendment moves the contract value and, when tied to a project, its contract value too.
      const newValue = D(contract.contractValue).add(fx.base);
      const newOriginal = contract.originalValue != null ? D(contract.originalValue).add(input.valueDelta) : null;
      const newEnd = new Date(contract.endDate.getTime() + input.durationDeltaDays * 86_400_000);
      await tx.contract.update({
        where: { id }, data: { contractValue: newValue, originalValue: newOriginal, endDate: newEnd },
      });
      if (contract.projectId) {
        await tx.project.update({
          where: { id: contract.projectId },
          data: { contractValue: newValue, originalContractValue: newOriginal, contractCurrency: contract.currency, plannedEnd: newEnd },
        });
      }
      return created;
    });

    await audit({
      organizationId: actor.organizationId, actorId: actor.id, action: 'CREATE',
      entityType: 'amendment', entityId: amendment.id, after: amendment,
      reason: input.changes, ipAddress: actor.ipAddress, requestId: actor.requestId,
    });
    return reply.code(201).send(amendment);
  });

  /* ── Invoices ────────────────────────────────────────────────────────── */
  app.get('/invoices', {
    preHandler: [app.authenticate, app.requirePermissions('finance.read')],
  }, async (req) => {
    const actor = actorFrom(req);
    const q = parse(paginationSchema, req.query);
    const { state, kind, companyId, projectId } = req.query as Record<string, string | undefined>;
    const where = {
      organizationId: actor.organizationId,
      ...(state ? { state } : {}), ...(kind ? { kind } : {}),
      ...(companyId ? { companyId } : {}), ...(projectId ? { projectId } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.invoice.findMany({
        where,
        include: {
          company: { select: { id: true, legalName: true } },
          project: { select: { id: true, code: true, name: true } },
          // Where it stands with سامانهٔ مؤدیان (#32): the latest report only.
          taxSubmissions: { select: { subject: true, status: true, taxId: true }, orderBy: { createdAt: 'desc' }, take: 1 },
        },
        orderBy: { issueDate: 'desc' },
        skip: (q.page - 1) * q.pageSize, take: q.pageSize,
      }),
      prisma.invoice.count({ where }),
    ]);
    return page(items, total, q);
  });

  app.get('/invoices/:id', {
    preHandler: [app.authenticate, app.requirePermissions('finance.read')],
  }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const invoice = await prisma.invoice.findFirst({ where: { id, organizationId: actor.organizationId },
      include: { company: true, project: true, contract: true, payments: true },
    });
    if (!invoice) throw notFound('سند مالی');
    return invoice;
  });

  app.post('/invoices', {
    preHandler: [app.authenticate, app.requirePermissions('finance.invoice')],
  }, async (req, reply) => {
    const actor = actorFrom(req);
    const input = parse(createInvoiceSchema, req.body);
    // Every id the request names must be the caller's organisation's (audit SEC-12).
    await assertOwnReferences('invoice', input, actor.organizationId);
    // Totals are computed server-side; a client-supplied total is never trusted. Lines are in the
    // invoice's currency; the base totals use the rate in force on the issue date (roadmap #28).
    const subtotal = input.lines.reduce((s, l) => D(s).add(D(l.quantity).mul(l.unitPrice)), D(0));
    const taxAmount = subtotal.mul(input.taxPercent).div(100);
    const fx = await convertMany(prisma, actor.organizationId, input.currency, { subtotal, taxAmount }, input.issueDate);

    const invoice = await prisma.invoice.create({
      data: {
        organizationId: actor.organizationId,
        code: await nextCode(prisma, 'invoice'),
        kind: input.kind, number: input.number, companyId: input.companyId,
        projectId: input.projectId ?? null, contractId: input.contractId ?? null,
        issueDate: input.issueDate, dueDate: input.dueDate ?? null,
        lines: input.lines as object, subtotal: fx.base.subtotal, taxPercent: input.taxPercent,
        taxAmount: fx.base.taxAmount, total: fx.base.subtotal.add(fx.base.taxAmount), notes: input.notes ?? null,
        currency: fx.currency, fxRate: fx.fxRate, fxRateDate: fx.fxRateDate,
        originalSubtotal: fx.original?.subtotal ?? null, originalTaxAmount: fx.original?.taxAmount ?? null,
        originalTotal: fx.original ? fx.original.subtotal.add(fx.original.taxAmount) : null,
        originalPaidAmount: fx.original ? 0 : null,
        createdById: actor.id,
      },
    });
    await audit({
      organizationId: actor.organizationId, actorId: actor.id, action: 'CREATE',
      entityType: 'invoice', entityId: invoice.id, after: invoice,
      ipAddress: actor.ipAddress, requestId: actor.requestId,
    });
    return reply.code(201).send(invoice);
  });

  /* ── Payments ────────────────────────────────────────────────────────── */
  app.get('/payments', {
    preHandler: [app.authenticate, app.requirePermissions('finance.read')],
  }, async (req) => {
    const actor = actorFrom(req);
    const q = parse(paginationSchema, req.query);
    const { direction, projectId, invoiceId } = req.query as Record<string, string | undefined>;
    const where = {
      organizationId: actor.organizationId,
      ...(direction ? { direction } : {}), ...(projectId ? { projectId } : {}),
      ...(invoiceId ? { invoiceId } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.payment.findMany({
        where, include: { invoice: { select: { id: true, number: true, total: true } } },
        orderBy: { occurredAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize,
      }),
      prisma.payment.count({ where }),
    ]);
    return page(items, total, q);
  });

  /** Recording a receipt rolls the invoice forward to PARTIALLY_PAID / PAID atomically. */
  app.post('/payments', {
    preHandler: [app.authenticate, app.requirePermissions('finance.payment')],
  }, async (req, reply) => {
    const actor = actorFrom(req);
    const input = parse(createPaymentSchema, req.body);
    await assertOwnReferences('payment', input, actor.organizationId);
    const base = await baseCurrency(prisma, actor.organizationId);
    const linked = input.invoiceId
      ? await prisma.invoice.findFirst({ where: { id: input.invoiceId, organizationId: actor.organizationId } })
      : null;
    if (input.invoiceId && !linked) throw notFound('سند مالی');
    if (input.mediaOrderId) {
      const mo = await prisma.mediaOrder.findFirst({ where: { id: input.mediaOrderId, organizationId: actor.organizationId }, select: { id: true } });
      if (!mo) throw notFound('سفارش رسانه');
      if (input.direction !== 'OUT') throw badRequest('MEDIA_PAYMENT_OUT_ONLY', 'پرداخت به رسانه یک پرداخت خروجی است.');
    }
    const foreignInvoice = linked && linked.currency !== base ? linked : null;

    // Roadmap #28. A receipt against an invoice in another currency must say what it is in: read
    // as the wrong currency, a figure is off by the exchange rate — a factor of a million.
    if (foreignInvoice && !input.currency) {
      throw new AppError(422, 'FX_CURRENCY_REQUIRED', `این فاکتور به ${currencyFa(foreignInvoice.currency)} است؛ ارز مبلغ دریافتی را مشخص کنید (${currencyFa(foreignInvoice.currency)} یا ${currencyFa(base)}).`);
    }
    const paidIn = input.currency ?? base;
    if (foreignInvoice && paidIn !== base && paidIn !== foreignInvoice.currency) {
      throw new AppError(422, 'FX_CURRENCY_MISMATCH', `دریافتیِ فاکتور ${currencyFa(foreignInvoice.currency)} باید به همان ارز یا به ${currencyFa(base)} ثبت شود، نه ${currencyFa(paidIn)}.`);
    }
    const fx = await convert(prisma, actor.organizationId, paidIn, input.amount, input.occurredAt);
    // How much of the invoice this settles, counted in the invoice's own currency.
    let settledOriginal: ReturnType<typeof D> | null = null;
    let fxRate = fx.fxRate, fxRateDate = fx.fxRateDate;
    if (foreignInvoice) {
      if (paidIn === foreignInvoice.currency) settledOriginal = D(input.amount);
      else {
        const r = await rateFor(prisma, actor.organizationId, foreignInvoice.currency, input.occurredAt);
        settledOriginal = D(input.amount).div(r.rate).toDecimalPlaces(2);
        fxRate = r.rate; fxRateDate = r.effectiveDate;           // the invoice currency's rate that day
      }
    }

    const payment = await prisma.$transaction(async (tx) => {
      const created = await tx.payment.create({
        data: {
          organizationId: actor.organizationId,
          invoiceId: input.invoiceId ?? null, projectId: input.projectId ?? null,
          supplierId: input.supplierId ?? null, direction: input.direction,
          amount: fx.base, occurredAt: input.occurredAt, method: input.method,
          reference: input.reference ?? null, description: input.description ?? null,
          currency: paidIn, fxRate, fxRateDate, originalAmount: fx.original, settledOriginal,
          mediaOrderId: input.mediaOrderId ?? null,
          createdById: actor.id,
        },
      });

      if (linked && input.direction === 'IN') {
        if (foreignInvoice) {
          // Settled in the invoice's currency; paidAmount is that share at the invoice's own rate,
          // so "outstanding" in base never includes an exchange difference — that is reported as one.
          const agg = await tx.payment.aggregate({ where: { invoiceId: linked.id, direction: 'IN' }, _sum: { settledOriginal: true } });
          const settled = D(agg._sum.settledOriginal ?? 0);
          const total = D(linked.originalTotal ?? 0);
          const capped = settled.gt(total) ? total : settled;
          await tx.invoice.update({
            where: { id: linked.id },
            data: {
              originalPaidAmount: settled, paidAmount: capped.mul(linked.fxRate).toDecimalPlaces(2),
              state: settled.gte(total.sub(settledEpsilon(linked.currency))) ? 'PAID' : settled.gt(0) ? 'PARTIALLY_PAID' : linked.state,
            },
          });
        } else {
          const agg = await tx.payment.aggregate({
            where: { invoiceId: linked.id, direction: 'IN' }, _sum: { amount: true },
          });
          // Decimals (audit CALC-2): a float sum of payments could fall a hair short of the total.
          const paid = money(agg._sum.amount);
          const total = money(linked.total);
          await tx.invoice.update({
            where: { id: linked.id },
            data: {
              paidAmount: paid,
              state: paid.gte(total.sub(settledEpsilon(base))) ? 'PAID' : paid.gt(0) ? 'PARTIALLY_PAID' : linked.state,
            },
          });
        }
      }
      return created;
    });

    await audit({
      organizationId: actor.organizationId, actorId: actor.id, action: 'CREATE',
      entityType: 'payment', entityId: payment.id, after: payment,
      ipAddress: actor.ipAddress, requestId: actor.requestId,
    });
    return reply.code(201).send(payment);
  });

  /** Doc_H §J.91 / §15 — settle the project and tick the financial closure condition. */
  app.post('/projects/:id/settle', {
    preHandler: [app.authenticate, app.requirePermissions('finance.settle')],
  }, async (req, reply) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const { notes } = (req.body ?? {}) as { notes?: string };

    const project = await prisma.project.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!project) throw notFound('پروژه');

    const invoices = await prisma.invoice.findMany({
      where: { projectId: id, state: { not: 'CANCELLED' } },
    });
    // Decimals (audit CALC-2): a float balance of exactly-paid invoices could be 5e-17 — never zero.
    const totalInvoiced = sumOf(invoices.map((i) => i.total));
    const totalReceived = sumOf(invoices.map((i) => i.paidAmount));
    const balance = totalInvoiced.sub(totalReceived);
    // Within half of the base currency's smallest unit is settled (audit CALC-3): a rate conversion's
    // last digit is not a debt.
    const within = settledEpsilon(await baseCurrency(prisma, actor.organizationId));
    const status = balance.abs().lte(within) && totalInvoiced.gt(0) ? 'FULLY_SETTLED' : balance.gt(0) ? 'PARTIAL' : 'DISPUTED';

    const settlement = await prisma.$transaction(async (tx) => {
      const s = await tx.settlement.upsert({
        where: { projectId: id },
        create: {
          projectId: id, totalInvoiced, totalReceived, balance, status,
          notes: notes ?? null, settledById: actor.id,
        },
        update: { totalInvoiced, totalReceived, balance, status, notes: notes ?? null, settledById: actor.id },
      });
      await tx.closureChecklist.upsert({
        where: { projectId: id },
        create: {
          projectId: id, financialStatusClear: status === 'FULLY_SETTLED', updatedById: actor.id,
        },
        update: { financialStatusClear: status === 'FULLY_SETTLED', updatedById: actor.id },
      });
      return s;
    });

    await audit({
      organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE',
      entityType: 'settlement', entityId: settlement.id, after: settlement,
      ipAddress: actor.ipAddress, requestId: actor.requestId,
    });
    return reply.code(201).send(settlement);
  });

  /** Project P&L — budget vs actual cost vs revenue, with declared-cost breakdown by unit. */
  app.get('/projects/:id/finance', {
    preHandler: [app.authenticate, app.requirePermissions('finance.read')],
  }, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const project = await prisma.project.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!project) throw notFound('پروژه');

    const [invoices, payments, costs, settlement] = await Promise.all([
      prisma.invoice.findMany({ where: { projectId: id } }),
      prisma.payment.findMany({ where: { projectId: id } }),
      prisma.costDeclaration.findMany({ where: { workOrder: { projectId: id } } }),
      prisma.settlement.findUnique({ where: { projectId: id } }),
    ]);

    // Decimals (audit CALC-2), each figure rounded once where it leaves.
    const units: Record<string, Money> = {};
    for (const c of costs) units[c.departmentCode] = (units[c.departmentCode] ?? money(0)).add(money(c.internalCost)).add(money(c.externalCost));
    const byUnit = Object.fromEntries(Object.entries(units).map(([k, v]) => [k, toMoney(v)]));
    const actual = sumOf(Object.values(units));
    const revenue = money(project.contractValue);
    const invoiced = sumOf(invoices.filter((i) => i.state !== 'CANCELLED').map((i) => i.total));
    const received = sumOf(invoices.map((i) => i.paidAmount));
    const budget = money(project.plannedBudget);

    return {
      budget: toMoney(budget), actualCost: toMoney(actual), revenue: toMoney(revenue),
      margin: toMoney(revenue.sub(actual)),
      marginPercent: revenue.gt(0) ? toMoney(revenue.sub(actual).div(revenue).mul(100)) : null,
      budgetVariance: toMoney(budget.sub(actual)),
      budgetVariancePercent: budget.gt(0) ? toMoney(budget.sub(actual).div(budget).mul(100)) : null,
      invoiced: toMoney(invoiced), received: toMoney(received), outstanding: toMoney(invoiced.sub(received)),
      costByUnit: byUnit, invoices, payments, settlement,
    };
  });
};

export default commercialRoutes;
