/**
 * The form designer (roadmap #15).
 *
 * ADR-004 said adding a form is a data change rather than a code change, and the data has
 * always been there — `form_definitions.schema` is a JSON field list. In practice a programmer
 * still had to write TypeScript, which made every new customer a development project. This is
 * the half that was missing: the same `FieldDef` shape, written through an API and a screen.
 *
 * Two rules keep that from becoming a way to break the process:
 *  - A field the *process* depends on cannot be removed or retyped. Those are the required
 *    fields of the shipped definition — Doc_H §C's nine order elements, the keys a typed
 *    binding reads — and they are derived from the catalogue rather than listed by hand.
 *  - Every change mints a version (#16), so submissions already filed keep their own fields.
 */
import { FORM_BY_CODE, checkFieldList, type FieldDef } from '@hiva/contracts';
import type { Tx } from '../db.js';
import { badRequest } from '../lib/errors.js';

export interface DesignerField extends FieldDef {}

/**
 * Keys the process itself relies on: the required fields of the catalogue's own definition.
 * A form the organisation invented has none, and is theirs to shape as they like.
 */
export function protectedKeys(code: string): { key: string; labelFa: string; type: string }[] {
  const shipped = FORM_BY_CODE.get(code);
  if (!shipped) return [];
  const out: { key: string; labelFa: string; type: string }[] = [];
  for (const f of shipped.fields) {
    if (f.required) out.push({ key: f.key, labelFa: f.labelFa, type: f.type });
  }
  // A bound form's handler reads its own keys; the required set covers them, and the binding is
  // named in the message so an administrator knows why the field cannot go.
  return out;
}

/** Everything wrong with a proposed field list, in Persian, all at once rather than one at a time. */
export function validateDesign(
  code: string,
  fields: DesignerField[],
  opts: { binding?: string | null; isCustom?: boolean } = {},
): string[] {
  const problems = checkFieldList(fields as never);
  if (!opts.isCustom) {
    const present = new Map(fields.map((f) => [f.key, f]));
    for (const must of protectedKeys(code)) {
      const field = present.get(must.key);
      if (!field) {
        problems.push(`فیلد «${must.labelFa}» (${must.key}) جزء عناصر الزامی این فرم در Doc_H است و حذف‌شدنی نیست${opts.binding ? ` — این فرم رکورد «${opts.binding}» می‌سازد` : ''}`);
      } else if (field.type !== must.type) {
        problems.push(`نوع فیلد «${must.labelFa}» باید ${must.type} بماند؛ فرآیند به همان نوع تکیه دارد`);
      } else if (!field.required) {
        problems.push(`فیلد «${must.labelFa}» باید الزامی بماند`);
      }
    }
  }
  return problems;
}

/** Replace a definition's fields, minting a version. Throws with every problem at once. */
export async function saveDesign(
  tx: Tx,
  input: { code: string; fields: DesignerField[]; note?: string; actorId: string; organizationId: string },
) {
  const def = await tx.formDefinition.findFirst({ where: { code: input.code, organizationId: input.organizationId } });
  if (!def) throw badRequest('FORM_NOT_FOUND', 'تعریف فرم یافت نشد');
  const problems = validateDesign(input.code, input.fields, { binding: def.binding, isCustom: def.isCustom });
  if (problems.length) throw badRequest('INVALID_FORM_DESIGN', 'طراحی فرم ایراد دارد', { problems });

  const version = def.version + 1;
  const schema = input.fields as unknown as object;
  const updated = await tx.formDefinition.update({
    where: { id: def.id },
    data: { schema, version, customizedAt: new Date(), customizedById: input.actorId },
  });
  await tx.formDefinitionVersion.create({
    data: {
      definitionId: def.id, version, schema, routing: def.routing as object, approvalChain: def.approvalChain as object,
      nameFa: def.nameFa, note: input.note ?? 'ویرایش در طراح فرم', createdById: input.actorId,
    },
  });
  return { definition: updated, version, before: def };
}

/** The lowest free catalogue number for a form the organisation adds itself. */
export async function nextCustomNumber(tx: Tx, organizationId: string): Promise<number> {
  const top = await tx.formDefinition.findFirst({
    where: { organizationId, no: { gte: 1000 } }, orderBy: { no: 'desc' }, select: { no: true },
  });
  return Math.max(1000, (top?.no ?? 999) + 1);
}
