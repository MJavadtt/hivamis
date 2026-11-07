/**
 * An invoice as سامانهٔ مؤدیان receives it (roadmap #32), and every reason it would be refused —
 * found here, in Persian, before anything is sent.
 *
 * Field names are the authority's (header: taxid, indatim, inty, inno, irtaxid, inp, ins, tins,
 * tob, bid, tinb, bpc, …; body: sstid, sstt, am, mu, fee, prdis, dis, adis, vra, vam, tsstam),
 * amounts in whole rials. An invoice in another currency (#28) is reported in rials at the rate it
 * was booked at; the export pattern with currency fields is not implemented.
 */
import { money, toMoney } from '../lib/money.js';
export type TaxSubject = 'ORIGINAL' | 'CORRECTION' | 'CANCELLATION';
const INS: Record<TaxSubject, number> = { ORIGINAL: 1, CORRECTION: 2, CANCELLATION: 3 };

export interface SellerProfile {
  memoryId: string; sellerTaxId: string; economicCode: string | null; postalCode: string | null;
  branchCode: string | null; defaultServiceCode: string; defaultUnitCode: string;
}
export interface Buyer { legalName: string; nationalId: string | null; economicCode: string | null; postalCode: string | null }
export interface InvoiceForTax {
  kind: string; state: string; number: string; issueDate: Date; taxPercent: unknown; total: unknown; fxRate: unknown; currency: string;
  lines: unknown;
  /** ADR-125: the company it was issued in, as printed. */
  sellerDetails?: unknown;
}
export interface Problem { field: string; messageFa: string }

const digits = (v: string | null | undefined) => (v ?? '').replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0)).replace(/\D/g, '');
const num = (v: unknown) => (v == null ? 0 : Number(v));
/** A whole rial from an exact product: half away from zero (audit CALC-2), as the authority rounds. */
const rial = (v: unknown) => toMoney(v, 0);

interface Line { description: string; quantity: number; unitPrice: number; discount: number; serviceCode?: string }
// A goods code typed on the form («کد کالا») is the line's service code when it is one: 13 digits.
const linesOf = (raw: unknown): Line[] =>
  (Array.isArray(raw) ? raw : []).map((l: any) => ({
    description: String(l?.description ?? ''), quantity: num(l?.quantity), unitPrice: num(l?.unitPrice), discount: num(l?.discount),
    serviceCode: l?.serviceCode ?? (/^\d{13}$/.test(digits(l?.code)) ? digits(l?.code) : undefined),
  }));

/** The buyer as the authority classifies them: a legal entity by its 11-digit national id, a person by a 10-digit code. */
export function buyerType(b: Buyer): 1 | 2 | null {
  const id = digits(b.nationalId);
  return id.length === 11 ? 2 : id.length === 10 ? 1 : null;
}

export function validateSeller(p: SellerProfile | null): Problem[] {
  if (!p) return [{ field: 'profile', messageFa: 'مشخصات مؤدی (حافظهٔ مالیاتی و شناسه‌ها) در «مالی ← سامانهٔ مؤدیان» ثبت نشده است' }];
  const out: Problem[] = [];
  if (!/^[A-Za-z0-9]{6}$/.test(p.memoryId)) out.push({ field: 'memoryId', messageFa: 'شناسهٔ حافظهٔ مالیاتی باید شش نویسهٔ لاتین یا رقم باشد' });
  if (!/^\d{10,14}$/.test(digits(p.sellerTaxId))) out.push({ field: 'sellerTaxId', messageFa: 'شمارهٔ اقتصادی/شناسهٔ ملی فروشنده ۱۰ تا ۱۴ رقم است' });
  if (!/^\d{13}$/.test(digits(p.defaultServiceCode))) out.push({ field: 'defaultServiceCode', messageFa: 'شناسهٔ کالا/خدمت پیش‌فرض ۱۳ رقم است' });
  if (!/^\d{2,8}$/.test(digits(p.defaultUnitCode))) out.push({ field: 'defaultUnitCode', messageFa: 'کد واحد اندازه‌گیری معتبر نیست' });
  return out;
}

