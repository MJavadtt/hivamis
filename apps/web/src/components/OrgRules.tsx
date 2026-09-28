import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CUSTOM_RULE_KIND_LABELS, ROLE_LABELS, ROUTING_OPERATOR_LABELS, RULE_SOURCE_LABELS, describeCondition,
  type CustomRuleKind, type RoleCode, type RoutingCondition, type RoutingOperator,
} from '@hiva/contracts';
import { apiGet, apiPost, apiPut } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Select, Textarea, useToast } from './ui';
import { formatDateTime, toPersianDigits } from '../lib/format';

/*
 * Roadmap #47 — the rules on the workflows, by where they come from: Doc_H, installed extensions,
 * and the organisation's own, which it writes here without code. A rule adds a requirement or a
 * notice; it never removes one.
 */

interface FieldInfo { key: string; labelFa: string; type: 'number' | 'text' | 'date' | 'boolean' | 'days' | 'id'; enumValues?: string[] }
interface Vocabulary { entities: { entity: string; labelFa: string; transitions: { action: string; labelFa: string }[]; fields: FieldInfo[] }[] }
interface Rule {
  id: string; code: string; version: number; kind: CustomRuleKind; entity: string; action: string; labelFa: string; messageFa: string | null;
  when: RoutingCondition | null; notifyRoles: string[]; entityFa: string; transitionFa: string; whenFa: string | null;
  createdByName: string; createdAt: string; current: boolean; retiredAt: string | null;
}
type Leaf = { field: string; op: RoutingOperator; value?: number | string | string[] };
interface Draft { kind: CustomRuleKind; entity: string; action: string; labelFa: string; messageFa: string; join: 'all' | 'any'; leaves: Leaf[]; notifyRoles: string[] }

const OPS_BY_TYPE: Record<FieldInfo['type'], RoutingOperator[]> = {
  number: ['gte', 'gt', 'lte', 'lt', 'eq', 'ne', 'isSet', 'isEmpty', 'ltField', 'gtField'],
  days: ['lte', 'lt', 'gte', 'gt', 'isSet', 'isEmpty'],
  date: ['isSet', 'isEmpty'],
  boolean: ['isTrue', 'isFalse'],
  text: ['eq', 'ne', 'in', 'notIn', 'isSet', 'isEmpty', 'eqField', 'neField'],
  id: ['isSet', 'isEmpty', 'eqField', 'neField', 'eq', 'ne'],
};
const NO_VALUE: RoutingOperator[] = ['isSet', 'isEmpty', 'isTrue', 'isFalse'];
const FIELD_OPS: RoutingOperator[] = ['ltField', 'gtField', 'eqField', 'neField'];
const roleFa = (c: string) => ROLE_LABELS[c as RoleCode]?.fa ?? c;

/** The draft's condition in the rule language — a single leaf alone, several joined. */
export function conditionOf(d: Pick<Draft, 'join' | 'leaves'>): RoutingCondition | null {
  const leaves = d.leaves.filter((l) => l.field && l.op).map((l) => (NO_VALUE.includes(l.op) ? { field: l.field, op: l.op } : l)) as RoutingCondition[];
  if (!leaves.length) return null;
  return leaves.length === 1 ? leaves[0]! : d.join === 'all' ? { all: leaves } : { any: leaves };
}
const leavesOf = (c: RoutingCondition | null): { join: 'all' | 'any'; leaves: Leaf[] } => {
  if (!c) return { join: 'all', leaves: [] };
  if ('all' in c) return { join: 'all', leaves: c.all as Leaf[] };
  if ('any' in c) return { join: 'any', leaves: c.any as Leaf[] };
  return { join: 'all', leaves: [c as Leaf] };
};
const payloadOf = (d: Draft) => ({
  kind: d.kind, entity: d.entity, action: d.action, labelFa: d.labelFa.trim(), messageFa: d.messageFa.trim() || null,
  when: conditionOf(d), ...(d.kind === 'NOTIFY' ? { notifyRoles: d.notifyRoles } : {}),
});

