import { prisma } from '../db.js';
import { schemaForSubmission } from '../forms/versions.js';
import type { AccessTokenClaims } from '../auth/tokens.js';
import { DOCUMENT_POLICIES, type DocumentKind } from './access.js';

/**
 * Attachment discovery.
 *
 * A form or record rarely stands alone: Doc_H forms carry 145 entityRef links between them and 76
 * of them accept file uploads. This resolves what may legitimately travel with a document so the
 * user can assemble one complete dossier.
 *
 * Access order: an item the caller may not export is OMITTED, not returned as "locked". Listing a
 * contract a Sales user cannot read would leak its existence, which is itself part of what the
 * permission model withholds.
 */

export interface AttachmentItem {
  /** 'record' renders through the PDF templates; 'file' is an uploaded document. */
  readonly type: 'record' | 'file';
  readonly kind?: DocumentKind;
  readonly id: string;
  readonly title: string;
  readonly code?: string | null;
  readonly mimeType?: string;
  readonly sizeBytes?: number;
  /** Embeddable into the merged PDF — PDFs and JPEG/PNG images only. */
  readonly embeddable?: boolean;
  /** Pre-ticked in the picker. */
  readonly defaultSelected: boolean;
}

export interface AttachmentGroup {
  readonly key: string;
  readonly titleFa: string;
  readonly items: AttachmentItem[];
}

const EMBEDDABLE_MIME = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/jpg']);

const canExport = (user: AccessTokenClaims, kind: DocumentKind): boolean =>
  DOCUMENT_POLICIES[kind].permissions.every((p) => user.permissions.includes(p));

const canReadFiles = (user: AccessTokenClaims): boolean => user.permissions.includes('document.read');

