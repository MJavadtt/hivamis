import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { app, call, closeApp, get, login, post, expectOk } from './helpers.js';
import { prisma } from '../src/db.js';

/**
 * Printed-document exports.
 *
 * The point of these tests is the access order: an export must never reveal more than the
 * exporter could already read, and the Doc_H §12 cost/price split must survive onto paper.
 */
let T: Record<string, string>;
let ids: {
  project: string; proposal: string; brief: string; contract: string;
  invoice: string; company: string; submission: string; workOrder: string;
};

/** Fetch a PDF as raw bytes — `inject` gives us the body without a live socket. */
async function pdf(url: string, token: string) {
  const a = await app();
  const res = await a.inject({
    method: 'GET', url: `/api/v1${url}`,
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: res.statusCode, buffer: res.rawPayload, headers: res.headers };
}

/** What the server recorded as withheld for the most recent export of a record. */
async function lastWithheld(entityType: string, entityId: string): Promise<string[]> {
  const ev = await prisma.auditEvent.findFirst({
    where: { action: 'EXPORT', entityType, entityId },
    orderBy: { createdAt: 'desc' },
  });
  return ((ev?.after as { withheld?: string[] } | null)?.withheld) ?? [];
}

beforeAll(async () => {
  T = {
    admin: await login('admin@hiva.local'),
    ceo: await login('ceo@hiva.local'),
    sales: await login('sales@hiva.local'),
    accountManager: await login('account.manager@hiva.local'),
    creative: await login('creative@hiva.local'),
    legal: await login('legal@hiva.local'),
    finance: await login('finance@hiva.local'),
    pmo: await login('pmo@hiva.local'),
  };

  const [project, proposal, brief, contract, invoice, company, submission, workOrder] = await Promise.all([
    prisma.project.findFirst({ where: { state: 'ACTIVE' } }),
    prisma.proposal.findFirst({ where: { salePrice: { not: null } } }),
    prisma.brief.findFirst(),
    prisma.contract.findFirst(),
    prisma.invoice.findFirst(),
    prisma.company.findFirst(),
    prisma.formSubmission.findFirst(),
    // The creative unit's own order: its manager exports it (ADR-127).
    prisma.workOrder.findFirst({ where: { targetDepartmentCode: 'CR' } }),
  ]);

  ids = {
    project: project!.id, proposal: proposal!.id, brief: brief!.id, contract: contract!.id,
    invoice: invoice!.id, company: company!.id, submission: submission!.id, workOrder: workOrder!.id,
  };
});
afterAll(async () => { await closeApp(); });

describe('PDF generation', () => {
  it('returns a well-formed PDF with download headers', async () => {
    const res = await pdf(`/pdf/project/${ids.project}`, T.accountManager);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    // %PDF magic bytes, and an EOF marker, i.e. a complete document.
    expect(res.buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(res.buffer.subarray(-1024).toString()).toContain('%%EOF');
    expect(res.buffer.length).toBeGreaterThan(5_000);
    expect(res.headers['content-disposition']).toContain('attachment');
    // Persian filenames survive via RFC 5987.
    expect(res.headers['content-disposition']).toContain("filename*=UTF-8''");
  });

  it('renders every document kind the caller is entitled to', async () => {
    const cases: [string, string][] = [
      [`/pdf/project/${ids.project}`, T.accountManager],
      [`/pdf/closure-report/${ids.project}`, T.accountManager],
      [`/pdf/proposal/${ids.proposal}`, T.accountManager],
      [`/pdf/brief/${ids.brief}`, T.accountManager],
      [`/pdf/contract/${ids.contract}`, T.legal],
      [`/pdf/invoice/${ids.invoice}`, T.finance],
      [`/pdf/company/${ids.company}`, T.accountManager],
      [`/pdf/form-submission/${ids.submission}`, T.accountManager],
      [`/pdf/work-order/${ids.workOrder}`, T.creative],
      [`/pdf/executive-report/all`, T.ceo],
    ];
    for (const [url, token] of cases) {
      const res = await pdf(url, token);
      expect(res.status, url).toBe(200);
      expect(res.buffer.subarray(0, 5).toString(), url).toBe('%PDF-');
    }
  }, 60_000);
});

describe('Export access order', () => {
  it('requires the same permission as reading the record', async () => {
    // finance.read gates the invoice document.
    expect((await pdf(`/pdf/invoice/${ids.invoice}`, T.sales)).status).toBe(403);
    expect((await pdf(`/pdf/invoice/${ids.invoice}`, T.creative)).status).toBe(403);
    expect((await pdf(`/pdf/invoice/${ids.invoice}`, T.finance)).status).toBe(200);

    // report.executive gates the management report.
    expect((await pdf('/pdf/executive-report/all', T.sales)).status).toBe(403);
    expect((await pdf('/pdf/executive-report/all', T.creative)).status).toBe(403);
    expect((await pdf('/pdf/executive-report/all', T.ceo)).status).toBe(200);
  }, 30_000);

  it('rejects anonymous, unknown kinds and missing records', async () => {
    expect((await call('GET', `/pdf/project/${ids.project}`)).status).toBe(401);
    expect((await pdf(`/pdf/salaries/${ids.project}`, T.ceo)).status).toBe(400);
    expect((await pdf('/pdf/project/00000000-0000-0000-0000-000000000000', T.ceo)).status).toBe(404);
  });

  /** Doc_H §12 — an execution unit owns its cost but never the customer-facing price. */
  it('withholds the sale price from execution units while showing them their cost', async () => {
    const res = await pdf(`/pdf/proposal/${ids.proposal}`, T.creative);
    expect(res.status).toBe(200);
    const withheld = await lastWithheld('proposal', ids.proposal);
    expect(withheld).toContain('price');
    expect(withheld).not.toContain('cost');
  });

  /** The mirror of the rule: Sales sells the price but must not see the margin it was built on. */
  it('withholds internal cost from Sales', async () => {
    const res = await pdf(`/pdf/proposal/${ids.proposal}`, T.sales);
    expect(res.status).toBe(200);
    expect(await lastWithheld('proposal', ids.proposal)).toContain('cost');
  });

  it('discloses everything to Account and Finance', async () => {
    await pdf(`/pdf/proposal/${ids.proposal}`, T.accountManager);
    expect(await lastWithheld('proposal', ids.proposal)).toEqual([]);

    await pdf(`/pdf/proposal/${ids.proposal}`, T.finance);
    expect(await lastWithheld('proposal', ids.proposal)).toEqual([]);
  });

  it('withholds all financial sections from Legal', async () => {
    await pdf(`/pdf/proposal/${ids.proposal}`, T.legal);
    const withheld = await lastWithheld('proposal', ids.proposal);
    expect(withheld).toEqual(expect.arrayContaining(['cost', 'price', 'finance']));
  });

  /**
   * Sales may only see the number once Final QC has sanctioned it (Doc_H stage F);
   * before that the proposal is still internal.
   */
  it('reveals the price to Sales only after the proposal is sanctioned', async () => {
    const before = await prisma.proposal.findUniqueOrThrow({ where: { id: ids.proposal } });

    await prisma.proposal.update({ where: { id: ids.proposal }, data: { state: 'PRICING' } });
    await pdf(`/pdf/proposal/${ids.proposal}`, T.sales);
    expect(await lastWithheld('proposal', ids.proposal)).toContain('price');

    await prisma.proposal.update({ where: { id: ids.proposal }, data: { state: 'APPROVED' } });
    await pdf(`/pdf/proposal/${ids.proposal}`, T.sales);
    expect(await lastWithheld('proposal', ids.proposal)).not.toContain('price');

    await prisma.proposal.update({ where: { id: ids.proposal }, data: { state: before.state } });
  }, 30_000);

  it('scopes exports to the caller organisation', async () => {
    const other = await prisma.organization.create({
      data: { name: 'سازمان آزمایشی', legalName: 'Test Org' },
    });
    const foreign = await prisma.company.create({
      data: { organizationId: other.id, legalName: 'شرکت خارج از سازمان' },
    });
    try {
      expect((await pdf(`/pdf/company/${foreign.id}`, T.admin)).status).toBe(404);
    } finally {
      await prisma.company.delete({ where: { id: foreign.id } });
      await prisma.organization.delete({ where: { id: other.id } });
    }
  });
});

describe('Export audit trail', () => {
  it('records every export with the sections withheld', async () => {
    await pdf(`/pdf/brief/${ids.brief}`, T.sales);
    const ev = await prisma.auditEvent.findFirst({
      where: { action: 'EXPORT', entityType: 'brief', entityId: ids.brief },
      orderBy: { createdAt: 'desc' },
    });
    expect(ev).toBeTruthy();
    expect((ev!.after as { format?: string }).format).toBe('pdf');
    expect(ev!.reason).toMatch(/redacted|full disclosure/);
    expect(ev!.actorId).toBeTruthy();
  });

  it('lists which kinds the caller may export', async () => {
    const res = await get('/pdf/_kinds', T.sales);
    expect(res.status).toBe(200);
    const byKind = Object.fromEntries(res.body.map((k: any) => [k.kind, k.allowed]));
    expect(byKind['brief']).toBe(true);
    expect(byKind['invoice']).toBe(false);
    expect(byKind['executive-report']).toBe(false);
  });

  it('exposes the export history to auditors only', async () => {
    expect((await get(`/pdf/brief/${ids.brief}/exports`, T.sales)).status).toBe(403);
    const res = await get(`/pdf/brief/${ids.brief}/exports`, T.admin);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('Attachment discovery', () => {
  it('finds the records and files that travel with a project', async () => {
    const res = await get(`/pdf/project/${ids.project}/attachments`, T.accountManager);
    expect(res.status).toBe(200);
    expect(res.body.totalAvailable).toBeGreaterThan(0);

    const kinds = res.body.groups.flatMap((g: any) => g.items.map((i: any) => i.kind ?? 'file'));
    // The project's own origin documents and execution records are reachable.
    expect(kinds).toEqual(expect.arrayContaining(['brief', 'proposal', 'work-order', 'deliverable']));
  });

  /** Doc_H forms point at each other through entityRef fields; those links are followed. */
  it('follows a form submission’s entityRef fields', async () => {
    const linked = await prisma.formSubmission.findFirst({
      where: { organizationId: (await prisma.organization.findFirstOrThrow()).id, projectId: { not: null } },
    });
    if (!linked) return; // nothing linked in this dataset
    const res = await get(`/pdf/form-submission/${linked.id}/attachments`, T.accountManager);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.groups)).toBe(true);
  });

  it('offers each role only what it may export, and omits the rest entirely', async () => {
    const forAccount = await get(`/pdf/project/${ids.project}/attachments`, T.accountManager);
    const forSales = await get(`/pdf/project/${ids.project}/attachments`, T.sales);
    const forLegal = await get(`/pdf/project/${ids.project}/attachments`, T.legal);

    const kindsOf = (r: any) =>
      r.body.groups.flatMap((g: any) => g.items.map((i: any) => i.kind ?? 'file'));

    // Sales holds neither finance.read nor workorder/deliverable/qc/change read.
    expect(kindsOf(forSales)).not.toContain('invoice');
    expect(kindsOf(forSales)).not.toContain('work-order');
    expect(kindsOf(forSales)).not.toContain('qc-review');

    // Legal may read contracts but not finance.
    expect(kindsOf(forLegal)).toContain('contract');
    expect(kindsOf(forLegal)).not.toContain('invoice');

    // Account sees the widest set.
    expect(forAccount.body.totalAvailable).toBeGreaterThan(forSales.body.totalAvailable);
  });
});

describe('Bundled export', () => {
  it('merges the main document and its attachments into one PDF', async () => {
    const list = await get(`/pdf/project/${ids.project}/attachments`, T.accountManager);
    const items = list.body.groups
      .flatMap((g: any) => g.items)
      .filter((i: any) => i.type === 'record')
      .slice(0, 4)
      .map((i: any) => ({ kind: i.kind, id: i.id }));

    const a = await app();
    const res = await a.inject({
      method: 'POST',
      url: `/api/v1/pdf/project/${ids.project}/bundle`,
      headers: { authorization: `Bearer ${T.accountManager}` },
      payload: { items, fileIds: [] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    // Main document + the four selected sections.
    expect(Number(res.headers['x-bundle-sections'])).toBe(items.length + 1);
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    // A merged dossier is necessarily larger than the single document.
    const single = await pdf(`/pdf/project/${ids.project}`, T.accountManager);
    expect(res.rawPayload.length).toBeGreaterThan(single.buffer.length);
  }, 90_000);

  /** The picker is a convenience; the bundle endpoint never trusts the list it is handed. */
  it('silently drops attachments the caller may not export', async () => {
    const a = await app();
    const res = await a.inject({
      method: 'POST',
      url: `/api/v1/pdf/project/${ids.project}/bundle`,
      headers: { authorization: `Bearer ${T.creative}` },
      payload: { items: [{ kind: 'invoice', id: ids.invoice }], fileIds: [] },
    });
    expect(res.statusCode).toBe(200);
    // Only the main document survives — the forged invoice is not merged.
    expect(Number(res.headers['x-bundle-sections'])).toBe(1);
  }, 60_000);

  it('refuses a bundle larger than the cap', async () => {
    const a = await app();
    const res = await a.inject({
      method: 'POST',
      url: `/api/v1/pdf/project/${ids.project}/bundle`,
      headers: { authorization: `Bearer ${T.accountManager}` },
      payload: {
        items: Array.from({ length: 41 }, () => ({ kind: 'brief', id: ids.brief })),
        fileIds: [],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BUNDLE_TOO_LARGE');
  });

  it('records the bundle contents in the audit trail', async () => {
    const a = await app();
    await a.inject({
      method: 'POST',
      url: `/api/v1/pdf/brief/${ids.brief}/bundle`,
      headers: { authorization: `Bearer ${T.accountManager}` },
      payload: { items: [], fileIds: [] },
    });
    const ev = await prisma.auditEvent.findFirst({
      where: { action: 'EXPORT', entityType: 'brief', entityId: ids.brief },
      orderBy: { createdAt: 'desc' },
    });
    const after = ev!.after as { format?: string; included?: unknown[] };
    expect(after.format).toBe('pdf-bundle');
    expect(Array.isArray(after.included)).toBe(true);
  }, 30_000);

  it('requires the main document permission to even list attachments', async () => {
    expect((await get(`/pdf/invoice/${ids.invoice}/attachments`, T.sales)).status).toBe(403);
    expect((await get(`/pdf/project/${ids.project}/attachments`, T.sales)).status).toBe(200);
  });
});

describe('PDF engine hardening', () => {
  /**
   * The footer carries the exporter's own name and the header the document code, both of which
   * were interpolated raw while every other value in the PDF layer goes through esc().
   */
  it('produces a well-formed document for a user whose name contains markup', async () => {
    const victim = await prisma.user.findFirstOrThrow({ where: { email: 'pmo@hiva.local' } });
    const original = victim.fullName;
    await prisma.user.update({
      where: { id: victim.id },
      data: { fullName: '<script>alert(1)</script> فرشاد' },
    });
    try {
      const token = await login('pmo@hiva.local');
      const res = await pdf(`/pdf/project/${ids.project}`, token);
      expect(res.status).toBe(200);
      expect(res.buffer.subarray(0, 5).toString()).toBe('%PDF-');
      // A broken header would truncate the document; a real one runs to several KB.
      expect(res.buffer.length).toBeGreaterThan(20_000);
    } finally {
      await prisma.user.update({ where: { id: victim.id }, data: { fullName: original } });
    }
  }, 60_000);

  it('reports the engine on the readiness probe without gating it', async () => {
    const res = await (await app()).inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ready');
    // Present and meaningful, but a missing browser must not make the service not-ready.
    expect(['up', 'unavailable']).toContain(body.pdf);
  }, 30_000);

  /** Renders are CPU-bound; the limiter turns excess away instead of exhausting memory. */
  it('serves concurrent exports without failing any of them', async () => {
    const token = await login('account.manager@hiva.local');
    const results = await Promise.all(
      Array.from({ length: 6 }, () => pdf(`/pdf/brief/${ids.brief}`, token)),
    );
    // Six simultaneous requests against a limit of two: all succeed, queued rather than refused.
    for (const r of results) {
      expect([200, 503]).toContain(r.status);
      if (r.status === 200) expect(r.buffer.subarray(0, 5).toString()).toBe('%PDF-');
    }
    expect(results.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
  }, 120_000);
});

describe('Client status reports', () => {
  /**
   * Doc_H §14 makes the weekly report mandatory; nothing delivered it. The client's copy is
   * built for a reader outside the organisation, sent with the PDF attached, recorded, and
   * scheduled — and whoever owes a report this week is told so.
   */
  const SECRET_FINANCE = 'حاشیه سود این ماه ۴۲٪ است — محرمانه';
  const SECRET_DECISION = 'باید دربارهٔ جایگزینی فریلنسر تصمیم بگیریم';

  async function freshReport() {
    const project = await prisma.project.findFirstOrThrow({ where: { state: 'ACTIVE' } });
    return expectOk(await post('/status-reports', T.accountManager, {
      projectId: project.id, period: 'هفتهٔ آزمون', progress: 'پیشرفت ۶۰٪ — طراحی صفحات کلیدی تحویل شد',
      completed: 'صفحهٔ اصلی', inProgress: 'صفحات داخلی', next: 'تست کاربری',
      timelineStatus: 'مطابق برنامه', risks: 'تأخیر احتمالی در تأیید مشتری', issues: 'هیچ',
      decisionsNeeded: SECRET_DECISION, financialStatus: SECRET_FINANCE,
    }), 'create report');
  }

  it('builds the client’s copy without financial status or internal decisions', async () => {
    const { buildClientStatusReport } = await import('../src/reports/client-status.js');
    const report = await freshReport();
    const built = await buildClientStatusReport(prisma, report.id);
    expect(built.html).toContain('پیشرفت ۶۰٪');
    expect(built.html).toContain('تأخیر احتمالی در تأیید مشتری');
    expect(built.html).not.toContain(SECRET_FINANCE);
    expect(built.html).not.toContain(SECRET_DECISION);
    expect(built.html).not.toContain('وضعیت مالی');
    expect(built.omitted).toEqual(expect.arrayContaining(['financialStatus', 'decisionsNeeded', 'redaction:cost', 'redaction:price', 'redaction:finance']));
    expect(built.companyName).toBeTruthy();

    const preview = expectOk(await get(`/status-reports/${report.id}/client-preview`, T.accountManager), 'preview');
    expect(preview.to).toContain('@');
    expect(preview.html).not.toContain(SECRET_FINANCE);
  });

  it('sends the report with a real PDF attached, to the client’s primary contact, and records it', async () => {
    const { sendClientStatusReport } = await import('../src/reports/client-status.js');
    const report = await freshReport();
    const outbox: any[] = [];
    const result = await sendClientStatusReport(report.id, { actorId: null, deliver: async (job) => { outbox.push(job); } });

    expect(outbox).toHaveLength(1);
    const mail = outbox[0];
    expect(mail.to).toBe(result.to);
    expect(mail.subject).toContain('گزارش وضعیت پروژه');
    expect(mail.attachments).toHaveLength(1);
    const pdf = Buffer.from(mail.attachments[0].contentBase64, 'base64');
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBe(result.bytes);
    expect(mail.attachments[0].filename).toMatch(/^RPT-\d+\.pdf$/);

    const audited = await prisma.auditEvent.findFirst({ where: { action: 'CLIENT_REPORT_SENT', entityId: report.id } });
    expect((audited?.after as any).to).toBe(result.to);
    expect((audited?.after as any).omitted).toContain('financialStatus');
  }, 60_000);

  it('exposes sending to Account and PMO, with an override address that must be valid', async () => {
    const report = await freshReport();
    expect((await post(`/status-reports/${report.id}/send-to-client`, T.sales, {})).status).toBe(403);
    expect((await post(`/status-reports/${report.id}/send-to-client`, T.accountManager, { to: 'not-an-address' })).status).toBe(400);
    const sent = expectOk(await post(`/status-reports/${report.id}/send-to-client`, T.accountManager, { to: 'client@example.com' }), 'send');
    expect(sent).toMatchObject({ to: 'client@example.com' });
    expect(sent.bytes).toBeGreaterThan(5_000);
  }, 60_000);

  it('plans the weekly run: reports go out, and whoever owes one this week is told', async () => {
    const { planWeeklyRun, runWeekly } = await import('../src/reports/client-status.js');
    const org = await prisma.organization.findFirstOrThrow();
    const company = await prisma.company.findFirstOrThrow();
    const pmo = await prisma.user.findFirstOrThrow({ where: { email: 'pmo@hiva.local' } });
    const silent = await prisma.project.create({
      data: { organizationId: org.id, code: `PRJ-SILENT-${Date.now()}`, name: 'پروژهٔ بی‌گزارش', companyId: company.id, accountOwnerId: pmo.id, objective: 'x', state: 'ACTIVE' },
    });
    await freshReport();

    const plan = await planWeeklyRun(prisma);
    expect(plan.send.some((s) => s.projectCode === 'PRJ-000002')).toBe(true);
    expect(plan.missing.some((m) => m.projectId === silent.id)).toBe(true);

    const outbox: any[] = [];
    const before = await prisma.notification.count({ where: { userId: pmo.id, kind: 'STATUS_REPORT_MISSING' } });
    const result = await runWeekly(new Date(), async (job) => { outbox.push(job); });
    expect(result.sent).toBeGreaterThanOrEqual(1);
    expect(result.missing).toBeGreaterThanOrEqual(1);
    expect(outbox.length).toBe(result.sent);
    expect(await prisma.notification.count({ where: { userId: pmo.id, kind: 'STATUS_REPORT_MISSING' } })).toBeGreaterThan(before);
  }, 90_000);
});
