import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError, apiDelete, apiGet, apiPatch, apiPost } from '../lib/api';
import { localDigits } from '../lib/format';
import { loc, tr } from '../i18n';
import { Button, Field, Input, Modal, Select, Textarea, useToast } from './ui';

/**
 * Roles the organisation makes (audit F-3): from scratch or as a copy of another's permissions,
 * renamed, recoloured, deleted when nothing names them any more. The code's roles keep their names
 * and stay; for another name, the administrator makes a role from one of them.
 */

export interface RoleSummary { code: string; nameFa: string; nameEn: string; description?: string | null; color?: string | null; custom?: boolean }

const PALETTE = ['#7a69f2', '#3f84e8', '#0e9f6e', '#d97706', '#e11d48', '#0891b2', '#7c3aed', '#64748b'];

/** A new role, or the names and colour of an existing one of the organisation's own. */
export function RoleForm({ roles, editing, copyFrom, onClose, onSaved }: {
  roles: RoleSummary[]; editing?: RoleSummary; copyFrom?: string; onClose: () => void; onSaved: (code: string) => void | Promise<unknown>;
}) {
  const toast = useToast();
  const [nameFa, setNameFa] = useState(editing?.nameFa ?? '');
  const [nameEn, setNameEn] = useState(editing?.nameEn ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [color, setColor] = useState(editing?.color ?? PALETTE[0]!);
  const [from, setFrom] = useState(copyFrom ?? '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const body = { nameFa: nameFa.trim(), nameEn: nameEn.trim(), description: description.trim() || null, color };
      const saved = editing
        ? await apiPatch<RoleSummary>(`/roles/${editing.code}`, body)
        : await apiPost<RoleSummary>('/roles', { ...body, copyFrom: from || null });
      toast(editing ? tr('نقش «{0}» ذخیره شد.', saved.nameFa) : tr('نقش «{0}» ساخته شد.', saved.nameFa), 'success');
      await onSaved(saved.code);
      onClose();
    } catch (e) {
      toast((e as Error).message, 'danger');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open title={editing ? tr('ویرایش نقش') : tr('نقش تازه')} onClose={onClose}>
      <div className="space-y-3" data-testid="role-form">
        <Field label={tr('نام')} required><Input value={nameFa} onChange={(e) => setNameFa(e.target.value)} maxLength={80} autoFocus /></Field>
        <Field label={tr('نام انگلیسی')}><Input value={nameEn} onChange={(e) => setNameEn(e.target.value)} maxLength={80} dir="ltr" /></Field>
        <Field label={tr('توضیح')}><Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} /></Field>
        <Field label={tr('رنگ')}>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={tr('رنگ')}>
            {PALETTE.map((c) => (
              <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={c} onClick={() => setColor(c)}
                className={`size-7 rounded-full ring-2 ring-offset-2 ${color === c ? 'ring-ink-700' : 'ring-transparent'}`} style={{ backgroundColor: c }} />
            ))}
          </div>
        </Field>
        {!editing && (
          <Field label={tr('دسترسی‌ها از روی')} hint={tr('نقش تازه همان دسترسی‌هایی را می‌گیرد که آن نقش اکنون در این سازمان دارد؛ بعد می‌توانید کم و زیادشان کنید.')}>
            <Select value={from} onChange={(e) => setFrom(e.target.value)}>
              <option value="">{tr('هیچ — از صفر')}</option>
              {roles.map((r) => <option key={r.code} value={r.code}>{loc(r, 'name')}</option>)}
            </Select>
          </Field>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>{tr('انصراف')}</Button>
          <Button variant="primary" onClick={() => void save()} loading={busy} disabled={nameFa.trim().length < 2}>{editing ? tr('ذخیره') : tr('ساختن')}</Button>
        </div>
      </div>
    </Modal>
  );
}

const REFERENCES: [string, string][] = [
  ['holders', tr('{0} نفر این نقش را دارند')],
  ['delegations', tr('{0} تفویض در جریان آن را نام می‌برد')],
  ['forms', tr('{0} فرم آن را تأییدکننده می‌داند')],
  ['pendingSubmissions', tr('{0} فرم ثبت‌شده منتظر آن است')],
  ['rules', tr('{0} قانون سازمان به آن خبر می‌دهد')],
];

/** Delete, after asking; if something still names it, say what. */
export function DeleteRole({ role, onClose, onDeleted }: { role: RoleSummary; onClose: () => void; onDeleted: () => void | Promise<unknown> }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [refs, setRefs] = useState<Record<string, number> | null>(null);
  const go = async () => {
    setBusy(true);
    try {
      await apiDelete(`/roles/${role.code}`);
      toast(tr('نقش «{0}» حذف شد.', role.nameFa), 'success');
      await onDeleted();
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.body.code === 'ROLE_IN_USE') setRefs(e.body.details as Record<string, number>);
      else toast((e as Error).message, 'danger');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open title={tr('حذف نقش «{0}»', role.nameFa)} onClose={onClose}>
      <div className="space-y-3" data-testid="delete-role">
        {refs ? (
          <>
            <p className="text-sm text-ink-700">{tr('این نقش هنوز به کار رفته است؛ اول این‌ها را از آن جدا کنید:')}</p>
            <ul className="list-inside list-disc text-sm text-ink-700" data-testid="role-references">
              {REFERENCES.filter(([k]) => (refs[k] ?? 0) > 0).map(([k, text]) => <li key={k}>{text.replace('{0}', localDigits(refs[k]!))}</li>)}
            </ul>
          </>
        ) : (
          <p className="text-sm text-ink-700">{tr('نقش و دسترسی‌هایش حذف می‌شوند؛ سابقهٔ دسترسی‌هایش در رهگیری حسابرسی می‌ماند.')}</p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>{refs ? tr('بستن') : tr('انصراف')}</Button>
          {!refs && <Button variant="danger" onClick={() => void go()} loading={busy}>{tr('حذف')}</Button>}
        </div>
      </div>
    </Modal>
  );
}

/** Who holds the role here. */
export function RoleHolders({ code }: { code: string }) {
  const { data } = useQuery<{ id: string; fullName: string; jobTitle: string | null; isActive: boolean }[]>({
    queryKey: [`/roles/${code}/holders`], queryFn: () => apiGet(`/roles/${code}/holders`),
  });
  if (!data) return null;
  if (!data.length) return <p className="px-4 py-3 text-xs text-ink-500">{tr('کسی این نقش را ندارد.')}</p>;
  return (
    <ul className="divide-y divide-ink-100 px-4 text-sm" data-testid="role-holders">
      {data.map((u) => (
        <li key={u.id} className="flex items-center justify-between gap-2 py-2">
          <span className="text-ink-800">{u.fullName}</span>
          <span className="text-xs text-ink-500">{u.jobTitle ?? ''}{u.isActive ? '' : tr(' — غیرفعال')}</span>
        </li>
      ))}
    </ul>
  );
}
