import type { InvoiceForm } from '@hiva/contracts';

/**
 * The two printed invoice forms (the owner, 2026-11-07; ADR-125): «فاکتور هیوا.xlsx» and «فاکتور خط
 * تیره.xlsx», kept in ./forms as the owner made them — every border, font and drawing — with the
 * variable cells emptied. This is where each part of an invoice is written on them.
 */

/** A row of single-digit boxes; a number fills them from the far end, as the owner's files do. */
export interface Boxes { row: number; from: string; to: string }
/** A cell and the words printed before the value in it. */
export type Labelled = readonly [cell: string, label: string];

export interface Party {
  name: Labelled;
  economicCode: Boxes;
  nationalId: Boxes;
  province: Labelled;
  county: Labelled;
  postalCode: Boxes;
  city: Labelled;
  address: Labelled;
  phone: Labelled;
}

export interface FormLayout {
  /** The title, padded as the owner padded it. */
  title: { cell: string; lead: string; trail: string };
  number: string;
  date: Labelled;
  seller: Party;
  buyer: Party;
  /** The line rows printed; past them, `repeat` is copied below itself for each further line. */
  lines: { first: number; rows: number; repeat: number };
  totals: number;
  /** The form's last row, as printed. */
  lastRow: number;
  /** Where the form says the tax rate, if it does. */
  rate?: string;
  notes: string;
  terms: string;
  bank: string;
}

/** «شرایط و نحوهٔ فروش», spaced as on both forms; the box after a word marks the one that applies. */
export const termsText = (terms: string | null) => {
  const box = (on: boolean) => (terms ? (on ? ' [*]' : ' [  ]') : '');
  return `شرايط و نحوه فروش                 نقدي${box(terms === 'CASH')}                           غير نقدي${box(terms === 'CREDIT')}                      `;
};

export const LINE_COLUMNS = {
  row: 'B', code: 'C', description: 'D', quantity: 'G', unit: 'H', unitPrice: 'J',
  gross: 'N', discount: 'R', net: 'T', tax: 'W', total: 'Z',
} as const;
/** What each total sums: the merged block of its column. */
export const TOTAL_SPANS = { gross: ['N', 'Q'], discount: ['R', 'S'], net: ['T', 'V'], tax: ['W', 'Y'], total: ['Z', 'AG'] } as const;

export const LAYOUTS: Record<InvoiceForm, FormLayout> = {
  hiva: {
    title: { cell: 'B1', lead: ' ', trail: ' '.repeat(20) },
    number: 'T1',
    date: ['W1', 'تاریخ : '],
    seller: {
      name: ['B4', '  نام شخص حقوقي : '],
      economicCode: { row: 4, from: 'H', to: 'S' },
      nationalId: { row: 4, from: 'W', to: 'AG' },
      province: ['B5', '  نشاني كامل: استان :    '],
      county: ['E5', '  شهرستان :  '],
      postalCode: { row: 5, from: 'J', to: 'S' },
      city: ['T5', ' شهر :'],
      address: ['B6', '  نشاني : '],
      phone: ['T6', ' شماره تلفن / نمابر:             '],
    },
    buyer: {
      name: ['B8', '  نام شخص حقوقي :  '],
      economicCode: { row: 8, from: 'H', to: 'S' },
      nationalId: { row: 8, from: 'W', to: 'AG' },
      province: ['B9', '  نشاني كامل: استان :  '],
      county: ['E9', '  شهرستان :  '],
      postalCode: { row: 9, from: 'J', to: 'S' },
      city: ['T9', ' شهر : '],
      address: ['B10', '  نشاني : '],
      phone: ['T10', ' شماره تلفن: نمابر: '],
    },
    lines: { first: 14, rows: 5, repeat: 17 },
    totals: 19,
    lastRow: 23,
    notes: 'B21',
    terms: 'H20',
    bank: 'H21',
  },
  'khat-tireh': {
    title: { cell: 'B1', lead: ' ', trail: ' '.repeat(21) },
    number: 'Y1',
    date: ['Y2', ''],
    seller: {
      name: ['B4', '  نام شخص حقیقی/حقوقی : '],
      economicCode: { row: 4, from: 'H', to: 'S' },
      nationalId: { row: 4, from: 'W', to: 'AG' },
      province: ['B6', '  نشاني كامل: استان :  '],
      county: ['E6', '  شهرستان :  '],
      postalCode: { row: 6, from: 'J', to: 'S' },
      city: ['T6', ' شهر : '],
      address: ['B7', '  نشاني : '],
      phone: ['T7', ' شماره تلفن / نمابر: '],
    },
    buyer: {
      name: ['B9', '  نام شخص حقوقی: '],
      economicCode: { row: 9, from: 'H', to: 'S' },
      nationalId: { row: 9, from: 'W', to: 'AG' },
      province: ['B10', '  نشاني كامل: استان :  '],
      county: ['E10', '  شهرستان : '],
      postalCode: { row: 10, from: 'J', to: 'S' },
      city: ['T10', ' شهر : '],
      address: ['B11', '  نشاني :  '],
      phone: ['T11', ' شماره تلفن: نمابر:  '],
    },
    lines: { first: 15, rows: 1, repeat: 15 },
    totals: 16,
    lastRow: 20,
    rate: 'W14',
    notes: 'B18',
    terms: 'H17',
    bank: 'H18',
  },
};

/** What each company's form printed when the owner sent it, which every organisation starts from. */
export interface SellerDetails {
  shortName: string; legalName: string; economicCode: string | null; nationalId: string | null;
  province: string | null; county: string | null; city: string | null; address: string | null;
  postalCode: string | null; phone: string | null; bankName: string | null; accountNumber: string | null; iban: string | null;
}

export const SELLER_DEFAULTS: Record<InvoiceForm, SellerDetails> = {
  hiva: {
    shortName: 'هیوا', legalName: 'تجارت رسان هیوا قشم', economicCode: '1409850041', nationalId: '10409850041',
    province: 'هرمزگان', county: 'قشم', city: 'قشم',
    address: 'هرمزگان قشم - نخل زرین - بلوار ولی عصر - خیابان پژوهش - پلاک 0 - برج آپادانا - بلوک 13 - طبقه همکف',
    postalCode: '6123161597', phone: '021-22022070', bankName: null, accountNumber: null, iban: null,
  },
  'khat-tireh': {
    shortName: 'خط تیره', legalName: 'شرکت طراحان خط تیره', economicCode: '67200231041', nationalId: '67200231041',
    province: 'تهران', county: 'تهران', city: 'تهران',
    address: 'تهران ، خیابن محمودیه ، خیابان الف ، کوچه ششم ، پلاک 5',
    postalCode: '6123161597', phone: '22022070-021', bankName: 'دی', accountNumber: '0106916833002',
    // The file printed IR310660000000106946833002, which fails the IBAN check; this one is the account
    // number beside it, and passes. Reported to the owner to confirm (ADR-125).
    iban: 'IR310660000000106916833002',
  },
};
