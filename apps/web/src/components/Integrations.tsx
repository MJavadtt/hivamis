import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPatch, apiPost } from '../lib/api';
import { Badge, Button, Card, Checkbox, EmptyState, Field, Input, Modal, Table, Td, Th, Tr, useToast } from './ui';
import { formatDateTime, toPersianDigits } from '../lib/format';

/* Roadmap #46 — identities for systems, and events sent to them. */

interface ApiKeyRow {
  id: string; name: string; display: string; permissions: string[]; rateLimitPerMinute: number; expiresAt: string | null;
  lastUsedAt: string | null; lastUsedIp: string | null; status: 'ACTIVE' | 'REVOKED' | 'EXPIRED' | 'OWNER_INACTIVE';
  revokeReason: string | null; createdAt: string; createdBy: { fullName: string };
}
const KEY_STATUS: Record<ApiKeyRow['status'], [string, 'success' | 'neutral' | 'danger' | 'warning']> = {
  ACTIVE: ['فعال', 'success'], REVOKED: ['باطل‌شده', 'danger'], EXPIRED: ['منقضی', 'neutral'], OWNER_INACTIVE: ['سازنده غیرفعال', 'warning'],
};

/** Shown once: after this dialog closes the secret exists only where it was copied to. */
function OnceSecret({ title, secret, note, onClose }: { title: string; secret: string; note: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Modal open title={title} onClose={onClose} footer={<Button variant="primary" onClick={onClose}>ذخیره کردم</Button>}>
      <p className="mb-2 text-xs text-amber-800">{note}</p>
      <div className="flex items-center gap-2">
        <code className="ltr flex-1 break-all rounded-lg bg-ink-50 px-3 py-2 text-xs" data-testid="once-secret">{secret}</code>
        <Button size="sm" variant="secondary" onClick={() => { void navigator.clipboard?.writeText(secret); setCopied(true); }}>{copied ? 'کپی شد' : 'کپی'}</Button>
      </div>
    </Modal>
  );
}

