import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  idSchema, nameKey, phoneKey, savedViewSchema, siteOptionSchema, siteOptionUpdateSchema, siteSettingsSchema,
  venueChannelSchema, venueContactSchema, venueDuplicateDecisionSchema, venueListSchema, venueSchema, venueSmsSchema, venueUpdateSchema,
} from '@hiva/contracts';
import { prisma } from '../db.js';
import { actorFrom, orderBy, page, parse } from '../lib/http.js';
import { conflict, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { money } from '../lib/money.js';
import { anyOf, overridesRules } from '../sites/access.js';
import { optionsOf, settingsOf } from '../sites/options.js';
import {
  addContact, assertNotDuplicate, assertRequired, assertVenueOptions, completenessOf, createVenue, findDuplicates,
} from '../sites/venues.js';
import { sendVenueMessages } from '../sites/messages.js';

/**
 * The venue database (ADR-103, module A): venues, their people and channels, duplicates, the
 * organisation's lists and settings for the module, texts to the venues, and saved list views.
 */

const LIVE_STATES = ['CONTRACT_APPROVED', 'INSTALL_PLANNED', 'INSTALLING', 'ACTIVE', 'SETTLING', 'CLOSURE_PENDING'];
const versionConflict = () => conflict('VERSION_CONFLICT', 'این رکورد را همکار دیگری هم‌زمان تغییر داده است؛ صفحه را تازه کنید و دوباره ثبت کنید.');
const reasonSchema = z.object({ reason: z.string().trim().min(3).max(500) });
const contactUpdateSchema = venueContactSchema.omit({ channels: true }).partial();
const checkSchema = venueSchema.pick({ name: true, city: true, phone: true, address: true }).extend({ excludeId: idSchema.optional(), contactPhones: z.array(z.string().max(40)).max(30).default([]) });

const venueRoutes: FastifyPluginAsync = async (app) => {
  const read = { preHandler: [app.authenticate, app.requirePermissions('venue.read')] };
  const write = { preHandler: [app.authenticate, app.requirePermissions('venue.write')] };
  const manage = { preHandler: [app.authenticate, app.requirePermissions('venue.manage')] };
  const configure = { preHandler: [app.authenticate, app.requirePermissions('site.configure')] };
  const anyModule = { preHandler: [app.authenticate, anyOf('venue.read', 'site.read', 'rental.read', 'site.configure')] };

  /* ── the organisation's lists and settings ───────────────────────────── */

  app.get('/site-options', anyModule, async (req) => optionsOf(actorFrom(req).organizationId));

  app.post('/site-options', configure, async (req, reply) => {
    const actor = actorFrom(req);
    const input = parse(siteOptionSchema, req.body);
    await optionsOf(actor.organizationId);
    const made = await prisma.$transaction(async (tx) => {
      if (await tx.siteOption.count({ where: { organizationId: actor.organizationId, list: input.list, code: input.code } })) {
        throw conflict('DUPLICATE_CODE', `کد «${input.code}» در این فهرست هست؛ گزینهٔ کنارگذاشته را دوباره فعال کنید.`);
      }
      const row = await tx.siteOption.create({ data: { ...input, labelEn: input.labelEn ?? null, organizationId: actor.organizationId } });
      await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'CONFIG_CHANGED', entityType: 'siteOption', entityId: row.id, after: row, ipAddress: actor.ipAddress, requestId: actor.requestId }, tx);
      return row;
    });
    return reply.code(201).send(made);
  });

  /** An option is renamed, reordered or retired — never deleted, and never re-coded. */
  app.patch('/site-options/:id', configure, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(siteOptionUpdateSchema, req.body);
    return prisma.$transaction(async (tx) => {
      const before = await tx.siteOption.findFirst({ where: { id, organizationId: actor.organizationId } });
      if (!before) throw notFound('گزینه');
      const after = await tx.siteOption.update({ where: { id }, data: { ...input, meta: input.meta ? { ...(before.meta as object), ...input.meta } : undefined } });
      await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'CONFIG_CHANGED', entityType: 'siteOption', entityId: id, before, after, ipAddress: actor.ipAddress, requestId: actor.requestId }, tx);
      return after;
    });
  });

  app.get('/site-settings', anyModule, async (req) => settingsOf(actorFrom(req).organizationId));

  app.put('/site-settings', configure, async (req) => {
    const actor = actorFrom(req);
    const settings = parse(siteSettingsSchema, req.body);
    return prisma.$transaction(async (tx) => {
      const before = await tx.siteSettings.findUnique({ where: { organizationId: actor.organizationId } });
      // Only colleagues of this organisation are reminded.
      if (settings.reminders.userIds.length) {
        const known = await tx.user.count({ where: { organizationId: actor.organizationId, id: { in: settings.reminders.userIds }, deletedAt: null } });
        if (known !== new Set(settings.reminders.userIds).size) throw conflict('UNKNOWN_REFERENCE', 'یکی از همکارانی که یادآوری می‌گیرند در این سازمان نیست.');
      }
      const row = await tx.siteSettings.upsert({
        where: { organizationId: actor.organizationId },
        create: { organizationId: actor.organizationId, settings: settings as Prisma.InputJsonValue, updatedById: actor.id },
        update: { settings: settings as Prisma.InputJsonValue, updatedById: actor.id },
      });
      await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'CONFIG_CHANGED', entityType: 'siteSettings', entityId: actor.organizationId, before: before?.settings, after: row.settings, ipAddress: actor.ipAddress, requestId: actor.requestId }, tx);
      return settings;
    });
  });

  /* ── venues ──────────────────────────────────────────────────────────── */

  /** The provinces and cities venues are in — the filters' choices. */
  app.get('/venues/facets', read, async (req) => {
    const actor = actorFrom(req);
    const rows = await prisma.venue.groupBy({ by: ['province', 'city'], where: { organizationId: actor.organizationId, mergedIntoId: null }, _count: { _all: true }, orderBy: [{ province: 'asc' }, { city: 'asc' }] });
    return { places: rows.map((r) => ({ province: r.province, city: r.city, n: r._count._all })) };
  });

  app.get('/venues', read, async (req) => {
    const actor = actorFrom(req);
    const q = parse(venueListSchema, req.query);
    const where: Prisma.VenueWhereInput = {
      organizationId: actor.organizationId, mergedIntoId: null,
      ...(q.status === 'active' ? { isActive: true, archivedAt: null } : q.status === 'inactive' ? { isActive: false, archivedAt: null } : q.status === 'archived' ? { archivedAt: { not: null } } : {}),
      ...(q.province ? { province: q.province } : {}), ...(q.city ? { city: q.city } : {}),
      ...(q.typeCode ? { typeCode: q.typeCode } : {}), ...(q.gradeCode ? { gradeCode: q.gradeCode } : {}),
      ...(q.audience ? { audienceCodes: { has: q.audience } } : {}),
      ...(q.withoutActiveProject === 'true' ? { siteProjects: { none: { state: { in: LIVE_STATES } } } } : {}),
      AND: [
        ...(q.q ? [{ OR: [
          { name: { contains: q.q, mode: 'insensitive' as const } }, { nameKey: { contains: nameKey(q.q) } }, { code: { contains: q.q, mode: 'insensitive' as const } },
          { city: { contains: q.q, mode: 'insensitive' as const } }, { address: { contains: q.q, mode: 'insensitive' as const } },
          ...(phoneKey(q.q) ? [{ phoneKey: { contains: phoneKey(q.q)! } }, { contacts: { some: { phoneKey: { contains: phoneKey(q.q)! } } } }] : []),
          { contacts: { some: { fullName: { contains: q.q, mode: 'insensitive' as const }, archivedAt: null } } },
        ] }] : []),
        ...(q.incomplete === 'true' ? [{ OR: [
          { address: null }, { phone: null }, { gradeCode: null }, { audienceCodes: { isEmpty: true } },
          { contacts: { none: { archivedAt: null } } }, { documents: { none: { deletedAt: null, supersededAt: null, mimeType: { startsWith: 'image/' } } } },
        ] }] : []),
      ],
    };
    const [rows, total] = await Promise.all([
      prisma.venue.findMany({
        where, orderBy: orderBy(q.sort, q.order, ['name', 'city', 'province', 'code', 'createdAt', 'updatedAt'], 'updatedAt'),
        skip: (q.page - 1) * q.pageSize, take: q.pageSize,
        include: {
          _count: { select: { contacts: { where: { archivedAt: null } }, siteProjects: true, documents: { where: { deletedAt: null, supersededAt: null, mimeType: { startsWith: 'image/' } } } } },
          contacts: { where: { archivedAt: null, isPrimary: true }, select: { fullName: true, phone: true, roleCode: true }, take: 1 },
        },
      }),
      prisma.venue.count({ where }),
    ]);
    const live = await prisma.siteProject.groupBy({ by: ['venueId'], where: { organizationId: actor.organizationId, venueId: { in: rows.map((r) => r.id) }, state: { in: LIVE_STATES } }, _count: { _all: true } });
    return page(rows.map(({ _count, contacts, ...v }) => ({
      ...v, primaryContact: contacts[0] ?? null, contacts: _count.contacts, photos: _count.documents, projects: _count.siteProjects,
      activeProjects: live.find((l) => l.venueId === v.id)?._count._all ?? 0,
      completeness: completenessOf(v, _count.contacts, _count.documents),
    })), total, q);
  });

  /** Venues that look like the one being written — asked before it is saved. */
  app.post('/venues/duplicates', read, async (req) => {
    const actor = actorFrom(req);
    const q = parse(checkSchema, req.body);
    return { candidates: await findDuplicates(actor.organizationId, q, await settingsOf(actor.organizationId), q.excludeId) };
  });

  app.post('/venues', write, async (req, reply) => {
    const actor = actorFrom(req);
    const input = parse(venueSchema, req.body);
    const settings = await settingsOf(actor.organizationId);
    assertRequired(settings, input);
    await assertVenueOptions(actor.organizationId, input);
    assertNotDuplicate(await findDuplicates(actor.organizationId, { ...input, contactPhones: input.contacts?.map((c) => c.phone) }, settings), input.confirmNotDuplicate);
    const venue = await prisma.$transaction((tx) => createVenue(tx, actor, input));
    return reply.code(201).send(venue);
  });

  app.get('/venues/:id', read, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const venue = await prisma.venue.findFirst({
      where: { id, organizationId: actor.organizationId },
      include: {
        createdBy: { select: { id: true, fullName: true } },
        contacts: { where: { archivedAt: null }, orderBy: [{ isPrimary: 'desc' }, { fullName: 'asc' }], include: { channels: { orderBy: { createdAt: 'asc' } } } },
        channels: { where: { contactId: null }, orderBy: { createdAt: 'asc' } },
        documents: { where: { deletedAt: null, supersededAt: null }, orderBy: [{ category: 'asc' }, { createdAt: 'desc' }], select: { id: true, fileName: true, mimeType: true, sizeBytes: true, category: true, caption: true, takenAt: true, createdAt: true, uploadedBy: { select: { fullName: true } } } },
        siteProjects: { orderBy: { createdAt: 'desc' }, select: { id: true, code: true, name: true, state: true, placement: true, contractStart: true, contractEnd: true, cooperationCode: true, responsible: { select: { id: true, fullName: true } } } },
      },
    });
    if (!venue) throw notFound('مکان');
    const settings = await settingsOf(actor.organizationId);
    const [duplicates, mergedFrom, messages, owed] = await Promise.all([
      venue.mergedIntoId || venue.archivedAt ? [] : findDuplicates(actor.organizationId, { ...venue, contactPhones: venue.contacts.map((c) => c.phone) }, settings, venue.id),
      prisma.venue.findMany({ where: { organizationId: actor.organizationId, mergedIntoId: venue.id }, select: { id: true, code: true, name: true } }),
      actor.permissions.includes('venue.sms') ? prisma.venueMessage.findMany({ where: { organizationId: actor.organizationId, venueId: id }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, phone: true, text: true, status: true, error: true, createdAt: true, sentBy: { select: { fullName: true } } } }) : null,
      // What is owed on each of its projects, for whoever may read the rentals.
      actor.permissions.includes('rental.read')
        ? prisma.siteObligation.groupBy({ by: ['siteProjectId', 'currency'], where: { organizationId: actor.organizationId, siteProject: { venueId: id }, status: { in: ['OPEN', 'PARTIAL'] } }, _sum: { amount: true, settledAmount: true } })
        : null,
    ]);
    const merged = venue.mergedIntoId ? await prisma.venue.findFirst({ where: { id: venue.mergedIntoId, organizationId: actor.organizationId }, select: { id: true, code: true, name: true } }) : null;
    const photos = venue.documents.filter((d) => d.mimeType.startsWith('image/')).length;
    return {
      ...venue, duplicates, mergedFrom, mergedInto: merged, messages,
      completeness: completenessOf(venue, venue.contacts.length, photos),
      outstanding: owed?.map((m) => ({ siteProjectId: m.siteProjectId, currency: m.currency, amount: money(m._sum.amount).sub(money(m._sum.settledAmount)).toFixed(2) })) ?? null,
    };
  });

  app.patch('/venues/:id', write, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(venueUpdateSchema, req.body);
    const settings = await settingsOf(actor.organizationId);
    const before = await prisma.venue.findFirst({ where: { id, organizationId: actor.organizationId, mergedIntoId: null }, include: { contacts: { where: { archivedAt: null }, select: { phone: true } } } });
    if (!before) throw notFound('مکان');
    if (input.version && input.version !== before.version) throw versionConflict();
    const next = { ...before, ...input };
    assertRequired(settings, next);
    await assertVenueOptions(actor.organizationId, input, before);
    if (['name', 'city', 'phone', 'address'].some((k) => k in input && (input as Record<string, unknown>)[k] !== (before as Record<string, unknown>)[k])) {
      assertNotDuplicate(await findDuplicates(actor.organizationId, { ...next, contactPhones: before.contacts.map((c) => c.phone) }, settings, id), input.confirmNotDuplicate ?? false);
    }
    const { version: _v, confirmNotDuplicate: _c, ...fields } = input;
    return prisma.$transaction(async (tx) => {
      const r = await tx.venue.updateMany({
        where: { id, version: before.version },
        data: { ...fields, ...(fields.name ? { nameKey: nameKey(fields.name) } : {}), ...('phone' in fields ? { phoneKey: phoneKey(fields.phone) } : {}), updatedById: actor.id, version: { increment: 1 } },
      });
      if (r.count !== 1) throw versionConflict();
      const after = await tx.venue.findUniqueOrThrow({ where: { id } });
      await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE', entityType: 'venue', entityId: id, before, after, ipAddress: actor.ipAddress, requestId: actor.requestId }, tx);
      return after;
    });
  });

  /** Archived: out of the lists, its history kept. A venue with a live project is not archived. */
  app.post('/venues/:id/archive', manage, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const { reason } = parse(reasonSchema, req.body);
    return prisma.$transaction(async (tx) => {
      const before = await tx.venue.findFirst({ where: { id, organizationId: actor.organizationId, archivedAt: null } });
      if (!before) throw notFound('مکان');
      const live = await tx.siteProject.count({ where: { venueId: id, state: { notIn: ['DRAFT', 'CLOSED', 'CANCELLED'] } } });
      if (live && !overridesRules(actor)) throw conflict('VENUE_IN_USE', `${live} پروژهٔ جاری در این مکان است؛ پیش از بایگانی آن‌ها را ببندید یا لغو کنید.`);
      const after = await tx.venue.update({ where: { id }, data: { archivedAt: new Date(), isActive: false, updatedById: actor.id, version: { increment: 1 } } });
      await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'ARCHIVE', entityType: 'venue', entityId: id, before, after, reason, ipAddress: actor.ipAddress, requestId: actor.requestId }, tx);
      return after;
    });
  });

  app.post('/venues/:id/restore', manage, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    return prisma.$transaction(async (tx) => {
      const before = await tx.venue.findFirst({ where: { id, organizationId: actor.organizationId, archivedAt: { not: null }, mergedIntoId: null } });
      if (!before) throw notFound('مکان بایگانی‌شده');
      const after = await tx.venue.update({ where: { id }, data: { archivedAt: null, isActive: true, updatedById: actor.id, version: { increment: 1 } } });
      await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'RESTORE', entityType: 'venue', entityId: id, before, after, ipAddress: actor.ipAddress, requestId: actor.requestId }, tx);
      return after;
    });
  });

  /**
   * Two venues that look alike, settled by someone who may: one place (MERGE — the other's people,
   * channels, photos, projects and messages come here, and it is archived pointing at this one) or two
   * (DISTINCT — neither is offered as the other's duplicate again).
   */
  app.post('/venues/:id/duplicates/decision', manage, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(venueDuplicateDecisionSchema, req.body);
    if (input.otherId === id) throw conflict('VALIDATION_ERROR', 'یک مکان تکراری خودش نیست.');
    return prisma.$transaction(async (tx) => {
      const [keep, other] = await Promise.all([
        tx.venue.findFirst({ where: { id, organizationId: actor.organizationId, mergedIntoId: null } }),
        tx.venue.findFirst({ where: { id: input.otherId, organizationId: actor.organizationId, mergedIntoId: null } }),
      ]);
      if (!keep || !other) throw notFound('مکان');
      if (input.decision === 'DISTINCT') {
        await tx.venue.update({ where: { id: keep.id }, data: { distinctFrom: { set: [...new Set([...keep.distinctFrom, other.id])] } } });
        await tx.venue.update({ where: { id: other.id }, data: { distinctFrom: { set: [...new Set([...other.distinctFrom, keep.id])] } } });
        await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'DUPLICATE_DISMISSED', entityType: 'venue', entityId: keep.id, after: { distinctFrom: other.id }, reason: input.reason, ipAddress: actor.ipAddress, requestId: actor.requestId }, tx);
        return { decision: 'DISTINCT' };
      }
      const moved = {
        contacts: (await tx.venueContact.updateMany({ where: { venueId: other.id }, data: { venueId: keep.id, isPrimary: false } })).count,
        channels: (await tx.venueChannel.updateMany({ where: { venueId: other.id }, data: { venueId: keep.id } })).count,
        projects: (await tx.siteProject.updateMany({ where: { venueId: other.id }, data: { venueId: keep.id } })).count,
        documents: (await tx.document.updateMany({ where: { venueId: other.id }, data: { venueId: keep.id } })).count,
        messages: (await tx.venueMessage.updateMany({ where: { venueId: other.id }, data: { venueId: keep.id } })).count,
      };
      await tx.venue.update({ where: { id: other.id }, data: { mergedIntoId: keep.id, archivedAt: new Date(), isActive: false, updatedById: actor.id, version: { increment: 1 } } });
      await tx.venue.update({
        where: { id: keep.id },
        data: {
          // What the kept record lacks, the merged one gives; nothing it has is overwritten.
          address: keep.address ?? other.address, phone: keep.phone ?? other.phone, phoneKey: keep.phoneKey ?? other.phoneKey,
          email: keep.email ?? other.email, website: keep.website ?? other.website, gradeCode: keep.gradeCode ?? other.gradeCode,
          audienceCodes: [...new Set([...keep.audienceCodes, ...other.audienceCodes])],
          notes: [keep.notes, other.notes && `(از ${other.code}) ${other.notes}`].filter(Boolean).join('\n') || null,
          updatedById: actor.id, version: { increment: 1 },
        },
      });
      await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'VENUE_MERGED', entityType: 'venue', entityId: keep.id, before: { kept: keep, merged: other }, after: { mergedId: other.id, mergedCode: other.code, moved }, reason: input.reason, ipAddress: actor.ipAddress, requestId: actor.requestId }, tx);
      return { decision: 'MERGE', moved };
    });
  });

  /* ── contacts and channels ───────────────────────────────────────────── */

  app.post('/venues/:id/contacts', write, async (req, reply) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(venueContactSchema, req.body);
    await assertVenueOptions(actor.organizationId, { contacts: [input] });
    const made = await prisma.$transaction(async (tx) => {
      const venue = await tx.venue.findFirst({ where: { id, organizationId: actor.organizationId, mergedIntoId: null }, select: { id: true } });
      if (!venue) throw notFound('مکان');
      const c = await addContact(tx, actor.organizationId, id, input);
      await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'CREATE', entityType: 'venueContact', entityId: c.id, after: c, ipAddress: actor.ipAddress, requestId: actor.requestId }, tx);
      return c;
    });
    return reply.code(201).send(made);
  });

  app.patch('/venue-contacts/:id', write, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(contactUpdateSchema, req.body);
    if (input.roleCode) await assertVenueOptions(actor.organizationId, { contacts: [{ ...input, roleCode: input.roleCode, fullName: 'x', isPrimary: false, channels: [] }] });
    return prisma.$transaction(async (tx) => {
      const before = await tx.venueContact.findFirst({ where: { id, organizationId: actor.organizationId, archivedAt: null } });
      if (!before) throw notFound('مخاطب');
      if (input.isPrimary) await tx.venueContact.updateMany({ where: { venueId: before.venueId, isPrimary: true, id: { not: id } }, data: { isPrimary: false } });
      const after = await tx.venueContact.update({ where: { id }, data: { ...input, ...('phone' in input ? { phoneKey: phoneKey(input.phone) } : {}) } });
      await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'UPDATE', entityType: 'venueContact', entityId: id, before, after, ipAddress: actor.ipAddress, requestId: actor.requestId }, tx);
      return after;
    });
  });

  /** A contact who left is archived: gone from the venue's page, still named where they took part. */
  app.post('/venue-contacts/:id/archive', write, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    return prisma.$transaction(async (tx) => {
      const before = await tx.venueContact.findFirst({ where: { id, organizationId: actor.organizationId, archivedAt: null } });
      if (!before) throw notFound('مخاطب');
      const after = await tx.venueContact.update({ where: { id }, data: { archivedAt: new Date(), isPrimary: false } });
      await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'ARCHIVE', entityType: 'venueContact', entityId: id, before, after, ipAddress: actor.ipAddress, requestId: actor.requestId }, tx);
      return after;
    });
  });

  app.post('/venues/:id/channels', write, async (req, reply) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const input = parse(venueChannelSchema.extend({ contactId: idSchema.optional().nullable() }), req.body);
    await assertVenueOptions(actor.organizationId, { channels: [input] });
    const made = await prisma.$transaction(async (tx) => {
      const venue = await tx.venue.findFirst({ where: { id, organizationId: actor.organizationId, mergedIntoId: null }, select: { id: true } });
      if (!venue) throw notFound('مکان');
      if (input.contactId && !(await tx.venueContact.count({ where: { id: input.contactId, venueId: id, archivedAt: null } }))) throw notFound('مخاطب');
      const row = await tx.venueChannel.create({ data: { organizationId: actor.organizationId, venueId: id, contactId: input.contactId ?? null, typeCode: input.typeCode, value: input.value, note: input.note ?? null } });
      await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'CREATE', entityType: 'venueChannel', entityId: row.id, after: row, ipAddress: actor.ipAddress, requestId: actor.requestId }, tx);
      return row;
    });
    return reply.code(201).send(made);
  });

  app.delete('/venue-channels/:id', write, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    return prisma.$transaction(async (tx) => {
      const before = await tx.venueChannel.findFirst({ where: { id, organizationId: actor.organizationId } });
      if (!before) throw notFound('راه ارتباطی');
      await tx.venueChannel.delete({ where: { id } });
      await audit({ organizationId: actor.organizationId, actorId: actor.id, action: 'DELETE', entityType: 'venueChannel', entityId: id, before, ipAddress: actor.ipAddress, requestId: actor.requestId }, tx);
      return { deleted: true };
    });
  });

  /* ── texts to the venues ─────────────────────────────────────────────── */

  app.post('/venue-messages', { preHandler: [app.authenticate, app.requirePermissions('venue.sms'), app.requirePermissions('venue.read')] }, async (req) => {
    const actor = actorFrom(req);
    const input = parse(venueSmsSchema, req.body);
    return sendVenueMessages(actor, input);
  });

  app.get('/venue-messages', { preHandler: [app.authenticate, app.requirePermissions('venue.sms')] }, async (req) => {
    const actor = actorFrom(req);
    const q = parse(z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25), status: z.string().max(20).optional(), venueId: idSchema.optional() }), req.query);
    const where: Prisma.VenueMessageWhereInput = { organizationId: actor.organizationId, ...(q.status ? { status: q.status } : {}), ...(q.venueId ? { venueId: q.venueId } : {}) };
    const [items, total] = await Promise.all([
      prisma.venueMessage.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { venue: { select: { id: true, name: true } }, contact: { select: { fullName: true } }, sentBy: { select: { fullName: true } } } }),
      prisma.venueMessage.count({ where }),
    ]);
    return page(items, total, q);
  });

  /* ── saved views ─────────────────────────────────────────────────────── */

  app.get('/site-saved-views', anyModule, async (req) => {
    const actor = actorFrom(req);
    return prisma.siteSavedView.findMany({ where: { organizationId: actor.organizationId, OR: [{ userId: actor.id }, { shared: true }] }, orderBy: { name: 'asc' }, take: 200, include: { user: { select: { fullName: true } } } });
  });

  app.post('/site-saved-views', anyModule, async (req, reply) => {
    const actor = actorFrom(req);
    const input = parse(savedViewSchema, req.body);
    const row = await prisma.siteSavedView.create({ data: { ...input, organizationId: actor.organizationId, userId: actor.id } });
    return reply.code(201).send(row);
  });

  app.delete('/site-saved-views/:id', anyModule, async (req) => {
    const actor = actorFrom(req);
    const { id } = req.params as { id: string };
    const r = await prisma.siteSavedView.deleteMany({ where: { id, organizationId: actor.organizationId, userId: actor.id } });
    if (!r.count) throw notFound('نمای ذخیره‌شده');
    return { deleted: true };
  });
};

export default venueRoutes;
