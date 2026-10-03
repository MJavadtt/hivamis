import { normalizeIranMobile, type FieldDef } from '@hiva/contracts';
import { badRequest } from '../lib/errors.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Issue { path: string; message: string }

function checkField(field: FieldDef, raw: unknown, prefix: string, issues: Issue[]): unknown {
  const path = prefix ? `${prefix}.${field.key}` : field.key;
  const empty =
    raw == null ||
    raw === '' ||
    (Array.isArray(raw) && raw.length === 0);

  if (empty) {
    if (field.required) issues.push({ path, message: `«${field.labelFa}» الزامی است` });
    return field.type === 'checkbox' ? false : null;
  }

  switch (field.type) {
    case 'number':
    case 'currency':
    case 'percent': {
      const n = Number(raw);
      if (Number.isNaN(n)) { issues.push({ path, message: `«${field.labelFa}» باید عدد باشد` }); return null; }
      if (field.min != null && n < field.min) issues.push({ path, message: `«${field.labelFa}» نباید کمتر از ${field.min} باشد` });
      if (field.max != null && n > field.max) issues.push({ path, message: `«${field.labelFa}» نباید بیشتر از ${field.max} باشد` });
      return n;
    }
    case 'date':
    case 'datetime': {
      const d = new Date(String(raw));
      if (Number.isNaN(d.getTime())) { issues.push({ path, message: `«${field.labelFa}» تاریخ معتبری نیست` }); return null; }
      return d.toISOString();
    }
    case 'checkbox':
      return raw === true || raw === 'true';
    case 'select': {
      const v = String(raw);
      if (field.options && !field.options.some((o) => o.value === v)) {
        issues.push({ path, message: `مقدار «${field.labelFa}» معتبر نیست` });
      }
      return v;
    }
    case 'multiselect': {
      const arr = Array.isArray(raw) ? raw.map(String) : [String(raw)];
      if (field.options) {
        const valid = new Set(field.options.map((o) => o.value));
        const bad = arr.filter((v) => !valid.has(v));
        if (bad.length) issues.push({ path, message: `مقادیر نامعتبر در «${field.labelFa}»: ${bad.join('، ')}` });
      }
      return arr;
    }
    case 'user':
    case 'department':
    case 'entityRef': {
      const v = String(raw);
      // department codes are short strings; user/entity references must be UUIDs.
      if (field.type !== 'department' && !UUID_RE.test(v)) {
        issues.push({ path, message: `شناسه «${field.labelFa}» معتبر نیست` });
      }
      return v;
    }
    case 'mobile': {
      // One written form, 09xxxxxxxxx, whatever digits or prefix it was typed with (Hivamis task 2).
      const n = normalizeIranMobile(String(raw));
      if (!n) issues.push({ path, message: `«${field.labelFa}» شمارهٔ همراه معتبری نیست — مانند ۰۹۱۲۱۲۳۴۵۶۷` });
      return n;
    }
    case 'attachment':
      return Array.isArray(raw) ? raw.map(String) : [String(raw)];
    case 'table': {
      if (!Array.isArray(raw)) { issues.push({ path, message: `«${field.labelFa}» باید فهرست باشد` }); return []; }
      return raw.map((row, i) => {
        const out: Record<string, unknown> = {};
        for (const col of field.columns ?? []) {
          out[col.key] = checkField(col, (row as Record<string, unknown>)?.[col.key], `${path}[${i}]`, issues);
        }
        return out;
      });
    }
    default: {
      const s = String(raw);
      if (s.length > 20000) issues.push({ path, message: `«${field.labelFa}» بیش از حد طولانی است` });
      return s;
    }
  }
}

/** Validate and normalise a submission against the form's field schema. */
export function validateFormData(
  fields: readonly FieldDef[],
  data: Record<string, unknown>,
  { partial = false }: { partial?: boolean } = {},
): Record<string, unknown> {
  const issues: Issue[] = [];
  const out: Record<string, unknown> = {};

  for (const field of fields) {
    // Honour conditional visibility — a hidden field is never required.
    if (field.visibleWhen) {
      const controlling = String(data[field.visibleWhen.field] ?? '');
      if (!field.visibleWhen.equals.includes(controlling)) continue;
    }
    const effective = partial ? { ...field, required: false } : field;
    out[field.key] = checkField(effective, data[field.key], '', issues);
  }

  if (issues.length > 0) {
    throw badRequest('FORM_VALIDATION_ERROR', 'فرم دارای خطاست.', { issues });
  }
  return out;
}