export function ApiKeys() {
  const { data } = useQuery<ApiKeyRow[]>({ queryKey: ['/admin/api-keys'], queryFn: () => apiGet('/admin/api-keys') });
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const revoke = async (k: ApiKeyRow) => {
    const reason = window.prompt(`دلیل ابطال «${k.name}»`);
    if (!reason) return;
    try { await apiPost(`/admin/api-keys/${k.id}/revoke`, { reason }); toast('کلید باطل شد؛ از همین لحظه کار نمی‌کند.'); await qc.invalidateQueries({ queryKey: ['/admin/api-keys'] }); }
    catch (e: any) { toast(e?.message ?? 'ابطال ناموفق بود.', 'danger'); }
  };
  return (
    <Card title="کلیدهای API" subtitle="هر کلید با اختیار سازنده‌اش کار می‌کند، محدود به دسترسی‌هایی که به آن داده شده؛ هرگز بیش از اختیار امروز سازنده، و با سهمیهٔ درخواست خودش."
      action={<Button size="sm" variant="primary" onClick={() => setCreating(true)}>کلید تازه</Button>}>
      {!data?.length ? <EmptyState title="کلیدی ساخته نشده" /> : (
        <Table>
          <thead className="bg-ink-50/60"><tr><Th>نام</Th><Th>کلید</Th><Th>دسترسی‌ها</Th><Th>سهمیه</Th><Th>آخرین استفاده</Th><Th>وضعیت</Th><Th /></tr></thead>
          <tbody data-testid="api-keys">
            {data.map((k) => (
              <Tr key={k.id}>
                <Td className="text-xs">{k.name}<p className="text-[10px] text-ink-400">{k.createdBy.fullName}</p></Td>
                <Td className="ltr text-xs">{k.display}</Td>
                <Td className="text-xs" title={k.permissions.join('، ')}>{toPersianDigits(k.permissions.length)} دسترسی</Td>
                <Td className="text-xs">{toPersianDigits(k.rateLimitPerMinute)} در دقیقه</Td>
                <Td className="text-xs">{k.lastUsedAt ? <>{formatDateTime(k.lastUsedAt)}<span className="ltr block text-[10px] text-ink-400">{k.lastUsedIp}</span></> : 'هرگز'}</Td>
                <Td><Badge tone={KEY_STATUS[k.status][1]}>{KEY_STATUS[k.status][0]}</Badge>{k.revokeReason && <p className="text-[10px] text-ink-400">{k.revokeReason}</p>}</Td>
                <Td>{k.status === 'ACTIVE' && <Button size="sm" variant="ghost" onClick={() => void revoke(k)}>ابطال</Button>}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
      {creating && <NewKey onClose={(secret) => { setCreating(false); if (secret) setRevealed(secret); }} />}
      {revealed && <OnceSecret title="کلید ساخته شد" secret={revealed} note="این کلید فقط همین یک بار نمایش داده می‌شود و فقط هش آن نگه داشته می‌شود. آن را در سامانهٔ گیرنده ذخیره کنید؛ اگر گم شد، ابطالش کنید و کلید تازه بسازید." onClose={() => setRevealed(null)} />}
    </Card>
  );
}

function NewKey({ onClose }: { onClose: (secret?: string) => void }) {
  const { data: grantable } = useQuery<{ code: string; labelFa: string }[]>({ queryKey: ['/admin/api-keys/grantable'], queryFn: () => apiGet('/admin/api-keys/grantable') });
  const [name, setName] = useState('');
  const [rate, setRate] = useState('60');
  const [picked, setPicked] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const qc = useQueryClient();
  const shown = (grantable ?? []).filter((g) => !filter || g.labelFa.includes(filter) || g.code.includes(filter));
  const save = async () => {
    setBusy(true);
    try {
      const r = await apiPost<{ key: string }>('/admin/api-keys', { name, permissions: picked, rateLimitPerMinute: Number(rate) });
      await qc.invalidateQueries({ queryKey: ['/admin/api-keys'] }); onClose(r.key);
    } catch (e: any) { toast(e?.message ?? 'ساخت کلید ناموفق بود.', 'danger'); } finally { setBusy(false); }
  };
  return (
    <Modal open wide title="کلید API تازه" onClose={() => onClose()}
      footer={<><Button variant="ghost" onClick={() => onClose()}>انصراف</Button><Button variant="primary" loading={busy} disabled={name.trim().length < 3 || !picked.length} onClick={() => void save()}>ساخت</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="نام (برای کدام سامانه)" required><Input value={name} onChange={(e) => setName(e.target.value)} aria-label="نام کلید" /></Field>
        <Field label="سهمیه در دقیقه"><Input type="number" value={rate} onChange={(e) => setRate(e.target.value)} className="ltr" aria-label="سهمیه" /></Field>
      </div>
      <Field label={`دسترسی‌ها (${toPersianDigits(picked.length)} انتخاب‌شده)`} hint="فقط آنچه خودتان به نام خود دارید؛ مدیریت کاربران، نقش‌ها، کلیدها و استثناها به کلید داده نمی‌شود.">
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="جستجو در دسترسی‌ها" aria-label="جستجوی دسترسی" />
      </Field>
      <div className="mt-2 grid max-h-64 gap-1 overflow-y-auto sm:grid-cols-2" data-testid="grantable">
        {shown.map((g) => (
          <Checkbox key={g.code} checked={picked.includes(g.code)} label={<span className="text-xs">{g.labelFa} <span className="ltr text-[10px] text-ink-400">{g.code}</span></span>}
            onChange={(e) => setPicked(e.target.checked ? [...picked, g.code] : picked.filter((p) => p !== g.code))} />
        ))}
      </div>
    </Modal>
  );
}

/* ── Webhooks ──────────────────────────────────────────────────────────── */

interface WebhookRow {
  id: string; name: string; url: string; secret: string; events: string[]; active: boolean; consecutiveFailures: number;
  disabledReason: string | null; createdBy: { fullName: string }; deliveries: Record<string, number>;
}

export function Webhooks() {
  const { data } = useQuery<WebhookRow[]>({ queryKey: ['/admin/webhooks'], queryFn: () => apiGet('/admin/webhooks') });
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [log, setLog] = useState<WebhookRow | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const refresh = () => qc.invalidateQueries({ queryKey: ['/admin/webhooks'] });
  const ping = async (w: WebhookRow) => {
    const r = await apiPost<{ ok: boolean; status: number | null; error: string | null }>(`/admin/webhooks/${w.id}/test`, {});
    toast(r.ok ? `گیرنده پاسخ داد (${toPersianDigits(r.status ?? 0)}).` : `ناموفق: ${r.error}`, r.ok ? 'success' : 'danger');
    await refresh();
  };
  const toggle = async (w: WebhookRow) => { await apiPatch(`/admin/webhooks/${w.id}`, { active: !w.active }); await refresh(); };
  return (
    <Card title="Webhook" subtitle="رویدادهای گذار وضعیت، امضاشده با HMAC، به نشانی‌ای که تعیین می‌کنید — فقط رویدادهایی که سازنده اجازهٔ دیدنشان را دارد، و فقط شناسه و گذار، نه خود رکورد."
      action={<Button size="sm" variant="primary" onClick={() => setCreating(true)}>Webhook تازه</Button>}>
      {!data?.length ? <EmptyState title="Webhook‌ای تعریف نشده" /> : (
        <Table>
          <thead className="bg-ink-50/60"><tr><Th>نام</Th><Th>نشانی</Th><Th>رویدادها</Th><Th>تحویل‌ها</Th><Th>وضعیت</Th><Th /></tr></thead>
          <tbody data-testid="webhooks">
            {data.map((w) => (
              <Tr key={w.id}>
                <Td className="text-xs">{w.name}<p className="text-[10px] text-ink-400">{w.createdBy.fullName}</p></Td>
                <Td className="ltr max-w-[14rem] truncate text-xs" title={w.url}>{w.url}</Td>
                <Td className="ltr text-[11px]">{w.events.join(', ')}</Td>
                <Td className="text-[11px]">
                  {toPersianDigits(w.deliveries.DELIVERED ?? 0)} موفق · {toPersianDigits(w.deliveries.PENDING ?? 0)} در صف · {toPersianDigits(w.deliveries.DEAD ?? 0)} رهاشده
                </Td>
                <Td>
                  {w.active ? <Badge tone={w.consecutiveFailures ? 'warning' : 'success'}>{w.consecutiveFailures ? `فعال — ${toPersianDigits(w.consecutiveFailures)} خطای پیاپی` : 'فعال'}</Badge> : <Badge tone="danger">غیرفعال</Badge>}
                  {w.disabledReason && <p className="text-[10px] text-ink-400">{w.disabledReason}</p>}
                </Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    <Button size="sm" variant="ghost" onClick={() => void ping(w)}>آزمایش</Button>
                    <Button size="sm" variant="ghost" onClick={() => setLog(w)}>تحویل‌ها</Button>
                    <Button size="sm" variant="ghost" onClick={() => void toggle(w)}>{w.active ? 'توقف' : 'فعال‌سازی'}</Button>
                  </div>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
      {creating && <NewWebhook onClose={(secret) => { setCreating(false); if (secret) setRevealed(secret); }} />}
      {revealed && <OnceSecret title="Webhook ساخته شد" secret={revealed} note="این رمز امضا فقط همین یک بار نمایش داده می‌شود. گیرنده با آن امضای X-Hiva-Signature را بررسی می‌کند: HMAC-SHA256 روی «timestamp.body»." onClose={() => setRevealed(null)} />}
      {log && <DeliveryLog webhook={log} onClose={() => setLog(null)} />}
    </Card>
  );
}

function NewWebhook({ onClose }: { onClose: (secret?: string) => void }) {
  const { data: catalog } = useQuery<{ event: string; entity: string; entityLabelFa: string; labelFa: string; allowed: boolean }[]>({ queryKey: ['/admin/webhooks/events'], queryFn: () => apiGet('/admin/webhooks/events') });
  const [v, setV] = useState({ name: '', url: 'https://' });
  const [events, setEvents] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const qc = useQueryClient();
  const entities = [...new Map((catalog ?? []).map((e) => [e.entity, e])).values()];
  const toggle = (e: string, on: boolean) => setEvents(on ? [...events, e] : events.filter((x) => x !== e));
  const save = async () => {
    setBusy(true);
    try {
      const r = await apiPost<{ secret: string }>('/admin/webhooks', { ...v, events });
      await qc.invalidateQueries({ queryKey: ['/admin/webhooks'] }); onClose(r.secret);
    } catch (e: any) {
      toast([e?.message, ...((e?.body?.details?.problems as string[]) ?? [])].filter(Boolean).join(' — '), 'danger');
    } finally { setBusy(false); }
  };
  return (
    <Modal open wide title="Webhook تازه" onClose={() => onClose()}
      footer={<><Button variant="ghost" onClick={() => onClose()}>انصراف</Button><Button variant="primary" loading={busy} disabled={v.name.trim().length < 3 || !events.length} onClick={() => void save()}>ساخت</Button></>}>
      <div className="grid gap-3">
        <Field label="نام" required><Input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} aria-label="نام Webhook" /></Field>
        <Field label="نشانی گیرنده (https)" required hint="نشانی‌های شبکهٔ داخلی پذیرفته نمی‌شوند."><Input value={v.url} onChange={(e) => setV({ ...v, url: e.target.value })} className="ltr" aria-label="نشانی" /></Field>
        <Field label="رویدادها" hint="همهٔ گذارهای یک موجودیت، یا گذارهای مشخص.">
          <div className="max-h-72 space-y-2 overflow-y-auto" data-testid="event-picker">
            {entities.map((ent) => {
              const all = `${ent.entity}.*`;
              const own = (catalog ?? []).filter((e) => e.entity === ent.entity);
              return (
                <div key={ent.entity} className={ent.allowed ? '' : 'opacity-50'}>
                  <Checkbox checked={events.includes(all)} disabled={!ent.allowed} onChange={(e) => toggle(all, e.target.checked)}
                    label={<span className="text-xs font-medium">{ent.entityLabelFa} — همهٔ گذارها{!ent.allowed && ' (بدون دسترسی دیدن)'}</span>} />
                  {!events.includes(all) && ent.allowed && (
                    <div className="ms-6 flex flex-wrap gap-x-3">
                      {own.map((e) => <Checkbox key={e.event} checked={events.includes(e.event)} onChange={(x) => toggle(e.event, x.target.checked)} label={<span className="text-[11px]">{e.labelFa}</span>} />)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Field>
      </div>
    </Modal>
  );
}

function DeliveryLog({ webhook, onClose }: { webhook: WebhookRow; onClose: () => void }) {
  const qc = useQueryClient();
  const { data } = useQuery<any[]>({ queryKey: ['/admin/webhooks', webhook.id, 'deliveries'], queryFn: () => apiGet(`/admin/webhooks/${webhook.id}/deliveries`) });
  const redeliver = async (id: string) => { await apiPost(`/admin/webhooks/deliveries/${id}/redeliver`, {}); await qc.invalidateQueries({ queryKey: ['/admin/webhooks', webhook.id, 'deliveries'] }); };
  return (
    <Modal open wide title={`تحویل‌های «${webhook.name}»`} onClose={onClose} footer={<Button variant="ghost" onClick={onClose}>بستن</Button>}>
      {!data?.length ? <EmptyState title="تحویلی نبوده" /> : (
        <Table>
          <thead className="bg-ink-50/60"><tr><Th>رویداد</Th><Th>زمان</Th><Th>تلاش</Th><Th>نتیجه</Th><Th /></tr></thead>
          <tbody data-testid="deliveries">
            {data.map((d) => (
              <Tr key={d.id}>
                <Td className="ltr text-xs">{d.event}</Td>
                <Td className="text-xs">{formatDateTime(d.createdAt)}</Td>
                <Td className="text-xs">{toPersianDigits(d.attempts)}</Td>
                <Td className="text-xs">
                  <Badge tone={d.status === 'DELIVERED' ? 'success' : d.status === 'DEAD' ? 'danger' : 'warning'}>{d.status === 'DELIVERED' ? 'تحویل شد' : d.status === 'DEAD' ? 'رها شد' : 'در صف'}</Badge>
                  {d.lastError && <p className="ltr text-[10px] text-ink-400">{d.lastError}</p>}
                </Td>
                <Td>{d.status !== 'DELIVERED' && <Button size="sm" variant="ghost" onClick={() => void redeliver(d.id)}>ارسال دوباره</Button>}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </Modal>
  );
}
