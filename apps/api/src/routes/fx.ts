import type { FastifyPluginAsync } from 'fastify';
import { CURRENCIES, exchangeRateSchema, importRatesSchema } from '@hiva/contracts';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { actorFrom, parse } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { AppError, badRequest } from '../lib/errors.js';
import { jalaliToDate } from '../lib/jalali.js';
import { baseCurrency, currencyFa, D, dayKey, findRate } from '../finance/fx.js';
import { fxReport } from '../finance/report.js';

const DAY = 86_400_000;
const toLatin = (v: string) => v.replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0)).replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660));

/** Exchange rates (roadmap #28): the history every foreign figure is converted against. */
const fxRoutes: FastifyPluginAsync = async (app) => {
  app.get('/fx/rates', { preHandler: [app.authenticate, app.requirePermissions('finance.read')] }, async (req) => {
    const actor = actorFrom(req);
    const base = await baseCurrency(prisma, actor.organizationId);
    const today = new Date();
    const rows = await prisma.exchangeRate.findMany({
      where: { organizationId: actor.organizationId }, orderBy: [{ currency: 'asc' }, { effectiveDate: 'desc' }],
    });
    return {
      base, baseLabelFa: currencyFa(base), maxAgeDays: env.FX_MAX_RATE_AGE_DAYS,
      currencies: CURRENCIES.filter((c) => c !== base).map((c) => {
        const history = rows.filter((r) => r.currency === c);
        const latest = history[0];
        const ageDays = latest ? Math.round((dayKey(today).getTime() - latest.effectiveDate.getTime()) / DAY) : null;
        return {
          currency: c, labelFa: currencyFa(c),
          latest: latest ? { rate: latest.rate, effectiveDate: latest.effectiveDate, ageDays, stale: ageDays! > env.FX_MAX_RATE_AGE_DAYS } : null,
          history: history.slice(0, 30).map((r) => ({ id: r.id, rate: r.rate, effectiveDate: r.effectiveDate, source: r.source, note: r.note })),
        };
      }),
    };
  });

  /** The rate a figure dated `on` would convert at — asked while the figure is being typed. */
  app.get('/fx/rate', { preHandler: [app.authenticate] }, async (req) => {
    const actor = actorFrom(req);
    const { currency, on } = req.query as { currency?: string; on?: string };
    if (!currency || !(CURRENCIES as readonly string[]).includes(currency)) throw badRequest('UNKNOWN_CURRENCY', 'ارز نامعتبر است');
    const date = on ? new Date(on) : new Date();
    if (Number.isNaN(date.getTime())) throw badRequest('INVALID_DATE', 'تاریخ نامعتبر است');
    const base = await baseCurrency(prisma, actor.organizationId);
    if (currency === base) return { currency, base, rate: 1, effectiveDate: null, ageDays: 0, usable: true };
    const found = await findRate(prisma, actor.organizationId, currency, date);
    return {
      currency, base, rate: found?.rate ?? null, effectiveDate: found?.effectiveDate ?? null, ageDays: found?.ageDays ?? null,
      usable: !!found && found.ageDays <= env.FX_MAX_RATE_AGE_DAYS, maxAgeDays: env.FX_MAX_RATE_AGE_DAYS,
    };
  });

  /**
   * Record the rate for a day. Replacing a day's rate needs a reason, and says how many figures
   * were converted at the old one — they keep it: a booked figure does not move under anyone.
   */
  app.post('/fx/rates', { preHandler: [app.authenticate, app.requirePermissions('finance.rates')] }, async (req, reply) => {
    const actor = actorFrom(req);
    const input = parse(exchangeRateSchema, req.body);
    const base = await baseCurrency(prisma, actor.organizationId);
    if (input.currency === base) throw badRequest('FX_BASE_CURRENCY', `${currencyFa(base)} ارز پایهٔ سازمان است و نرخ ندارد`);
    const effectiveDate = dayKey(input.effectiveDate);
    const key = { organizationId_currency_effectiveDate: { organizationId: actor.organizationId, currency: input.currency, effectiveDate } };
    const existing = await prisma.exchangeRate.findUnique({ where: key });

    if (existing && D(existing.rate).equals(input.rate)) return reply.code(200).send({ rate: existing, replaced: null });
    if (existing && (input.note ?? '').length < 5) {
      throw new AppError(422, 'REASON_REQUIRED', 'برای این روز نرخی ثبت شده است؛ جایگزینی آن دلیل می‌خواهد (دست‌کم پنج نویسه).');
    }
    const keeping = existing ? await countConvertedAt(actor.organizationId, input.currency, effectiveDate) : 0;
    const saved = existing
      ? await prisma.exchangeRate.update({ where: { id: existing.id }, data: { rate: input.rate, note: input.note ?? null, source: 'MANUAL' } })
      : await prisma.exchangeRate.create({
          data: { organizationId: actor.organizationId, currency: input.currency, rate: input.rate, effectiveDate, note: input.note ?? null, createdById: actor.id },
        });
    await audit({
      organizationId: actor.organizationId, actorId: actor.id, action: existing ? 'UPDATE' : 'CREATE',
      entityType: 'exchangeRate', entityId: saved.id, before: existing ?? undefined, after: saved,
      reason: input.note ?? null, ipAddress: actor.ipAddress, requestId: actor.requestId,
    });
    return reply.code(existing ? 200 : 201).send({
      rate: saved,
      replaced: existing ? { previous: existing.rate, recordsKeepingPrevious: keeping } : null,
    });
  });

  /** Rates in bulk, for back-filling history. Never overwrites: a different rate for a recorded day is listed, not applied. */
  app.post('/fx/rates/import', { preHandler: [app.authenticate, app.requirePermissions('finance.rates')] }, async (req) => {
    const actor = actorFrom(req);
    const { csv } = parse(importRatesSchema, req.body);
    const base = await baseCurrency(prisma, actor.organizationId);
    const errors: { line: number; messageFa: string }[] = [];
    const conflicts: { line: number; currency: string; effectiveDate: Date; existing: unknown; proposed: number }[] = [];
    let created = 0, unchanged = 0;

    const lines = csv.split(/\r?\n/);
    for (const [i, raw] of lines.entries()) {
      const line = toLatin(raw).trim();
      if (!line || /^(date|تاریخ)/i.test(line)) continue;
      const [dateRaw, curRaw, rateRaw] = line.split(/[,;\t]/).map((x) => x.trim());
      const n = i + 1;
      if (!dateRaw || !curRaw || !rateRaw) { errors.push({ line: n, messageFa: 'سه ستون لازم است: تاریخ، ارز، نرخ' }); continue; }
      let date: Date | null = null;
      const j = dateRaw.match(/^(1[34]\d\d)[/\-.](\d{1,2})[/\-.](\d{1,2})$/);
      if (j) { const d = jalaliToDate(+j[1]!, +j[2]!, +j[3]!); date = d ? dayKey(d) : null; }
      else if (/^20\d\d-\d{2}-\d{2}$/.test(dateRaw)) date = new Date(`${dateRaw}T00:00:00Z`);
      if (!date || Number.isNaN(date.getTime())) { errors.push({ line: n, messageFa: `تاریخ «${dateRaw}» خوانده نشد` }); continue; }
      const currency = curRaw.toUpperCase();
      if (!(CURRENCIES as readonly string[]).includes(currency) || currency === base) { errors.push({ line: n, messageFa: `ارز «${curRaw}» پشتیبانی نمی‌شود` }); continue; }
      const rate = Number(rateRaw.replace(/[٬,\s]/g, ''));
      if (!Number.isFinite(rate) || rate <= 0) { errors.push({ line: n, messageFa: `نرخ «${rateRaw}» عدد مثبت نیست` }); continue; }

      const existing = await prisma.exchangeRate.findUnique({ where: { organizationId_currency_effectiveDate: { organizationId: actor.organizationId, currency, effectiveDate: date } } });
      if (existing) {
        if (D(existing.rate).equals(rate)) unchanged++;
        else conflicts.push({ line: n, currency, effectiveDate: date, existing: existing.rate, proposed: rate });
        continue;
      }
      await prisma.exchangeRate.create({ data: { organizationId: actor.organizationId, currency, rate, effectiveDate: date, source: 'IMPORT', createdById: actor.id } });
      created++;
    }
    await audit({
      organizationId: actor.organizationId, actorId: actor.id, action: 'BULK_IMPORT', entityType: 'exchangeRate',
      after: { created, unchanged, conflicts: conflicts.length, errors: errors.length },
      ipAddress: actor.ipAddress, requestId: actor.requestId,
    });
    return { created, unchanged, conflicts, errors };
  });

  app.get('/reports/fx', { preHandler: [app.authenticate, app.requirePermissions('finance.read')] }, async (req) => {
    const actor = actorFrom(req);
    const { from, to } = req.query as { from?: string; to?: string };
    return fxReport(prisma, actor.organizationId, { from: from ? new Date(from) : null, to: to ? new Date(to) : null });
  });
};

/** Figures converted at a given day's rate — they keep it when the rate is corrected. */
async function countConvertedAt(organizationId: string, currency: string, day: Date): Promise<number> {
  const where = { organizationId, fxRateDate: day };
  const [i, p, c, k, a] = await Promise.all([
    prisma.invoice.count({ where: { ...where, currency } }),
    prisma.payment.count({ where: { ...where, currency } }),
    prisma.costDeclaration.count({ where: { ...where, externalCurrency: currency } }),
    prisma.contract.count({ where: { ...where, currency } }),
    prisma.amendment.count({ where: { fxRateDate: day, contract: { organizationId, currency } } }),
  ]);
  return i + p + c + k + a;
}

export default fxRoutes;
