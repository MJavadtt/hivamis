import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPatch, apiPost } from '../lib/api';
import { localDigits, sep } from '../lib/format';
import { Badge, Button, Card, EmptyState, ErrorBlock, Field, Input, LoadingBlock, Modal, Select, useToast } from './ui';
import { TeamTag, UnitTag, useTeams, useUnits, type Team, type Unit } from './UnitTag';
import { loc, tr } from '../i18n';

/**
 * The units the organisation runs (list 3, item 6). Doc_H's ten units stay — the process routes to
 * them — but here the administrator names them, chooses each one's manager, and divides a unit into
 * teams: «split Creative» is Creative with «طراحی» and «ویدئو» inside it.
 */

interface Person { id: string; fullName: string; department: { code: string } | null }

/** The unit's own people: the only ones who may manage it or lead a team in it. */
function usePeople() {
  return useQuery<Person[]>({ queryKey: ['/people', ''], queryFn: () => apiGet('/people') });
}

export function Units() {
  const { data: units, isLoading, error, refetch } = useUnits();
  const { data: teams } = useTeams();
  const [editing, setEditing] = useState<Unit | null>(null);
  const [teamFor, setTeamFor] = useState<{ unit: Unit; team?: Team } | null>(null);
  const qc = useQueryClient();
  const toast = useToast();

  const windUp = async (t: Team) => {
    if (!window.confirm(tr('تیم «{0}» بسته شود؟ اعضایش بی‌تیم می‌شوند و سابقه‌اش می‌ماند.', loc(t, 'name')))) return;
    try {
      const r = await apiPost<{ membersReleased: number }>(`/teams/${t.id}/archive`);
      toast(tr('تیم «{0}» بسته شد؛ {1} نفر بی‌تیم شدند.', loc(t, 'name'), localDigits(r.membersReleased)));
      await qc.invalidateQueries({ queryKey: ['/teams'] });
    } catch (e) { toast((e as Error).message, 'danger'); }
  };

  if (isLoading) return <LoadingBlock />;
  if (error) return <ErrorBlock error={error} onRetry={() => void refetch()} />;
  return (
    <Card title={tr('واحدها و تیم‌ها')} subtitle={tr('ده واحد Doc_H همان‌اند که فرآیند به آن‌ها می‌رود؛ نامشان، مدیرشان و تیم‌های درونشان با شماست.')}>
      {!units?.length ? <EmptyState title={tr('واحدی تعریف نشده')} /> : (
        <ul className="divide-y divide-ink-100" data-testid="units">
          {units.map((u) => {
            const own = (teams ?? []).filter((t) => t.departmentCode === u.code);
            return (
              <li key={u.code} className="space-y-2 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <UnitTag code={u.code} />
                  {u.namesOwned && <Badge tone="info">{tr('نام سازمان')}</Badge>}
                  <span className="text-xs text-ink-500">{tr('مدیر: {0}', u.manager?.fullName ?? '—')}</span>
                  <span className="text-xs text-ink-400">{tr('{0} نفر', localDigits(u._count?.users ?? 0))}</span>
                  <span className="ms-auto flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(u)}>{tr('ویرایش واحد')}</Button>
                    <Button size="sm" variant="ghost" onClick={() => setTeamFor({ unit: u })}>{tr('تیم تازه')}</Button>
                  </span>
                </div>
                {own.length > 0 && (
                  <ul className="flex flex-wrap gap-2 ps-2" data-testid={`teams-${u.code}`}>
                    {own.map((t) => (
                      <li key={t.id} className="flex items-center gap-1.5 rounded-lg bg-ink-50/60 px-2 py-1 text-xs">
                        <TeamTag team={t} />
                        <span className="text-ink-500">{t.lead ? tr('سرپرست: {0}', t.lead.fullName) : tr('بی‌سرپرست')}{sep()}{tr('{0} نفر', localDigits(t.members))}</span>
                        <Button size="sm" variant="ghost" onClick={() => setTeamFor({ unit: u, team: t })}>{tr('ویرایش')}</Button>
                        <Button size="sm" variant="ghost" onClick={() => void windUp(t)}>{tr('بستن')}</Button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {editing && <UnitEditor unit={editing} onClose={() => setEditing(null)} />}
      {teamFor && <TeamEditor unit={teamFor.unit} team={teamFor.team} onClose={() => setTeamFor(null)} />}
    </Card>
  );
}

function UnitEditor({ unit, onClose }: { unit: Unit; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: people } = usePeople();
  const [nameFa, setNameFa] = useState(unit.nameFa);
  const [nameEn, setNameEn] = useState(unit.nameEn);
  const [managerId, setManagerId] = useState(unit.managerId ?? '');
  const [busy, setBusy] = useState(false);
  const members = (people ?? []).filter((p) => p.department?.code === unit.code);
  const send = async (body: Record<string, unknown>, done: string) => {
    setBusy(true);
    try {
      await apiPatch(`/departments/${unit.code}`, body);
      toast(done);
      await qc.invalidateQueries({ queryKey: ['/departments'] });
      onClose();
    } catch (e) { toast((e as Error).message, 'danger'); } finally { setBusy(false); }
  };
  const renamed = nameFa.trim() !== unit.nameFa || nameEn.trim() !== unit.nameEn;
  return (
    <Modal open title={tr('ویرایش واحد «{0}»', loc(unit, 'name'))} onClose={onClose} footer={<>
      {unit.namesOwned && <Button variant="ghost" disabled={busy} onClick={() => void send({ nameFa: null }, tr('نام‌های اصلی واحد برگشت.'))}>{tr('بازگشت به نام‌های اصلی')}</Button>}
      <Button variant="ghost" onClick={onClose}>{tr('انصراف')}</Button>
      <Button variant="primary" loading={busy} disabled={nameFa.trim().length < 2}
        onClick={() => void send({ ...(renamed ? { nameFa: nameFa.trim(), nameEn: nameEn.trim() || undefined } : {}), managerId: managerId || null }, tr('واحد ذخیره شد.'))}>{tr('ذخیره')}</Button>
    </>}>
      <div className="space-y-3" data-testid="unit-editor">
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('نام فارسی')} required><Input value={nameFa} onChange={(e) => setNameFa(e.target.value)} /></Field>
          <Field label={tr('نام انگلیسی')}><Input value={nameEn} onChange={(e) => setNameEn(e.target.value)} className="ltr" /></Field>
        </div>
        <Field label={tr('مدیر واحد')} hint={tr('از کارکنان همین واحد. درخواست‌های تأیید و QC واحد به او می‌رسد.')}>
          <Select value={managerId} onChange={(e) => setManagerId(e.target.value)}>
            <option value="">—</option>
            {members.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
          </Select>
        </Field>
        <p className="text-[12.5px] text-ink-500">{tr('نامی که بگذارید با به‌روزرسانی سامانه عوض نمی‌شود؛ رمز واحد ({0}) و جایش در فرآیند همان می‌ماند.', unit.code)}</p>
      </div>
    </Modal>
  );
}

const SWATCHES = ['#4f46e5', '#0891b2', '#16a34a', '#ca8a04', '#ea580c', '#dc2626', '#9333ea', '#475569'];

function TeamEditor({ unit, team, onClose }: { unit: Unit; team?: Team; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: people } = usePeople();
  const [nameFa, setNameFa] = useState(team?.nameFa ?? '');
  const [nameEn, setNameEn] = useState(team?.nameEn ?? '');
  const [leadId, setLeadId] = useState(team?.lead?.id ?? '');
  const [color, setColor] = useState<string | null>(team?.color ?? null);
  const [busy, setBusy] = useState(false);
  const members = (people ?? []).filter((p) => p.department?.code === unit.code);
  const save = async () => {
    setBusy(true);
    const body = { nameFa: nameFa.trim(), nameEn: nameEn.trim(), leadId: leadId || null, color };
    try {
      if (team) await apiPatch(`/teams/${team.id}`, body); else await apiPost('/teams', { ...body, departmentCode: unit.code });
      toast(team ? tr('تیم «{0}» ذخیره شد.', body.nameFa) : tr('تیم «{0}» در «{1}» ساخته شد.', body.nameFa, loc(unit, 'name')));
      await qc.invalidateQueries({ queryKey: ['/teams'] });
      onClose();
    } catch (e) { toast((e as Error).message, 'danger'); } finally { setBusy(false); }
  };
  return (
    <Modal open title={team ? tr('ویرایش تیم «{0}»', loc(team, 'name')) : tr('تیم تازه در «{0}»', loc(unit, 'name'))} onClose={onClose} footer={<>
      <Button variant="ghost" onClick={onClose}>{tr('انصراف')}</Button>
      <Button variant="primary" loading={busy} disabled={nameFa.trim().length < 2} onClick={() => void save()}>{tr('ذخیره')}</Button>
    </>}>
      <div className="space-y-3" data-testid="team-editor">
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('نام فارسی')} required><Input value={nameFa} onChange={(e) => setNameFa(e.target.value)} /></Field>
          <Field label={tr('نام انگلیسی')}><Input value={nameEn} onChange={(e) => setNameEn(e.target.value)} className="ltr" /></Field>
        </div>
        <Field label={tr('سرپرست تیم')}>
          <Select value={leadId} onChange={(e) => setLeadId(e.target.value)}>
            <option value="">—</option>
            {members.map((p) => <option key={p.id} value={p.id}>{p.fullName}</option>)}
          </Select>
        </Field>
        <fieldset>
          <legend className="mb-1 text-xs font-bold text-ink-700">{tr('رنگ')}</legend>
          <div className="flex flex-wrap gap-1.5">
            <button type="button" aria-pressed={!color} onClick={() => setColor(null)} className="rounded-md px-2 py-1 text-xs ring-1 ring-inset ring-ink-200">{tr('بی‌رنگ')}</button>
            {SWATCHES.map((c) => (
              <button key={c} type="button" aria-pressed={color === c} aria-label={c} onClick={() => setColor(c)}
                className="size-7 rounded-md ring-offset-2 aria-pressed:ring-2 aria-pressed:ring-ink-900" style={{ backgroundColor: c }} />
            ))}
          </div>
        </fieldset>
      </div>
    </Modal>
  );
}
