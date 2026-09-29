import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { DEPARTMENT_CODES, ONBOARDING_IMPORTS, activateAccountSchema, unitMapSchema, type OnboardingImport } from '@hiva/contracts';
import { prisma } from '../db.js';
import { actorFrom, parse } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { toCsv } from '../forms/bulk.js';
import { COLUMNS, commit, mapHeader, plan } from '../onboarding/importers.js';
import { SheetError, readTable } from '../onboarding/sheet.js';
import { nameKey, resolveUnit, suggestUnit, unitMapOf } from '../onboarding/units.js';
import { CONFIRMED_STEPS, onboardingStatus, type Step } from '../onboarding/status.js';
import { PENDING_PREFIX, activate, createActivation, describeActivation, sendActivation } from '../onboarding/activation.js';

const PUBLIC_LIMIT = { rateLimit: { max: 20, timeWindow: '1 minute' } };
const kindOf = (req: FastifyRequest): OnboardingImport => {
  const { kind } = req.params as { kind: string };
  if (!(ONBOARDING_IMPORTS as readonly string[]).includes(kind)) throw notFound('نوع ورود');
  return kind as OnboardingImport;
};

async function tableOf(req: FastifyRequest) {
  const file = await (req as unknown as { file: () => Promise<{ toBuffer: () => Promise<Buffer> } | undefined> }).file();
  if (!file) throw badRequest('NO_FILE', 'فایلی فرستاده نشده است.');
  try {
    const table = readTable(await file.toBuffer());
    if (table.length < 2) throw badRequest('EMPTY_FILE', 'فایل جز سرستون، ردیفی ندارد.');
    return table;
  } catch (e) {
    if (e instanceof SheetError) throw new AppError(422, 'SHEET_UNREADABLE', e.message);
    throw e;
  }
}

async function saveSetting(organizationId: string, key: string, value: unknown) {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { settings: true } });
  const settings = { ...((org.settings as Record<string, unknown> | null) ?? {}), [key]: value };
  await prisma.organization.update({ where: { id: organizationId }, data: { settings: settings as object } });
}

/**
 * Getting an organisation started (roadmap #48): the checklist, its imports, the unit map, and
 * first passwords for the people brought in. Administration throughout — `admin.users` for people,
 * `admin.settings` for the rest — except the two public calls a new person uses to set a password.
 */
