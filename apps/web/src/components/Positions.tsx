import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DEPARTMENT_CODES, DEPARTMENT_LABELS } from '@hiva/contracts';
import { apiGet, apiPatch, apiPost } from '../lib/api';
import { localDigits } from '../lib/format';
import { loc, pair, tr } from '../i18n';
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Select, Table, Td, Th, Tr, useToast } from './ui';

/**
 * The organisation's positions (audit F-3): each job title once, in a unit, with the roles it
 * usually brings. Renamed here, renamed on everyone who holds it; archived, no longer given.
 */

export interface PositionRow { id: string; nameFa: string; nameEn: string; departmentCode: string | null; defaultRoleCodes: string[]; archived: boolean; holders: number }
interface RoleOption { code: string; nameFa: string; nameEn: string }

export function Positions() {
  const qc = useQueryClient();
  const { data } = useQuery<PositionRow[]>({ queryKey: ['/positions', 'all'], queryFn: () => apiGet('/positions', { all: '1' }) });
  const { data: roles } = useQuery<RoleOption[]>({ queryKey: ['/roles'], queryFn: () => apiGet('/roles') });
  const [editing, setEditing] = useState<PositionRow | 'new' | null>(null);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['/positions'] }), qc.invalidateQueries({ queryKey: ['/users'] })]);
  const roleName = (code: string) => { const r = roles?.find((x) => x.code === code); return r ? loc(r, 'name') : code; };

  return (
    <Card title={tr('سمت‌ها')} subtitle={tr('عنوان شغلی هر نفر از همین فهرست می‌آید؛ تغییر نام یک سمت، عنوان همهٔ دارندگانش را عوض می‌کند.')}
      action={<Button size="sm" variant="secondary" onClick={() => setEditing('new')} data-testid="new-position">{tr('سمت تازه')}</Button>}>
      {!data?.length ? <EmptyState title={tr('سمتی تعریف نشده')} /> : (
        <Table>
          <thead className="bg-ink-50/60"><tr><Th>{tr('سمت')}</Th><Th>{tr('واحد')}</Th><Th>{tr('نقش‌های معمول')}</Th><Th>{tr('دارندگان')}</Th><Th /></tr></thead>
          <tbody data-testid="positions">
            {data.map((p) => (
              <Tr key={p.id}>
                <Td><span className="text-sm font-medium text-ink-800">{loc(p, 'name')}</span>{p.archived && <Badge tone="neutral" className="ms-2">{tr('بایگانی')}</Badge>}</Td>
                <Td className="text-xs">{p.departmentCode ? pair(DEPARTMENT_LABELS[p.departmentCode as keyof typeof DEPARTMENT_LABELS]) : '—'}</Td>
                <Td><div className="flex flex-wrap gap-1">{p.defaultRoleCodes.map((c) => <Badge key={c} tone="progress">{roleName(c)}</Badge>)}</div></Td>
                <Td className="nums text-xs">{localDigits(p.holders)}</Td>
                <Td><Button size="sm" variant="ghost" onClick={() => setEditing(p)}>{tr('ویرایش')}</Button></Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
      {editing && <PositionForm position={editing === 'new' ? undefined : editing} roles={roles ?? []} onClose={() => setEditing(null)} onSaved={refresh} />}
    </Card>
  );
}

function PositionForm({ position, roles, onClose, onSaved }: { position?: PositionRow; roles: RoleOption[]; onClose: () => void; onSaved: () => Promise<unknown> }) {
  const toast = useToast();
  const [nameFa, setNameFa] = useState(position?.nameFa ?? '');
  const [nameEn, setNameEn] = useState(position?.nameEn ?? '');
  const [unit, setUnit] = useState(position?.departmentCode ?? '');
  const [defaults, setDefaults] = useState<string[]>(position?.defaultRoleCodes ?? []);
  const [busy, setBusy] = useState(false);
  const save = async (extra: Record<string, unknown> = {}) => {
    setBusy(true);
    try {
      const body = { nameFa: nameFa.trim(), nameEn: nameEn.trim(), departmentCode: unit || null, defaultRoleCodes: defaults, ...extra };
      if (position) await apiPatch(`/positions/${position.id}`, body); else await apiPost('/positions', body);
      await onSaved();
      onClose();
    } catch (e) {
      toast((e as Error).message, 'danger');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open title={position ? tr('ویرایش سمت') : tr('سمت تازه')} onClose={onClose}>
      <div className="space-y-3" data-testid="position-form">
        <Field label={tr('عنوان')} required><Input value={nameFa} onChange={(e) => setNameFa(e.target.value)} maxLength={120} autoFocus /></Field>
        <Field label={tr('عنوان انگلیسی')}><Input value={nameEn} onChange={(e) => setNameEn(e.target.value)} maxLength={120} dir="ltr" /></Field>
        <Field label={tr('واحد')}>
          <Select value={unit} onChange={(e) => setUnit(e.target.value)}>
            <option value="">—</option>
            {DEPARTMENT_CODES.map((c) => <option key={c} value={c}>{pair(DEPARTMENT_LABELS[c])}</option>)}
          </Select>
        </Field>
        <fieldset>
          <legend className="mb-1 text-xs font-bold text-ink-700">{tr('نقش‌های معمول این سمت')}</legend>
          <p className="mb-2 text-[12.5px] text-ink-500">{tr('وقتی این سمت به کسی داده شود، پیشنهاد می‌شوند؛ بی‌تأیید داده نمی‌شوند.')}</p>
          <div className="grid max-h-48 gap-1 overflow-y-auto sm:grid-cols-2">
            {roles.map((r) => (
              <label key={r.code} className="flex items-center gap-2 text-xs text-ink-700">
                <input type="checkbox" checked={defaults.includes(r.code)} onChange={(e) => setDefaults((d) => e.target.checked ? [...d, r.code] : d.filter((x) => x !== r.code))} />
                {loc(r, 'name')}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="flex flex-wrap justify-end gap-2">
          {position && <Button variant="ghost" onClick={() => void save({ archived: !position.archived })} disabled={busy}>{position.archived ? tr('بازگرداندن از بایگانی') : tr('بایگانی')}</Button>}
          <Button variant="secondary" onClick={onClose}>{tr('انصراف')}</Button>
          <Button variant="primary" onClick={() => void save()} loading={busy} disabled={nameFa.trim().length < 2}>{tr('ذخیره')}</Button>
        </div>
      </div>
    </Modal>
  );
}