/** Uploaded files hanging off any of the given attachment points. */
async function filesFor(
  orgId: string,
  user: AccessTokenClaims,
  where: Record<string, string | undefined>,
): Promise<AttachmentItem[]> {
  if (!canReadFiles(user)) return [];
  const clauses = Object.entries(where)
    .filter(([, v]) => v)
    .map(([k, v]) => ({ [k]: v }));
  if (clauses.length === 0) return [];

  const docs = await prisma.document.findMany({
    where: { organizationId: orgId, deletedAt: null, supersededAt: null, OR: clauses },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  return docs.map((d) => ({
    type: 'file' as const,
    id: d.id,
    title: d.fileName,
    code: null,
    mimeType: d.mimeType,
    sizeBytes: d.sizeBytes,
    embeddable: EMBEDDABLE_MIME.has(d.mimeType),
    // Non-embeddable files are listed on the index page instead of being merged, so they
    // start unticked to keep the default bundle to things that actually appear inline.
    defaultSelected: EMBEDDABLE_MIME.has(d.mimeType),
  }));
}

const rec = (
  kind: DocumentKind,
  id: string,
  title: string,
  code?: string | null,
  defaultSelected = true,
): AttachmentItem => ({ type: 'record', kind, id, title, code, defaultSelected });

/** Drop groups whose items were all filtered away by permission. */
const compact = (groups: AttachmentGroup[]): AttachmentGroup[] =>
  groups.filter((g) => g.items.length > 0);

/** Keep only record items the caller is entitled to export. */
const allowed = (user: AccessTokenClaims, items: AttachmentItem[]): AttachmentItem[] =>
  items.filter((i) => i.type === 'file' || (i.kind && canExport(user, i.kind)));

export async function discoverAttachments(
  kind: DocumentKind,
  id: string,
  orgId: string,
  user: AccessTokenClaims,
): Promise<AttachmentGroup[]> {
  const groups: AttachmentGroup[] = [];
  const push = (key: string, titleFa: string, items: AttachmentItem[]) =>
    groups.push({ key, titleFa, items: allowed(user, items) });

  switch (kind) {
    case 'project':
    case 'closure-report': {
      const p = await prisma.project.findFirst({
        where: { id, organizationId: orgId },
        include: {
          brief: { select: { id: true, code: true, title: true } },
          proposal: { select: { id: true, code: true, title: true } },
          workOrders: { select: { id: true, code: true, title: true } },
          deliverables: { select: { id: true, code: true, name: true } },
          changeRequests: { select: { id: true, code: true, title: true } },
          contracts: { select: { id: true, code: true, contractNumber: true, title: true } },
          invoices: { select: { id: true, code: true, number: true, kind: true } },
          meetings: { select: { id: true, code: true, subject: true } },
          statusReports: { select: { id: true, code: true, period: true } },
        },
      });
      if (!p) return [];

      const [qc, revisions] = await Promise.all([
        prisma.qcReview.findMany({
          where: { organizationId: orgId, OR: [{ deliverable: { projectId: id } }, { workOrder: { projectId: id } }] },
          select: { id: true, code: true, level: true },
        }),
        prisma.revision.findMany({
          where: { organizationId: orgId, deliverable: { projectId: id } },
          select: { id: true, code: true, reason: true },
        }),
      ]);

      push('origin', 'اسناد منشأ', [
        ...(p.brief ? [rec('brief', p.brief.id, p.brief.title, p.brief.code)] : []),
        ...(p.proposal ? [rec('proposal', p.proposal.id, p.proposal.title, p.proposal.code)] : []),
      ]);
      push('commercial', 'قرارداد و مالی', [
        ...p.contracts.map((c) => rec('contract', c.id, c.title, c.contractNumber ?? c.code)),
        ...p.invoices.map((i) => rec('invoice', i.id, i.kind === 'PROFORMA' ? 'پیش‌فاکتور' : 'فاکتور', i.number)),
      ]);
      push('execution', 'اجرا', [
        ...p.workOrders.map((w) => rec('work-order', w.id, w.title, w.code)),
        ...p.deliverables.map((d) => rec('deliverable', d.id, d.name, d.code)),
      ]);
      push('quality', 'کیفیت و تغییرات', [
        ...qc.map((q) => rec('qc-review', q.id, `کنترل کیفیت — سطح ${q.level}`, q.code, false)),
        ...revisions.map((r) => rec('revision', r.id, 'اصلاحیه', r.code, false)),
        ...p.changeRequests.map((c) => rec('change-request', c.id, c.title, c.code)),
      ]);
      push('governance', 'جلسات و گزارش‌ها', [
        ...p.meetings.map((m) => rec('meeting', m.id, m.subject, m.code, false)),
        ...p.statusReports.map((s) => rec('status-report', s.id, `گزارش ${s.period}`, s.code, false)),
      ]);
      push('files', 'فایل‌های پیوست', await filesFor(orgId, user, { projectId: id }));
      break;
    }

    case 'form-submission': {
      const sub = await prisma.formSubmission.findFirst({
        where: { id, organizationId: orgId },
        include: {
          definition: true,
          project: { select: { id: true, code: true, name: true } },
          company: { select: { id: true, legalName: true } },
        },
      });
      if (!sub) return [];

      // Follow the form's own entityRef fields — this is how Doc_H forms point at each other.
      const fields = await schemaForSubmission(prisma, sub) as { key: string; type: string; entity?: string }[];
      const data = (sub.data ?? {}) as Record<string, unknown>;
      const REF_KIND: Record<string, DocumentKind> = {
        project: 'project', proposal: 'proposal', brief: 'brief', contract: 'contract',
        invoice: 'invoice', company: 'company', workOrder: 'work-order',
        deliverable: 'deliverable', changeRequest: 'change-request', revision: 'revision',
      };

      const refs: AttachmentItem[] = [];
      for (const f of fields) {
        if (f.type !== 'entityRef' || !f.entity) continue;
        const refId = data[f.key];
        const target = REF_KIND[f.entity];
        if (typeof refId !== 'string' || !refId || !target) continue;
        const label = await refLabel(target, refId, orgId);
        if (label) refs.push(rec(target, refId, label.title, label.code));
      }

      push('references', 'ارجاعات این فرم', refs);
      push('context', 'زمینه', [
        ...(sub.project && !refs.some((r) => r.id === sub.project!.id)
          ? [rec('project', sub.project.id, sub.project.name, sub.project.code, false)] : []),
        ...(sub.company && !refs.some((r) => r.id === sub.company!.id)
          ? [rec('company', sub.company.id, sub.company.legalName, null, false)] : []),
      ]);
      push('files', 'فایل‌های پیوست', await filesFor(orgId, user, { submissionId: id, projectId: sub.projectId ?? undefined }));
      break;
    }

    case 'proposal': {
      const p = await prisma.proposal.findFirst({
        where: { id, organizationId: orgId },
        include: {
          brief: { select: { id: true, code: true, title: true } },
          workOrders: { select: { id: true, code: true, title: true } },
          qcReviews: { select: { id: true, code: true, level: true } },
          contracts: { select: { id: true, code: true, contractNumber: true, title: true } },
          projects: { select: { id: true, code: true, name: true } },
        },
      });
      if (!p) return [];
      push('origin', 'اسناد منشأ', [rec('brief', p.brief.id, p.brief.title, p.brief.code)]);
      push('execution', 'سفارش‌های کار', p.workOrders.map((w) => rec('work-order', w.id, w.title, w.code)));
      push('quality', 'کنترل کیفیت', p.qcReviews.map((q) => rec('qc-review', q.id, `QC — سطح ${q.level}`, q.code)));
      push('outcome', 'پیامد', [
        ...p.contracts.map((c) => rec('contract', c.id, c.title, c.contractNumber ?? c.code)),
        ...p.projects.map((x) => rec('project', x.id, x.name, x.code, false)),
      ]);
      push('files', 'فایل‌های پیوست', await filesFor(orgId, user, { projectId: p.projects[0]?.id }));
      break;
    }

    case 'brief': {
      const b = await prisma.brief.findFirst({
        where: { id, organizationId: orgId },
        include: {
          proposals: { select: { id: true, code: true, title: true } },
          projects: { select: { id: true, code: true, name: true } },
          opportunity: { select: { company: { select: { id: true, legalName: true } } } },
        },
      });
      if (!b) return [];
      push('downstream', 'اسناد پیرو', [
        ...b.proposals.map((p) => rec('proposal', p.id, p.title, p.code)),
        ...b.projects.map((p) => rec('project', p.id, p.name, p.code, false)),
      ]);
      push('context', 'زمینه', [
        rec('company', b.opportunity.company.id, b.opportunity.company.legalName, null, false),
      ]);
      break;
    }

    case 'contract': {
      const c = await prisma.contract.findFirst({
        where: { id, organizationId: orgId },
        include: {
          proposal: { select: { id: true, code: true, title: true } },
          project: { select: { id: true, code: true, name: true } },
          invoices: { select: { id: true, number: true, kind: true } },
          company: { select: { id: true, legalName: true } },
        },
      });
      if (!c) return [];
      push('origin', 'اسناد منشأ', c.proposal ? [rec('proposal', c.proposal.id, c.proposal.title, c.proposal.code)] : []);
      push('commercial', 'اسناد مالی', c.invoices.map((i) => rec('invoice', i.id, i.kind === 'PROFORMA' ? 'پیش‌فاکتور' : 'فاکتور', i.number)));
      push('context', 'زمینه', [
        ...(c.project ? [rec('project', c.project.id, c.project.name, c.project.code, false)] : []),
        rec('company', c.company.id, c.company.legalName, null, false),
      ]);
      push('files', 'فایل‌های پیوست', await filesFor(orgId, user, { contractId: id, projectId: c.projectId ?? undefined }));
      break;
    }

    case 'work-order': {
      const w = await prisma.workOrder.findFirst({
        where: { id, organizationId: orgId },
        include: {
          project: { select: { id: true, code: true, name: true } },
          deliverables: { select: { id: true, code: true, name: true } },
          qcReviews: { select: { id: true, code: true, level: true } },
        },
      });
      if (!w) return [];
      push('execution', 'خروجی‌ها', w.deliverables.map((d) => rec('deliverable', d.id, d.name, d.code)));
      push('quality', 'کنترل کیفیت', w.qcReviews.map((q) => rec('qc-review', q.id, `QC — سطح ${q.level}`, q.code)));
      push('context', 'زمینه', [rec('project', w.project.id, w.project.name, w.project.code, false)]);
      push('files', 'فایل‌های پیوست', await filesFor(orgId, user, { projectId: w.projectId }));
      break;
    }

    case 'deliverable': {
      const d = await prisma.deliverable.findFirst({
        where: { id, organizationId: orgId },
        include: {
          project: { select: { id: true, code: true, name: true } },
          qcReviews: { select: { id: true, code: true, level: true } },
          revisions: { select: { id: true, code: true } },
        },
      });
      if (!d) return [];
      push('quality', 'کیفیت', [
        ...d.qcReviews.map((q) => rec('qc-review', q.id, `QC — سطح ${q.level}`, q.code)),
        ...d.revisions.map((r) => rec('revision', r.id, 'اصلاحیه', r.code)),
      ]);
      push('context', 'زمینه', [rec('project', d.project.id, d.project.name, d.project.code, false)]);
      push('files', 'فایل‌های پیوست', await filesFor(orgId, user, { deliverableId: id }));
      break;
    }

    case 'change-request': {
      const c = await prisma.changeRequest.findFirst({
        where: { id, organizationId: orgId },
        include: { project: { select: { id: true, code: true, name: true } } },
      });
      if (!c) return [];
      push('context', 'زمینه', [rec('project', c.project.id, c.project.name, c.project.code, false)]);
      push('files', 'فایل‌های پیوست', await filesFor(orgId, user, { projectId: c.projectId }));
      break;
    }

    case 'company': {
      const co = await prisma.company.findFirst({
        where: { id, organizationId: orgId },
        include: {
          projects: { where: { deletedAt: null }, select: { id: true, code: true, name: true } },
          contracts: { select: { id: true, code: true, contractNumber: true, title: true } },
          invoices: { select: { id: true, number: true, kind: true } },
        },
      });
      if (!co) return [];
      push('projects', 'پروژه‌ها', co.projects.map((p) => rec('project', p.id, p.name, p.code, false)));
      push('commercial', 'قرارداد و مالی', [
        ...co.contracts.map((c) => rec('contract', c.id, c.title, c.contractNumber ?? c.code, false)),
        ...co.invoices.map((i) => rec('invoice', i.id, i.kind === 'PROFORMA' ? 'پیش‌فاکتور' : 'فاکتور', i.number, false)),
      ]);
      push('files', 'فایل‌های پیوست', await filesFor(orgId, user, { companyId: id }));
      break;
    }

    default:
      // Leaf documents (qc-review, revision, invoice, meeting, status-report, executive-report)
      // carry no children of their own beyond files already reachable from their parent.
      break;
  }

  return compact(groups);
}

/** Human label for a referenced record, used when following a form's entityRef fields. */
async function refLabel(
  kind: DocumentKind,
  id: string,
  orgId: string,
): Promise<{ title: string; code: string | null } | null> {
  const org = { organizationId: orgId };
  switch (kind) {
    case 'project': {
      const r = await prisma.project.findFirst({ where: { id, ...org }, select: { name: true, code: true } });
      return r && { title: r.name, code: r.code };
    }
    case 'proposal': {
      const r = await prisma.proposal.findFirst({ where: { id, ...org }, select: { title: true, code: true } });
      return r && { title: r.title, code: r.code };
    }
    case 'brief': {
      const r = await prisma.brief.findFirst({ where: { id, ...org }, select: { title: true, code: true } });
      return r && { title: r.title, code: r.code };
    }
    case 'contract': {
      const r = await prisma.contract.findFirst({ where: { id, ...org }, select: { title: true, code: true, contractNumber: true } });
      return r && { title: r.title, code: r.contractNumber ?? r.code };
    }
    case 'invoice': {
      const r = await prisma.invoice.findFirst({ where: { id, ...org }, select: { number: true, kind: true } });
      return r && { title: r.kind === 'PROFORMA' ? 'پیش‌فاکتور' : 'فاکتور', code: r.number };
    }
    case 'company': {
      const r = await prisma.company.findFirst({ where: { id, ...org }, select: { legalName: true } });
      return r && { title: r.legalName, code: null };
    }
    case 'work-order': {
      const r = await prisma.workOrder.findFirst({ where: { id, ...org }, select: { title: true, code: true } });
      return r && { title: r.title, code: r.code };
    }
    case 'deliverable': {
      const r = await prisma.deliverable.findFirst({ where: { id, ...org }, select: { name: true, code: true } });
      return r && { title: r.name, code: r.code };
    }
    case 'change-request': {
      const r = await prisma.changeRequest.findFirst({ where: { id, ...org }, select: { title: true, code: true } });
      return r && { title: r.title, code: r.code };
    }
    case 'revision': {
      const r = await prisma.revision.findFirst({ where: { id, ...org }, select: { code: true } });
      return r && { title: 'اصلاحیه', code: r.code };
    }
    default:
      return null;
  }
}
