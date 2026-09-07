import { FORMS_A_F } from './forms-a-f.js';
import { FORMS_G_N } from './forms-g-n.js';
import type { FormDef } from './form-fields.js';

/** All 130 Doc_H forms, ordered by their catalogue number. */
export const ALL_FORMS: readonly FormDef[] = [...FORMS_A_F, ...FORMS_G_N].sort((a, b) => a.no - b.no);

export const FORM_BY_CODE = new Map(ALL_FORMS.map((f) => [f.code, f]));

export const FORM_CATEGORY_LABELS: Record<string, string> = {
  A: 'فرم‌های CRM و فروش',
  B: 'فرم‌های Account و تحلیل پروژه',
  C: 'فرم‌های سفارش به واحدهای اجرایی',
  D: 'فرم‌های اجرای داخلی واحدها',
  E: 'فرم‌های کنترل کیفیت',
  F: 'فرم‌های Proposal و Pricing',
  G: 'فرم‌های ارتباط Sales و Account',
  H: 'فرم‌های قرارداد و حقوقی',
  I: 'فرم‌های مالی',
  J: 'فرم‌های مدیریت پروژه و Traffic',
  K: 'فرم‌های گزارش‌دهی',
  L: 'فرم‌های ارتباط با مشتری',
  M: 'فرم‌های پایان پروژه',
  N: 'فرم‌های توسعه مشتری',
};

export function formsByCategory(): Record<string, FormDef[]> {
  const out: Record<string, FormDef[]> = {};
  for (const form of ALL_FORMS) (out[form.category] ??= []).push(form);
  return out;
}