export function OrgRules() {
  const { can } = useAuth();
  const [editing, setEditing] = useState<Rule | 'new' | null>(null);
  const [history, setHistory] = useState<string | null>(null);
  const [retiring, setRetiring] = useState<Rule | null>(null);
  const { data: rules } = useQuery<Rule[]>({ queryKey: ['/rules/custom'], queryFn: () => apiGet('/rules/custom') });
  const keeper = can('rules.manage');
  if (!rules) return null;
  return (
    <Card title="قوانین سازمان" subtitle="قانون‌هایی که سازمان خودش بر گردش کار گذاشته — بی‌کد. هر قانون شرطی می‌افزاید یا کسی را آگاه می‌کند؛ هیچ قانون Doc_H را برنمی‌دارد."
      action={keeper ? <Button size="sm" variant="primary" className="shrink-0 whitespace-nowrap" onClick={() => setEditing('new')}>قانون تازه</Button> : undefined}>
      {!rules.length ? <EmptyState title="هنوز قانونی تعریف نشده" description={keeper ? 'با «قانون تازه» شرطی بر یک انتقال بگذارید، یا بگویید چه کسی باید باخبر شود.' : undefined} /> : (
        <ul className="divide-y divide-ink-100" data-testid="org-rules">
          {rules.map((r) => (
            <li key={r.id} className="space-y-1 px-4 py-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="ltr text-xs text-ink-400">{r.code}</span>
                <Badge tone={r.kind === 'GUARD' ? 'warning' : 'info'}>{CUSTOM_RULE_KIND_LABELS[r.kind]}</Badge>
                <span className="font-medium text-ink-800">{r.labelFa}</span>
                <span className="text-xs text-ink-500">{r.entityFa} ← {r.transitionFa}</span>
                <span className="text-[11px] text-ink-400">نسخهٔ {toPersianDigits(r.version)} · {r.createdByName} · {formatDateTime(r.createdAt)}</span>
              </div>
              {r.whenFa && <p className="text-xs text-ink-600">{r.kind === 'GUARD' ? 'انتقال فقط وقتی مجاز است که ' : 'وقتی '}{r.whenFa}</p>}
              {r.kind === 'NOTIFY' && <p className="text-xs text-ink-600">آگاه می‌شوند: {r.notifyRoles.map(roleFa).join('، ')}</p>}
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => setHistory(r.code)}>نسخه‌ها</Button>
                {keeper && <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>نسخهٔ تازه</Button>}
                {keeper && <Button size="sm" variant="ghost" onClick={() => setRetiring(r)}>کنار گذاشتن</Button>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing && <RuleEditor rule={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {history && <RuleHistory code={history} onClose={() => setHistory(null)} />}
      {retiring && <RetireRule rule={retiring} onClose={() => setRetiring(null)} />}
    </Card>
  );
}

function RuleHistory({ code, onClose }: { code: string; onClose: () => void }) {
  const { data } = useQuery<Rule[]>({ queryKey: [`/rules/custom/${code}`], queryFn: () => apiGet(`/rules/custom/${code}`) });
  return (
    <Modal open title={`نسخه‌های ${code}`} onClose={onClose} footer={<Button variant="ghost" onClick={onClose}>بستن</Button>}>
      <ol className="space-y-2 text-sm" data-testid="rule-history">
        {data?.map((r) => (
          <li key={r.id} className="rounded-lg border border-ink-200 px-3 py-2">
            <p className="flex flex-wrap items-center gap-2"><span className="font-medium">نسخهٔ {toPersianDigits(r.version)}</span>{r.current ? <Badge tone="success">جاری</Badge> : <Badge tone="neutral">کنار رفته</Badge>}<span className="text-[11px] text-ink-400">{r.createdByName} · {formatDateTime(r.createdAt)}</span></p>
            <p className="text-xs">{r.labelFa}</p>
            {r.whenFa && <p className="text-xs text-ink-600">{r.whenFa}</p>}
          </li>
        ))}
      </ol>
    </Modal>
  );
}

function RetireRule({ rule, onClose }: { rule: Rule; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const retire = async () => {
    try { await apiPost(`/rules/custom/${rule.code}/retire`, { reason }); toast('قانون کنار گذاشته شد؛ نسخه‌هایش در سابقه می‌ماند.'); await qc.invalidateQueries({ queryKey: ['/rules/custom'] }); onClose(); }
    catch (e: any) { toast(e?.message ?? 'انجام نشد.', 'danger'); }
  };
  return (
    <Modal open title={`کنار گذاشتن «${rule.labelFa}»`} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>انصراف</Button><Button variant="danger" disabled={reason.trim().length < 5} onClick={() => void retire()}>کنار گذاشتن</Button></>}>
      <Field label="دلیل" required hint="در سابقهٔ قانون و رهگیری حسابرسی می‌ماند.">
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} aria-label="دلیل کنار گذاشتن" />
      </Field>
    </Modal>
  );
}

export function RuleEditor({ rule, onClose }: { rule: Rule | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: vocab } = useQuery<Vocabulary>({ queryKey: ['/rules/custom/vocabulary'], queryFn: () => apiGet('/rules/custom/vocabulary') });
  const [draft, setDraft] = useState<Draft>(() => ({
    kind: rule?.kind ?? 'GUARD', entity: rule?.entity ?? '', action: rule?.action ?? '', labelFa: rule?.labelFa ?? '',
    messageFa: rule?.messageFa ?? '', notifyRoles: rule?.notifyRoles ?? [], ...leavesOf(rule?.when ?? null),
  }));
  const [record, setRecord] = useState('');
  const [tried, setTried] = useState<{ verdictFa: string; holds: boolean; values: Record<string, unknown> } | null>(null);
  const [replayed, setReplayed] = useState<{ count: number; replayed: number; meaningFa: string; hits: { code: string | null }[]; assumptionFa: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!vocab) return null;
  const entity = vocab.entities.find((e) => e.entity === draft.entity) ?? vocab.entities[0]!;
  const fields = entity.fields;
  const action = draft.action || entity.transitions[0]?.action || '';
  const set = (patch: Partial<Draft>) => { setDraft({ ...draft, ...patch }); setTried(null); setReplayed(null); };
  const setLeaf = (i: number, patch: Partial<Leaf>) => set({ leaves: draft.leaves.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  const cond = conditionOf(draft);
  // What is shown is what is published: the workflow and transition the selectors display.
  const body = { ...payloadOf({ ...draft, entity: entity.entity, action }) };
  const ready = draft.labelFa.trim().length >= 3 && (draft.kind === 'NOTIFY' ? draft.notifyRoles.length > 0 : !!cond);
  const run = async (fn: () => Promise<void>) => { setBusy(true); try { await fn(); } catch (e: any) { toast(e?.message ?? 'انجام نشد.', 'danger'); } finally { setBusy(false); } };
  const publish = () => run(async () => {
    await (rule ? apiPut(`/rules/custom/${rule.code}`, body) : apiPost('/rules/custom', body));
    toast(rule ? `نسخهٔ ${toPersianDigits(rule.version + 1)} منتشر شد؛ نسخهٔ پیشین در سابقه می‌ماند.` : 'قانون منتشر شد و از همین حالا اجرا می‌شود.');
    await qc.invalidateQueries({ queryKey: ['/rules/custom'] });
    onClose();
  });
  return (
    <Modal open wide title={rule ? `نسخهٔ تازهٔ ${rule.code}` : 'قانون تازه'} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>انصراف</Button><Button variant="primary" loading={busy} disabled={!ready} onClick={() => void publish()}>{rule ? 'انتشار نسخهٔ تازه' : 'انتشار'}</Button></>}>
      <div className="space-y-3 text-sm" data-testid="rule-editor">
        <div className="grid gap-2 sm:grid-cols-3">
          <Field label="نوع">
            <Select value={draft.kind} onChange={(e) => set({ kind: e.target.value as CustomRuleKind })} aria-label="نوع قانون">
              <option value="GUARD">{CUSTOM_RULE_KIND_LABELS.GUARD} — انتقال را نگه می‌دارد</option>
              <option value="NOTIFY">{CUSTOM_RULE_KIND_LABELS.NOTIFY} — کسی را باخبر می‌کند</option>
            </Select>
          </Field>
          <Field label="گردش کار">
            <Select value={entity.entity} onChange={(e) => set({ entity: e.target.value, action: '', leaves: [] })} aria-label="گردش کار">
              {vocab.entities.map((e) => <option key={e.entity} value={e.entity}>{e.labelFa}</option>)}
            </Select>
          </Field>
          <Field label="انتقال">
            <Select value={action} onChange={(e) => set({ action: e.target.value })} aria-label="انتقال">
              {entity.transitions.map((t) => <option key={t.action} value={t.action}>{t.labelFa}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="نام قانون" required hint="در فهرست «چرا نمی‌توانم؟» و در دفتر استثناها همین دیده می‌شود.">
          <Input value={draft.labelFa} onChange={(e) => set({ labelFa: e.target.value })} aria-label="نام قانون" placeholder="مثلاً قرارداد بالای ۵ میلیارد ریال بازبین حقوقی دارد" />
        </Field>

        <section className="space-y-2 rounded-lg border border-ink-200 p-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium text-ink-700">{draft.kind === 'GUARD' ? 'انتقال فقط وقتی مجاز است که' : 'آگاه‌سازی فقط وقتی که (اختیاری)'}</span>
            {draft.leaves.length > 1 && (
              <Select value={draft.join} onChange={(e) => set({ join: e.target.value as 'all' | 'any' })} aria-label="ترکیب شرط‌ها" className="w-auto">
                <option value="all">همهٔ شرط‌ها برقرار باشند</option>
                <option value="any">دست‌کم یکی برقرار باشد</option>
              </Select>
            )}
          </div>
          {draft.leaves.map((l, i) => {
            const f = fields.find((x) => x.key === l.field);
            const ops = f ? OPS_BY_TYPE[f.type] : [];
            return (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <Select value={l.field} onChange={(e) => { const nf = fields.find((x) => x.key === e.target.value); setLeaf(i, { field: e.target.value, op: nf ? OPS_BY_TYPE[nf.type][0]! : 'isSet', value: undefined }); }} aria-label={`فیلد شرط ${toPersianDigits(i + 1)}`} className="w-auto">
                  {fields.map((x) => <option key={x.key} value={x.key}>{x.labelFa}</option>)}
                </Select>
                <Select value={l.op} onChange={(e) => setLeaf(i, { op: e.target.value as RoutingOperator, value: undefined })} aria-label={`سنجش شرط ${toPersianDigits(i + 1)}`} className="w-auto">
                  {ops.map((op) => <option key={op} value={op}>{ROUTING_OPERATOR_LABELS[op]}</option>)}
                </Select>
                {!NO_VALUE.includes(l.op) && (FIELD_OPS.includes(l.op) ? (
                  <Select value={String(l.value ?? '')} onChange={(e) => setLeaf(i, { value: e.target.value })} aria-label={`مقدار شرط ${toPersianDigits(i + 1)}`} className="w-auto">
                    <option value="">—</option>
                    {fields.filter((x) => x.key !== l.field).map((x) => <option key={x.key} value={x.key}>{x.labelFa}</option>)}
                  </Select>
                ) : f?.enumValues && (l.op === 'eq' || l.op === 'ne') ? (
                  <Select value={String(l.value ?? '')} onChange={(e) => setLeaf(i, { value: e.target.value })} aria-label={`مقدار شرط ${toPersianDigits(i + 1)}`} className="w-auto">
                    <option value="">—</option>
                    {f.enumValues.map((v) => <option key={v} value={v}>{v}</option>)}
                  </Select>
                ) : (
                  <Input value={Array.isArray(l.value) ? l.value.join('، ') : String(l.value ?? '')} aria-label={`مقدار شرط ${toPersianDigits(i + 1)}`} className="w-48"
                    placeholder={l.op === 'in' || l.op === 'notIn' ? 'چند مقدار، با ویرگول' : 'مقدار'}
                    onChange={(e) => {
                      const raw = e.target.value;
                      const value = l.op === 'in' || l.op === 'notIn' ? raw.split(/[,،]/).map((v) => v.trim()).filter(Boolean)
                        : f && (f.type === 'number' || f.type === 'days') && raw.trim() !== '' && Number.isFinite(Number(raw.replace(/[,٬\s]/g, ''))) ? Number(raw.replace(/[,٬\s]/g, '')) : raw;
                      setLeaf(i, { value });
                    }} />
                ))}
                <Button size="sm" variant="ghost" onClick={() => set({ leaves: draft.leaves.filter((_, j) => j !== i) })}>حذف</Button>
              </div>
            );
          })}
          <Button size="sm" variant="secondary" onClick={() => set({ leaves: [...draft.leaves, { field: fields[0]!.key, op: OPS_BY_TYPE[fields[0]!.type][0]! }] })}>افزودن شرط</Button>
          {cond && <p className="rounded bg-ink-50 px-2 py-1 text-xs text-ink-700" data-testid="rule-reading">{draft.kind === 'GUARD' ? 'انتقال فقط وقتی مجاز است که ' : 'آگاه‌سازی وقتی است که '}{describeCondition(cond, fields as never)}.</p>}
        </section>

        {draft.kind === 'NOTIFY' && (
          <Field label="چه نقش‌هایی آگاه شوند" required>
            <div className="flex flex-wrap gap-2" data-testid="notify-roles">
              {Object.keys(ROLE_LABELS).map((r) => (
                <label key={r} className="flex items-center gap-1 text-xs">
                  <input type="checkbox" checked={draft.notifyRoles.includes(r)} onChange={(e) => set({ notifyRoles: e.target.checked ? [...draft.notifyRoles, r] : draft.notifyRoles.filter((x) => x !== r) })} /> {roleFa(r)}
                </label>
              ))}
            </div>
          </Field>
        )}
        <Field label={draft.kind === 'GUARD' ? 'پیام به کسی که انتقال را می‌خواهد (اختیاری)' : 'متن آگاه‌سازی (اختیاری)'} hint={draft.kind === 'GUARD' ? 'اگر خالی بماند، خودِ شرط به فارسی گفته می‌شود.' : undefined}>
          <Textarea value={draft.messageFa} onChange={(e) => set({ messageFa: e.target.value })} rows={2} aria-label="پیام قانون" />
        </Field>

        <section className="space-y-2 rounded-lg bg-ink-50 p-3 text-xs" data-testid="rule-try">
          <p className="font-medium text-ink-700">پیش از انتشار بسنجید</p>
          <div className="flex flex-wrap items-center gap-2">
            <Input value={record} onChange={(e) => setRecord(e.target.value)} aria-label="کد رکورد برای آزمون" placeholder={`کد یک ${entity.labelFa}`} className="ltr w-40" />
            <Button size="sm" variant="secondary" disabled={!record.trim() || !cond} loading={busy} onClick={() => void run(async () => setTried(await apiPost('/rules/custom/test', { rule: body, recordId: record.trim() })))}>آزمون روی این رکورد</Button>
            <Button size="sm" variant="secondary" disabled={!cond} loading={busy} onClick={() => void run(async () => setReplayed(await apiPost('/rules/custom/replay', { rule: body })))}>سنجش روی سابقه</Button>
          </div>
          {tried && (
            <p className={tried.holds === (draft.kind === 'GUARD') ? 'text-emerald-700' : 'text-amber-800'} data-testid="rule-tried">
              {tried.verdictFa} — {Object.entries(tried.values).map(([k, v]) => `${fields.find((x) => x.key === k)?.labelFa ?? k}: ${v ?? '—'}`).join('، ')}
            </p>
          )}
          {replayed && (
            <p className="text-ink-700" data-testid="rule-replayed">
              از {toPersianDigits(replayed.replayed)} انتقالِ گذشته، {toPersianDigits(replayed.count)} مورد در شمار «{replayed.meaningFa}» بود
              {replayed.hits.length > 0 && <>: <span className="ltr">{replayed.hits.slice(0, 8).map((h) => h.code).filter(Boolean).join('، ')}</span></>}. <span className="text-ink-500">{replayed.assumptionFa}</span>
            </p>
          )}
        </section>
      </div>
    </Modal>
  );
}

interface Registry {
  extensions: { name: string; version: string; descriptionFa: string | null; guards: string[]; attachments: string[]; effects: string[] }[];
  guards: { key: string; labelFa: string; source: string; extension: string | null }[];
  attachments: { entity: string; action: string; transitionFa: string; guard: string; source: string; extension: string | null }[];
  effects: { key: string; labelFa: string; transitionFa: string; entity: string; extension: string | null }[];
  custom: number;
}

/** The rules that come as code: Doc_H's, and what installed extensions add. Read-only. */
export function CodeRules() {
  const { data } = useQuery<Registry>({ queryKey: ['/rules/registry'], queryFn: () => apiGet('/rules/registry') });
  if (!data) return null;
  const label = (key: string) => data.guards.find((g) => g.key === key)?.labelFa ?? key;
  const core = data.guards.filter((g) => g.source === 'core');
  return (
    <div className="space-y-5">
      <Card title="افزونه‌های نصب‌شده" subtitle="کدی که سازمان روی سامانه نصب کرده تا قانون‌هایی بیفزاید. نصب و برداشتن آن نسخهٔ تازه‌ای از قوانین می‌سازد.">
        {!data.extensions.length ? <EmptyState title="افزونه‌ای نصب نشده" description="مسئول فنی می‌تواند افزونه‌ها را در پوشهٔ EXTENSIONS_DIR بگذارد." /> : (
          <ul className="divide-y divide-ink-100 text-sm" data-testid="extensions">
            {data.extensions.map((e) => (
              <li key={e.name} className="space-y-1 px-4 py-3">
                <p className="flex flex-wrap items-center gap-2"><span className="ltr font-medium">{e.name}</span><Badge tone="neutral">{e.version}</Badge>{e.descriptionFa && <span className="text-xs text-ink-500">{e.descriptionFa}</span>}</p>
                {data.attachments.filter((a) => a.extension === e.name).map((a) => (
                  <p key={a.guard + a.action} className="text-xs text-ink-600">شرط «{label(a.guard)}» روی «{a.transitionFa}»</p>
                ))}
                {data.effects.filter((x) => x.extension === e.name).map((x) => (
                  <p key={x.key} className="text-xs text-ink-600">اثر «{x.labelFa}» پس از «{x.transitionFa}»</p>
                ))}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="قوانین Doc_H" subtitle={`${toPersianDigits(core.length)} قانون کنترلی که هستهٔ سامانه بر انتقال‌ها گذاشته است — ${RULE_SOURCE_LABELS.core}.`}>
        <ul className="grid gap-x-4 gap-y-1 px-4 py-3 text-xs text-ink-700 sm:grid-cols-2" data-testid="core-guards">
          {core.map((g) => <li key={g.key}>· {g.labelFa}</li>)}
        </ul>
      </Card>
    </div>
  );
}
