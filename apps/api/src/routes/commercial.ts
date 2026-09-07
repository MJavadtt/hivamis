import type { FastifyPluginAsync } from 'fastify';
import {
  createContractSchema, createAmendmentSchema, createInvoiceSchema,
  createPaymentSchema, paginationSchema,
} from '@hiva/contracts';
import { prisma } from '../db.js';
import { registerCrud } from '../lib/crud.js';
import { actorFrom, page, parse } from '../lib/http.js';
import { badRequest, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { nextCode } from '../lib/codes.js';

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
      amendments: { orderBy: { effectiveDate: 'desc' } }, documents: true,
    },
    toCreate: (input, actor) => ({ ...input, createdById: actor.id }),
  });

  app.post('/contracts/:id/amendments', {
    preHandler: [app.authenticate, app.requirePermissions('contract.amend')],
  }, async (req, reply) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(createAmendmentSchema, { ...(req.body as object), contractId: id });

    const contract = await prisma.contract.findUnique({ where: { id } });
    if (!contract) throw notFound('قرارداد');
    if (!['SIGNED', 'REGISTERED'].includes(contract.state)) {
      throw badRequest('CONTRACT_NOT_ACTIVE', 'الحاقیه فقط برای قرارداد امضاشده/ثبت‌شده قابل صدور است.');
    }

    const amendment = await prisma.$transaction(async (tx) => {
      const created = await tx.amendment.create({
        data: { ...input, createdById: actor.id },
      });
      // An amendment moves the contract value and, when tied to a project, its contract value too.
      const newValue = Number(contract.contractValue) + Number(input.valueDelta);
      const newEnd = new Date(contract.endDate.getTime() + input.durationDeltaDays * 86_400_000);
      await tx.contract.update({
        where: { id }, data: { contractValue: newValue, endDate: newEnd },
      });
      if (contract.projectId) {
        await tx.project.update({
          where: { id: contract.projectId },
          data: { contractValue: newValue, plannedEnd: newEnd },
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
    const { id } = req.params as { id: string };
    const invoice = await prisma.invoice.findUnique({
      where: { id },
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
    // Totals are computed server-side; a client-supplied total is never trusted.
    const subtotal = input.lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
    const taxAmount = (subtotal * input.taxPercent) / 100;

    const invoice = await prisma.invoice.create({
      data: {
        organizationId: actor.organizationId,
        code: await nextCode(prisma, 'invoice'),
        kind: input.kind, number: input.number, companyId: input.companyId,
        projectId: input.projectId ?? null, contractId: input.contractId ?? null,
        issueDate: input.issueDate, dueDate: input.dueDate ?? null,
        lines: input.lines as object, subtotal, taxPercent: input.taxPercent,
        taxAmount, total: subtotal + taxAmount, notes: input.notes ?? null,
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

    const payment = await prisma.$transaction(async (tx) => {
      const created = await tx.payment.create({
        data: {
          organizationId: actor.organizationId,
          invoiceId: input.invoiceId ?? null, projectId: input.projectId ?? null,
          supplierId: input.supplierId ?? null, direction: input.direction,
          amount: input.amount, occurredAt: input.occurredAt, method: input.method,
          reference: input.reference ?? null, description: input.description ?? null,
          createdById: actor.id,
        },
      });

      if (input.invoiceId && input.direction === 'IN') {
        const agg = await tx.payment.aggregate({
          where: { invoiceId: input.invoiceId, direction: 'IN' }, _sum: { amount: true },
        });
        const paid = Number(agg._sum.amount ?? 0);
        const invoice = await tx.invoice.findUnique({ where: { id: input.invoiceId } });
        if (invoice) {
          const total = Number(invoice.total);
          await tx.invoice.update({
            where: { id: invoice.id },
            data: {
              paidAmount: paid,
              state: paid >= total ? 'PAID' : paid > 0 ? 'PARTIALLY_PAID' : invoice.state,
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

    const project = await prisma.project.findUnique({ where: { id } });
    if (!project) throw notFound('پروژه');

    const invoices = await prisma.invoice.findMany({
      where: { projectId: id, state: { not: 'CANCELLED' } },
    });
    const totalInvoiced = invoices.reduce((s, i) => s + Number(i.total), 0);
    const totalReceived = invoices.reduce((s, i) => s + Number(i.paidAmount), 0);
    const balance = totalInvoiced - totalReceived;
    const status = balance === 0 && totalInvoiced > 0 ? 'FULLY_SETTLED' : balance > 0 ? 'PARTIAL' : 'DISPUTED';

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
    const { id } = req.params as { id: string };
    const project = await prisma.project.findUnique({ where: { id } });
    if (!project) throw notFound('پروژه');

    const [invoices, payments, costs, settlement] = await Promise.all([
      prisma.invoice.findMany({ where: { projectId: id } }),
      prisma.payment.findMany({ where: { projectId: id } }),
      prisma.costDeclaration.findMany({ where: { workOrder: { projectId: id } } }),
      prisma.settlement.findUnique({ where: { projectId: id } }),
    ]);

    const byUnit: Record<string, number> = {};
    for (const c of costs) {
      byUnit[c.departmentCode] =
        (byUnit[c.departmentCode] ?? 0) + Number(c.internalCost) + Number(c.externalCost);
    }
    const actualCost = Object.values(byUnit).reduce((a, b) => a + b, 0);
    const revenue = Number(project.contractValue ?? 0);
    const invoiced = invoices.filter((i) => i.state !== 'CANCELLED').reduce((s, i) => s + Number(i.total), 0);
    const received = invoices.reduce((s, i) => s + Number(i.paidAmount), 0);
    const budget = Number(project.plannedBudget ?? 0);

    return {
      budget, actualCost, revenue,
      margin: revenue - actualCost,
      marginPercent: revenue > 0 ? Number((((revenue - actualCost) / revenue) * 100).toFixed(2)) : null,
      budgetVariance: budget - actualCost,
      budgetVariancePercent: budget > 0 ? Number((((budget - actualCost) / budget) * 100).toFixed(2)) : null,
      invoiced, received, outstanding: invoiced - received,
      costByUnit: byUnit, invoices, payments, settlement,
    };
  });
};

export default commercialRoutes;