const onboardingRoutes: FastifyPluginAsync = async (app) => {
  const settings = { preHandler: [app.authenticate, app.requirePermissions('admin.settings')] };
  const people = { preHandler: [app.authenticate, app.requirePermissions('admin.users')] };
  /** People are imported under `admin.users`; everything else under `admin.settings`. */
  const byKind = { preHandler: [app.authenticate, async (req: FastifyRequest) => app.requirePermissions(kindOf(req) === 'users' ? 'admin.users' : 'admin.settings')(req)] };

  app.get('/onboarding', settings, async (req) => onboardingStatus(prisma, actorFrom(req).organizationId));

  app.get('/onboarding/columns/:kind', settings, async (req) => COLUMNS[kindOf(req)]);

  /** A header row in Persian, ready to fill in Excel. */
  app.get('/onboarding/templates/:kind', settings, async (req, reply) => {
    const kind = kindOf(req);
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="hiva-${kind}.csv"`)
      .send(toCsv([COLUMNS[kind].map((c) => c.labelFa)]));
  });

  app.post('/onboarding/import/:kind/preview', byKind, async (req) => {
    const actor = actorFrom(req);
    const { preview } = await plan(prisma, actor, kindOf(req), await tableOf(req));
    return preview;
  });

  app.post('/onboarding/import/:kind/commit', byKind, async (req) => {
    const actor = actorFrom(req);
    const kind = kindOf(req);
    const table = await tableOf(req);
    const header = mapHeader(kind, table[0] ?? []);
    if (header.missing.length) throw new AppError(422, 'COLUMNS_MISSING', `این ستون‌ها در فایل نیست: ${header.missing.join('، ')}`, { missing: header.missing });
    return commit(actor, kind, table);
  });

  /* ── the unit map ──────────────────────────────────────────────────────────────────────── */

  app.get('/onboarding/units', settings, async (req) => {
    const actor = actorFrom(req);
    const departments = await prisma.department.findMany({ where: { organizationId: actor.organizationId }, orderBy: { sortOrder: 'asc' }, select: { code: true, nameFa: true } });
    return { departments, map: await unitMapOf(prisma, actor.organizationId) };
  });

  /** The unit names a users file uses, each with how it resolves now and a suggestion. */
  app.post('/onboarding/units/scan', settings, async (req) => {
    const actor = actorFrom(req);
    const table = await tableOf(req);
    const header = mapHeader('users', table[0] ?? []);
    if (header.index.unit === undefined) throw new AppError(422, 'COLUMNS_MISSING', 'ستون «واحد» در فایل نیست.');
    const departments = await prisma.department.findMany({ where: { organizationId: actor.organizationId }, select: { code: true, nameFa: true } });
    const map = await unitMapOf(prisma, actor.organizationId);
    const counts = new Map<string, { name: string; people: number }>();
    for (const row of table.slice(1)) {
      const name = (row[header.index.unit] ?? '').trim();
      if (!name) continue;
      const k = nameKey(name);
      counts.set(k, { name: counts.get(k)?.name ?? name, people: (counts.get(k)?.people ?? 0) + 1 });
    }
    return [...counts.values()].map(({ name, people }) => ({ name, people, resolved: resolveUnit(name, map, departments), suggestion: suggestUnit(name) }));
  });

  app.put('/onboarding/units', settings, async (req) => {
    const actor = actorFrom(req);
    const { map } = parse(unitMapSchema, req.body);
    const before = await unitMapOf(prisma, actor.organizationId);
    await saveSetting(actor.organizationId, 'unitMap', map);
    await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE', entityType: 'organization', entityId: actor.organizationId, before: { unitMap: before }, after: { unitMap: map }, reason: 'onboarding: unit map', ipAddress: actor.ipAddress, requestId: actor.requestId });
    return { map, codes: DEPARTMENT_CODES };
  });

  /** The steps that are a judgement — units mapped, calendar right, SLA hours right — are confirmed by someone. */
  app.post('/onboarding/confirm/:step', settings, async (req) => {
    const actor = actorFrom(req);
    const { step } = req.params as { step: string };
    if (!CONFIRMED_STEPS.includes(step as Step)) throw badRequest('UNKNOWN_STEP', 'این گام تأییدکردنی نیست.');
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: actor.organizationId }, select: { settings: true } });
    const onboarding = { ...(((org.settings as { onboarding?: Record<string, unknown> } | null)?.onboarding) ?? {}), [step]: { at: new Date().toISOString(), by: actor.id } };
    await saveSetting(actor.organizationId, 'onboarding', onboarding);
    await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE', entityType: 'organization', entityId: actor.organizationId, after: { onboarding: { [step]: 'confirmed' } }, reason: `onboarding: ${step} confirmed`, ipAddress: actor.ipAddress, requestId: actor.requestId });
    return onboardingStatus(prisma, actor.organizationId);
  });

  /* ── first passwords ───────────────────────────────────────────────────────────────────── */

  /** Imported people who have not yet set a password. */
  app.get('/onboarding/activations', people, async (req) => {
    const actor = actorFrom(req);
    const users = await prisma.user.findMany({
      where: { organizationId: actor.organizationId, isActive: true, deletedAt: null, passwordHash: { startsWith: PENDING_PREFIX } },
      select: { id: true, email: true, fullName: true, department: { select: { code: true, nameFa: true } }, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    const open = await prisma.accountActivation.findMany({ where: { userId: { in: users.map((u) => u.id) }, usedAt: null, revokedAt: null }, select: { userId: true, expiresAt: true } });
    return users.map((u) => ({ ...u, linkExpiresAt: open.find((o) => o.userId === u.id)?.expiresAt ?? null }));
  });

  /** A fresh link for one person — the old one stops working. Shown only if it was not emailed. */
  app.post('/users/:id/activation', people, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const user = await prisma.user.findFirst({ where: { id, organizationId: actor.organizationId, isActive: true, deletedAt: null }, select: { id: true, email: true } });
    if (!user) throw notFound('کاربر');
    const activation = await prisma.$transaction((tx) => createActivation(tx, user.id, actor.id));
    await sendActivation(activation);
    await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE', entityType: 'user', entityId: user.id, after: { activation: 'issued', emailed: activation.emailed, expiresAt: activation.expiresAt }, ipAddress: actor.ipAddress, requestId: actor.requestId });
    return { email: user.email, emailed: activation.emailed, expiresAt: activation.expiresAt, url: activation.emailed ? null : activation.url };
  });

  app.get('/auth/activation/:token', { config: PUBLIC_LIMIT }, async (req) => describeActivation((req.params as { token: string }).token));

  app.post('/auth/activation/:token', { config: PUBLIC_LIMIT }, async (req) => {
    const { password } = parse(activateAccountSchema, req.body);
    return activate((req.params as { token: string }).token, password, { ipAddress: req.ip });
  });
};

export default onboardingRoutes;
