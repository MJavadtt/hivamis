import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DEPARTMENT_CODES, DEPARTMENT_LABELS, type DepartmentCode } from '@hiva/contracts';
import { apiGet, apiPatch } from '../lib/api';
import { loc, pair, tr } from '../i18n';
import { Button, Checkbox, Field, Modal, Select, useToast } from './ui';
import type { PositionRow } from './Positions';
import { useTeams, useUnits } from './UnitTag';

/**
 * One person's unit, position and roles (audit F-3). A position's usual roles are offered when it is
 * chosen — ticked for the administrator to confirm, never granted unseen. Changing roles ends the
 * person's sessions, so the new permissions apply at once (audit SEC-3).
 */

export interface EditableUser { id: string; fullName: string; department?: { code: string } | null; positionId?: string | null; team?: { id: string } | null; roles?: { role: { code: string } }[] }
interface RoleOption { code: string; nameFa: string; nameEn: string; fullAccess?: boolean }

export function UserEditor({ user, onClose, onSaved }: { user: EditableUser; onClose: () => void; onSaved: () => Promise<unknown> }) {
  const toast = useToast();
  const { data: roles } = useQuery<RoleOption[]>({ queryKey: ['/roles'], queryFn: () => apiGet('/roles') });
  const { data: positions } = useQuery<PositionRow[]>({ queryKey: ['/positions'], queryFn: () => apiGet('/positions') });
  const { data: units } = useUnits();
  const { data: teams } = useTeams();
  const [unit, setUnit] = useState(user.department?.code ?? '');
  // A team of the person's unit (list 3, item 6); another unit's team does not travel with them.
  const [teamId, setTeamId] = useState(user.team?.id ?? '');
  const unitTeams = (teams ?? []).filter((t) => t.departmentCode === unit);
  const [positionId, setPositionId] = useState(user.positionId ?? '');
  const [picked, setPicked] = useState<string[]>((user.roles ?? []).map((r) => r.role.code));
  const [busy, setBusy] = useState(false);

  const choosePosition = (id: string) => {
    setPositionId(id);
    const p = positions?.find((x) => x.id === id);
    if (!p) return;
    // Its usual roles, offered: added to the ticks, for the administrator to keep or clear.
    setPicked((now) => [...new Set([...now, ...p.defaultRoleCodes])]);
    if (p.departmentCode && p.departmentCode !== unit) { setUnit(p.departmentCode); setTeamId(''); }
  };
  const save = async () => {
    setBusy(true);
    try {
      await apiPatch(`/users/${user.id}`, { departmentCode: unit || undefined, positionId: positionId || null, teamId: teamId || null, roleCodes: picked });
      toast(tr('اطلاعات «{0}» ذخیره شد.', user.fullName), 'success');
      await onSaved();
      onClose();
    } catch (e) {
      toast((e as Error).message, 'danger');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open title={tr('ویرایش «{0}»', user.fullName)} onClose={onClose}>
      <div className="space-y-3" data-testid="user-editor">
        <Field label={tr('سمت')}>
          <Select value={positionId} onChange={(e) => choosePosition(e.target.value)} aria-label={tr('سمت')}>
            <option value="">—</option>
            {(positions ?? []).map((p) => <option key={p.id} value={p.id}>{loc(p, 'name')}</option>)}
          </Select>
        </Field>
        <Field label={tr('واحد')}>
          <Select value={unit} onChange={(e) => { setUnit(e.target.value); setTeamId(''); }} aria-label={tr('واحد')}>
            {DEPARTMENT_CODES.map((c) => {
              const named = units?.find((u) => u.code === c);
              return <option key={c} value={c}>{named ? loc(named, 'name') : pair(DEPARTMENT_LABELS[c as DepartmentCode])}</option>;
            })}
          </Select>
        </Field>
        {unitTeams.length > 0 && (
          <Field label={tr('تیم')}>
            <Select value={teamId} onChange={(e) => setTeamId(e.target.value)} aria-label={tr('تیم')}>
              <option value="">—</option>
              {unitTeams.map((t) => <option key={t.id} value={t.id}>{loc(t, 'name')}</option>)}
            </Select>
          </Field>
        )}
        <fieldset>
          <legend className="mb-1 text-xs font-bold text-ink-700">{tr('نقش‌ها')}</legend>
          <div className="grid max-h-56 gap-1 overflow-y-auto sm:grid-cols-2">
            {(roles ?? []).map((r) => (
              <Checkbox key={r.code} label={loc(r, 'name')} checked={picked.includes(r.code)}
                onChange={(e) => setPicked((now) => e.target.checked ? [...now, r.code] : now.filter((x) => x !== r.code))} />
            ))}
          </div>
          <p className="mt-2 text-[12.5px] text-ink-500">{tr('با تغییر نقش‌ها، نشست‌های این نفر بسته می‌شود تا دسترسی تازه همان دم اعمال شود.')}</p>
        </fieldset>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>{tr('انصراف')}</Button>
          <Button variant="primary" onClick={() => void save()} loading={busy} disabled={!picked.length}>{tr('ذخیره')}</Button>
        </div>
      </div>
    </Modal>
  );
}