export function validateForTax(inv: InvoiceForTax, buyer: Buyer, seller: SellerProfile | null, subject: TaxSubject, referenceTaxId: string | null, now = new Date()): Problem[] {
  const out = validateSeller(seller);
  if (inv.kind !== 'INVOICE') out.push({ field: 'kind', messageFa: 'پیش‌فاکتور به سامانهٔ مؤدیان گزارش نمی‌شود؛ فقط فاکتور' });
  if (inv.state === 'DRAFT') out.push({ field: 'state', messageFa: 'فاکتور هنوز صادر نشده است' });
  if (inv.state === 'CANCELLED' && subject !== 'CANCELLATION') out.push({ field: 'state', messageFa: 'فاکتور ابطال‌شده فقط با «ابطالی» گزارش می‌شود' });
  if (subject !== 'ORIGINAL' && !referenceTaxId) out.push({ field: 'irtaxid', messageFa: 'اصلاحی و ابطالی به شمارهٔ مالیاتی پذیرفته‌شدهٔ فاکتور اصلی نیاز دارد' });
  // ADR-125: two companies issue invoices, and the taxpayer profile is one of them. An invoice of the
  // other must not go to the authority under this one's number.
  const issuer = inv.sellerDetails as { legalName?: string; nationalId?: string | null; economicCode?: string | null } | null | undefined;
  if (issuer && seller && ![digits(issuer.nationalId), digits(issuer.economicCode)].includes(digits(seller.sellerTaxId))) {
    out.push({ field: 'tins', messageFa: `این فاکتور به نام «${issuer.legalName ?? ''}» صادر شده، ولی مشخصات مؤدیِ ثبت‌شده در «سامانهٔ مؤدیان» مال شرکت دیگری است؛ فاکتورِ این شرکت از اینجا گزارش نمی‌شود` });
  }
  if (inv.issueDate > now) out.push({ field: 'indatim', messageFa: 'تاریخ صدور در آینده است' });

  if (!buyerType(buyer)) out.push({ field: 'bid', messageFa: `شناسهٔ ملی خریدار (${buyer.legalName}) ثبت نشده یا ۱۰/۱۱ رقم نیست — فاکتور نوع اول، خریدار شناخته‌شده می‌خواهد` });
  if (!/^\d{10}$/.test(digits(buyer.postalCode))) out.push({ field: 'bpc', messageFa: `کد پستی ده‌رقمی خریدار (${buyer.legalName}) ثبت نشده است` });

  const lines = linesOf(inv.lines);
  if (!lines.length) out.push({ field: 'body', messageFa: 'فاکتور ردیفی ندارد' });
  lines.forEach((l, i) => {
    if (!(l.quantity > 0)) out.push({ field: `body[${i}].am`, messageFa: `ردیف ${i + 1}: مقدار باید بیش از صفر باشد` });
    if (l.unitPrice < 0) out.push({ field: `body[${i}].fee`, messageFa: `ردیف ${i + 1}: مبلغ واحد منفی است` });
    if (l.serviceCode && !/^\d{13}$/.test(digits(l.serviceCode))) out.push({ field: `body[${i}].sstid`, messageFa: `ردیف ${i + 1}: شناسهٔ کالا/خدمت ۱۳ رقم است` });
  });
  if (seller && lines.length) {
    const built = buildTaxInvoice(inv, buyer, seller, subject, referenceTaxId, 'X'.repeat(22), 1);
    // The authority recomputes; a difference beyond rounding means the invoice and its lines disagree.
    if (Math.abs(built.header.tbill - rial(num(inv.total))) > lines.length) {
      out.push({ field: 'tbill', messageFa: `جمع ردیف‌ها (${built.header.tbill.toLocaleString('en-US')}) با مبلغ فاکتور (${rial(num(inv.total)).toLocaleString('en-US')}) نمی‌خواند` });
    }
  }
  return out;
}

export function buildTaxInvoice(inv: InvoiceForTax, buyer: Buyer, seller: SellerProfile, subject: TaxSubject, referenceTaxId: string | null, taxId: string, serial: number) {
  const rate = num(inv.fxRate) || 1;
  const vra = num(inv.taxPercent);
  const body = linesOf(inv.lines).map((l) => {
    const fee = rial(money(l.unitPrice).mul(rate));
    const prdis = rial(money(l.quantity).mul(fee));
    const dis = rial(money(l.discount).mul(rate));
    const adis = prdis - dis;
    const vam = rial(money(adis).mul(vra).div(100));
    return {
      sstid: digits(l.serviceCode ?? seller.defaultServiceCode), sstt: l.description.slice(0, 400), am: l.quantity, mu: digits(seller.defaultUnitCode),
      fee, prdis, dis, adis, vra, vam, odam: 0, tsstam: adis + vam,
    };
  });
  const tprdis = body.reduce((s, b) => s + b.prdis, 0);
  const tdis = body.reduce((s, b) => s + b.dis, 0);
  const tadis = tprdis - tdis;
  const tvam = body.reduce((s, b) => s + b.vam, 0);
  const tob = buyerType(buyer);
  const header = {
    taxid: taxId, indatim: inv.issueDate.getTime(), indati2m: inv.issueDate.getTime(),
    inty: 1, inno: String(serial), irtaxid: referenceTaxId ?? null, inp: 1, ins: INS[subject],
    tins: digits(seller.sellerTaxId), tob, bid: digits(buyer.nationalId) || null, tinb: digits(buyer.economicCode) || digits(buyer.nationalId) || null,
    sbc: seller.branchCode ? digits(seller.branchCode) : null, bpc: digits(buyer.postalCode) || null,
    tprdis, tdis, tadis, tvam, todam: 0, tbill: tadis + tvam,
    // Agency invoices are on credit terms: the whole bill is the credit part.
    setm: 2, cap: 0, insp: tadis + tvam,
  };
  return { header, body, payments: [] as unknown[] };
}
