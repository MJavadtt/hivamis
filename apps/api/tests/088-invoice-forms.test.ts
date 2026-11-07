import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { PDFDocument } from 'pdf-lib';
import { app, closeApp, get, login, patch, post, put, expectOk } from './helpers.js';
import { prisma } from '../src/db.js';
import { sheetHtml } from '../src/invoices/sheet-html.js';
import { invoiceWorkbook } from '../src/invoices/workbook.js';
import { SELLER_DEFAULTS } from '../src/invoices/forms.js';
import { money } from '../src/lib/money.js';

/**
 * The owner (2026-11-07; ADR-125): «فاکتورهای شرکت برای صدور، کاربر اول باید هیوا یا خط تیره را انتخاب
 * کند، سپس داده‌ها وارد شود یا از داده‌های مشتری خوانده شود، سپس خروجی فاکتور باید با همین فرمت باشد».
 */

let T: Record<string, string>;
let orgId: string;
let sellers: Record<string, { id: string }>;
let companyId: string;

async function raw(url: string, token: string) {
  const res = await (await app()).inject({ method: 'GET', url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` } });
  return { status: res.statusCode, buffer: res.rawPayload, headers: res.headers, body: res.body };
}
const sheetOf = async (buffer: Buffer) => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  return wb.worksheets[0]!;
};
const valueOf = (c: ExcelJS.Cell) => {
  const v = c.value as any;
  return v && typeof v === 'object' ? ('result' in v ? v.result : 'richText' in v ? v.richText.map((r: any) => r.text).join('') : v) : v;
};

beforeAll(async () => {
  await app();
  T = {
    finance: await login('finance@hiva.local'), sales: await login('sales@hiva.local'), admin: await login('admin@hiva.local'),
  };
  orgId = (await prisma.user.findFirstOrThrow({ where: { email: 'finance@hiva.local' } })).organizationId;
  // As on an installation whose reference sync is switched off: reading them makes them.
  await prisma.invoiceSeller.deleteMany({ where: { organizationId: orgId } });
  const list = expectOk(await get('/invoice-sellers', T.finance), 'sellers') as { id: string; form: string }[];
  sellers = Object.fromEntries(list.map((s) => [s.form, s]));
  // A client whose record has some of what the form asks, not all of it.
  companyId = (await prisma.company.create({
    data: { organizationId: orgId, legalName: 'شرکت خریدار آزمون فرم', nationalId: '10101010101', address: 'تهران، خیابان آزمون' },
  })).id;
});
afterAll(closeApp);

describe('The companies invoices are issued in', () => {
  it('are هیوا and خط تیره, as the owner\'s files print them, and finance alone reads them', async () => {
    const list = expectOk(await get('/invoice-sellers', T.finance), 'sellers');
    expect(list.map((s: any) => [s.form, s.shortName, s.legalName])).toEqual([
      ['hiva', 'هیوا', 'تجارت رسان هیوا قشم'], ['khat-tireh', 'خط تیره', 'شرکت طراحان خط تیره'],
    ]);
    expect((await get('/invoice-sellers', T.sales)).status).toBe(403);
  });

  it('take a correction from finance, and refuse an IBAN whose check digits fail — the one the owner\'s file printed', async () => {
    const id = sellers['khat-tireh']!.id;
    const base = { ...SELLER_DEFAULTS['khat-tireh'] };
    const bad = await put(`/invoice-sellers/${id}`, T.finance, { ...base, iban: 'IR310660000000106946833002' });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain('شبا');
    expect((await put(`/invoice-sellers/${id}`, T.sales, base)).status).toBe(403);
    // Persian digits and spaces, as people type them, are kept as a bank reads them.
    const ok = expectOk(await put(`/invoice-sellers/${id}`, T.finance, { ...base, iban: 'IR31 0660 0000 0010 6916 8330 0۲' }), 'fix');
    expect(ok.iban).toBe('IR310660000000106916833002');
    // A field not sent is left as it was; one sent empty is cleared.
    const partial = expectOk(await put(`/invoice-sellers/${id}`, T.finance, { shortName: base.shortName, legalName: base.legalName, phone: null }), 'partial');
    expect(partial).toMatchObject({ address: base.address, iban: 'IR310660000000106916833002', phone: null });
    expectOk(await put(`/invoice-sellers/${id}`, T.finance, base), 'restore');
    expect(await prisma.auditEvent.count({ where: { entityType: 'invoiceSeller', entityId: id, action: 'UPDATE' } })).toBeGreaterThan(0);
  });
});

describe('Issuing on a form', () => {
  it('reads the buyer from the client, keeps what was typed over it, fills only the client\'s blanks, and takes the discount off', async () => {
    const buyer = expectOk(await get(`/invoices/buyer/${companyId}`, T.finance), 'buyer');
    expect(buyer).toMatchObject({ legalName: 'شرکت خریدار آزمون فرم', nationalId: '10101010101', postalCode: null });
    const inv = expectOk(await post('/invoices', T.finance, {
      kind: 'INVOICE', sellerId: sellers.hiva!.id, companyId, number: 'FRM-1', issueDate: '2026-11-01', taxPercent: 10, saleTerms: 'CREDIT',
      buyer: { ...buyer, postalCode: '۱۲۳۴۵۶۷۸۹۰', province: 'تهران', nationalId: '10101010101', address: 'نشانی تازهٔ روی فاکتور' },
      fillCompany: true,
      lines: [
        { code: 'K-1', description: 'طراحی', quantity: 2, unit: 'عدد', unitPrice: 1_000_000, discount: 200_000 },
        { description: 'اجرا', quantity: 1, unitPrice: 3_000_000 },
      ],
    }), 'issue');
    // 2×1,000,000 − 200,000 + 3,000,000 = 4,800,000; and 10% on that.
    expect(Number(inv.subtotal)).toBe(4_800_000);
    expect(Number(inv.total)).toBe(5_280_000);
    expect(inv.sellerDetails).toMatchObject({ legalName: 'تجارت رسان هیوا قشم', nationalId: '10409850041' });
    expect(inv.buyer).toMatchObject({ postalCode: '1234567890', address: 'نشانی تازهٔ روی فاکتور' });
    const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
    // Blank on the client: filled. Written there already: left as it was.
    expect(company.postalCode).toBe('1234567890');
    expect(company.province).toBe('تهران');
    expect(company.address).toBe('تهران، خیابان آزمون');
    expect(await prisma.auditEvent.count({ where: { entityType: 'company', entityId: companyId, reason: { contains: 'FRM-1' } } })).toBe(1);
  });

  it('refuses a discount larger than its line', async () => {
    const res = await post('/invoices', T.finance, {
      kind: 'INVOICE', sellerId: sellers.hiva!.id, companyId, number: 'FRM-X', issueDate: '2026-11-01',
      lines: [{ description: 'x', quantity: 1, unitPrice: 100, discount: 101 }],
    });
    expect(res.status).toBe(400);
  });

  it('keeps on an issued invoice the seller it printed, while a draft follows a correction', async () => {
    const draft = expectOk(await post('/invoices', T.finance, { kind: 'PROFORMA', sellerId: sellers.hiva!.id, companyId, number: 'FRM-2', issueDate: '2026-11-02', lines: [{ description: 'x', quantity: 1, unitPrice: 10 }] }), 'draft');
    const issued = await prisma.invoice.findFirstOrThrow({ where: { number: 'FRM-1' } });
    await prisma.invoice.update({ where: { id: issued.id }, data: { state: 'ISSUED' } });
    const hiva = await prisma.invoiceSeller.findUniqueOrThrow({ where: { id: sellers.hiva!.id } });
    expectOk(await put(`/invoice-sellers/${hiva.id}`, T.finance, { ...SELLER_DEFAULTS.hiva, address: 'نشانی تازهٔ هیوا' }), 'move');
    expectOk(await patch(`/invoices/${draft.id}`, T.finance, { sellerId: hiva.id, notes: 'یادداشت' }), 'edit draft');
    expect(((await prisma.invoice.findUniqueOrThrow({ where: { id: draft.id } })).sellerDetails as any).address).toBe('نشانی تازهٔ هیوا');
    expect(((await prisma.invoice.findUniqueOrThrow({ where: { id: issued.id } })).sellerDetails as any).address).toBe(SELLER_DEFAULTS.hiva.address);
    expectOk(await put(`/invoice-sellers/${hiva.id}`, T.finance, SELLER_DEFAULTS.hiva), 'restore');
  });
});

describe('The output, in the owner\'s format', () => {
  it('is the owner\'s Excel form, filled: their sheet, their drawings, live formulas, and no past client in it', async () => {
    const lines = Array.from({ length: 4 }, (_, i) => ({ code: `C${i + 1}`, description: `ردیف ${i + 1}`, quantity: i + 1, unit: 'عدد', unitPrice: 1_000_000 }));
    const inv = expectOk(await post('/invoices', T.finance, {
      kind: 'INVOICE', sellerId: sellers['khat-tireh']!.id, companyId, number: 'KT-1405-9', issueDate: '2026-11-03', taxPercent: 10, saleTerms: 'CASH', notes: 'یادداشت روی فرم', lines,
    }), 'issue');
    await prisma.invoice.update({ where: { id: inv.id }, data: { state: 'ISSUED' } });
    const res = await raw(`/invoices/${inv.id}/workbook`, T.finance);
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toContain('spreadsheetml');
    expect(String(res.headers['content-disposition'])).toContain(encodeURIComponent('فاکتور KT-1405-9.xlsx'));
    const ws = await sheetOf(res.buffer);
    expect(ws.name).toBe('فاکتور');
    expect(ws.views[0]?.rightToLeft).toBe(true);
    expect(String(valueOf(ws.getCell('B1'))).trim()).toBe('فاکتور فروش كالا و خدمات');
    expect(valueOf(ws.getCell('Y1'))).toBe('شماره : KT-1405-9');
    expect(valueOf(ws.getCell('Y2'))).toBe('1405/08/12');
    expect(valueOf(ws.getCell('B4'))).toContain('شرکت طراحان خط تیره');
    expect(valueOf(ws.getCell('B9'))).toContain('شرکت خریدار آزمون فرم');
    // The economic code's digits in their boxes, ending in the last one.
    expect(['I4', 'J4', 'K4', 'S4'].map((r) => valueOf(ws.getCell(r)))).toEqual([6, 7, 2, 1]);
    // One line row on the form, three more beneath it; the totals moved down below them.
    expect([15, 16, 17, 18].map((r) => valueOf(ws.getCell(`B${r}`)))).toEqual([1, 2, 3, 4]);
    expect((ws.getCell('N16').value as any).formula).toBe('G16*J16');
    expect((ws.getCell('W18').value as any).formula).toBe('T18*10%');
    expect((ws.getCell('Z19').value as any).formula).toBe('SUM(Z15:AG18)');
    expect(Number(valueOf(ws.getCell('Z19')))).toBe(Number(inv.total));
    expect(String(valueOf(ws.getCell('H20')))).toContain('نقدي [*]');
    expect(valueOf(ws.getCell('B21'))).toBe('یادداشت روی فرم');
    expect(valueOf(ws.getCell('H21'))).toContain('IR310660000000106916833002');
    expect(ws.getCell('D17').isMerged).toBe(true);

    const zip = await JSZip.loadAsync(res.buffer);
    const drawing = await zip.file('xl/drawings/drawing1.xml')!.async('string');
    expect(drawing.match(/<xdr:twoCellAnchor>/g)).toHaveLength(2);
    expect(drawing).not.toContain('Rectangle');
    const all = (await Promise.all(Object.values(zip.files).map((f) => f.async('string')))).join('');
    for (const leftover of ['الماس', 'فازدوم', 'Financial Manager', 'Canon', 'IR310660000000106946833002']) expect(all).not.toContain(leftover);

    const ev = await prisma.auditEvent.findFirst({ where: { action: 'EXPORT', entityType: 'invoice', entityId: inv.id }, orderBy: { createdAt: 'desc' } });
    expect(ev?.after).toMatchObject({ format: 'xlsx', form: 'khat-tireh' });
    expect((await raw(`/invoices/${inv.id}/workbook`, T.sales)).status).toBe(403);
  });

  it('prints a proforma as one, and a draft as a draft, on Hiva\'s form — its print area following a longer invoice', async () => {
    const lines = Array.from({ length: 7 }, (_, i) => ({ description: `خدمت ${i + 1}`, quantity: 1, unitPrice: 500_000 }));
    const inv = expectOk(await post('/invoices', T.finance, { kind: 'PROFORMA', sellerId: sellers.hiva!.id, companyId, number: 'PF-7', issueDate: '2026-11-03', lines }), 'issue');
    const res = await raw(`/invoices/${inv.id}/workbook`, T.finance);
    const ws = await sheetOf(res.buffer);
    expect(String(valueOf(ws.getCell('B1'))).trim()).toBe('پیش فاکتور فروش كالا و خدمات (پیش‌نویس)');
    expect([14, 20].map((r) => valueOf(ws.getCell(`B${r}`)))).toEqual([1, 7]);
    expect(valueOf(ws.getCell('B21'))).toBe('جمع کل : ');
    const zip = await JSZip.loadAsync(res.buffer);
    expect(await zip.file('xl/workbook.xml')!.async('string')).toContain("'فاکتور'!$A$1:$AG$25");
  });

  it('is one landscape page in PDF, drawn from the same workbook', async () => {
    const inv = await prisma.invoice.findFirstOrThrow({ where: { number: 'KT-1405-9' } });
    const res = await raw(`/pdf/invoice/${inv.id}`, T.finance);
    expect(res.status).toBe(200);
    const doc = await PDFDocument.load(res.buffer);
    expect(doc.getPageCount()).toBe(1);
    const { width, height } = doc.getPage(0).getSize();
    expect(width).toBeGreaterThan(height);
  });

  it('draws the form\'s cells, numbers left to right in Persian digits, the IBAN as a bank reads it', async () => {
    const { xlsx, lastRow } = await invoiceWorkbook({
      form: 'khat-tireh', kind: 'INVOICE', state: 'ISSUED', number: 'F-1405-021', issueDate: new Date('2026-11-07T08:00:00Z'),
      seller: SELLER_DEFAULTS['khat-tireh'], buyer: { legalName: 'خریدار', phone: '021-88888888' },
      lines: [{ description: 'طراحی', quantity: 1, unitPrice: money(12_345_000), discount: money(0) }], taxPercent: 10, saleTerms: null, notes: null,
    });
    const html = await sheetHtml(xlsx, lastRow);
    expect(html).toContain('مشخصات فروشنده');
    expect(html).toContain('<span class="n">۰۲۱-۸۸۸۸۸۸۸۸</span>');
    expect(html).toContain('<span class="n">۱۲,۳۴۵,۰۰۰</span>');
    expect(html).toContain('IR310660000000106916833002');
    expect(html).not.toContain('<script');
  });

  it('has none for an invoice from before the forms until a seller is chosen; its PDF keeps the general layout', async () => {
    const old = expectOk(await post('/invoices', T.finance, { kind: 'INVOICE', companyId, number: 'OLD-1', issueDate: '2026-10-01', lines: [{ description: 'x', quantity: 1, unitPrice: 10 }] }), 'old');
    const res = await raw(`/invoices/${old.id}/workbook`, T.finance);
    expect(res.status).toBe(409);
    expect(res.body).toContain('INVOICE_NO_SELLER');
    expect((await raw(`/pdf/invoice/${old.id}`, T.finance)).status).toBe(200);
  });
});

describe('The tax system', () => {
  it('is told the discount, and is not sent the other company\'s invoice under this one\'s number', async () => {
    await prisma.taxProfile.upsert({
      where: { organizationId: orgId },
      create: { organizationId: orgId, memoryId: 'A1B2C3', sellerTaxId: '10409850041', defaultServiceCode: '1234567890123', defaultUnitCode: '1627', updatedById: (await prisma.user.findFirstOrThrow({ where: { email: 'finance@hiva.local' } })).id },
      update: { sellerTaxId: '10409850041' },
    });
    const hivaInv = await prisma.invoice.findFirstOrThrow({ where: { number: 'FRM-1' } });
    const preview = expectOk(await get(`/invoices/${hivaInv.id}/tax`, T.finance), 'preview');
    expect(preview.payload.body[0]).toMatchObject({ prdis: 2_000_000, dis: 200_000, adis: 1_800_000, vam: 180_000 });
    expect(preview.payload.header).toMatchObject({ tdis: 200_000, tbill: 5_280_000, bpc: '1234567890' });
    expect(preview.problems.map((p: any) => p.field)).not.toContain('tins');

    const ktInv = await prisma.invoice.findFirstOrThrow({ where: { number: 'KT-1405-9' } });
    await prisma.invoice.update({ where: { id: ktInv.id }, data: { state: 'ISSUED' } });
    const other = expectOk(await get(`/invoices/${ktInv.id}/tax`, T.finance), 'other');
    expect(other.problems.map((p: any) => p.field)).toContain('tins');
  });
});
