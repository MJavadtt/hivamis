import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiGet, apiPost } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useLocale } from '../lib/locale';
import { formatDateTime } from '../lib/format';
import { Badge, Button, Card, ErrorBlock, Field, Input, LoadingBlock, useToast } from '../components/ui';
import { PageBody, PageHeader } from '../components/Shell';
import { Avatar } from '../components/Avatar';
import { UnitTag, useUnits } from '../components/UnitTag';
import { goToGoogleLink } from './People';
import { tr, trx } from '../i18n';
import { roleName, useRoles } from '../lib/roles';

/**
 * One's own page (Hivamis task 4): who one is here, and the ways in — a password, a mobile proved by
 * a code, a Google account — with the devices currently signed in. At least one way in always stays.
 */

interface MyProfile {
  id: string; phone: string | null; phoneVerified: boolean; hasPassword: boolean;
  identities: { id: string; provider: string; email: string | null; createdAt: string; lastUsedAt: string | null }[];
  sessions: { id: string; userAgent: string | null; ipAddress: string | null; createdAt: string; current: boolean }[];
  available: { phone: boolean; google: boolean };
}

const device = (ua: string | null) =>
  !ua ? tr('مرورگر') : /iPhone|iPad/.test(ua) ? tr('آیفون/آیپد') : /Android/.test(ua) ? tr('اندروید') : /Macintosh/.test(ua) ? tr('مک') : /Windows/.test(ua) ? tr('ویندوز') : tr('مرورگر');

export default function Me() {
  useRoles(); // names an organisation's own roles too (audit F-3)
  const { user } = useAuth();
  const { data: units } = useUnits();
  const { data, isLoading, error, refetch } = useQuery<MyProfile>({ queryKey: ['/me/profile'], queryFn: () => apiGet('/me/profile') });
  const toast = useToast();

  // Back from linking Google.
  useEffect(() => {
    const back = new URLSearchParams(window.location.hash.slice(1));
    if (back.get('linked')) toast(tr('حساب گوگل وصل شد.'));
    if (back.get('error') === 'LINKED_ELSEWHERE') toast(tr('این حساب گوگل به حساب دیگری در هیوامیس وصل است.'), 'danger');
    else if (back.get('error') === 'DOMAIN') toast(tr('حساب‌های گوگلِ این دامنه در این سازمان پذیرفته نیستند؛ با حساب گوگل کاری‌تان وارد شوید.'), 'danger');
    else if (back.get('error') === 'GOOGLE_BROWSER') toast(tr('این ورود در مرورگر دیگری آغاز شده است؛ از همین مرورگر دوباره با گوگل وارد شوید.'), 'danger');
    else if (back.get('error')) toast(tr('وصل کردن حساب گوگل انجام نشد.'), 'danger');
    if (window.location.hash) history.replaceState(null, '', window.location.pathname);
  }, [toast]);

  if (isLoading || !user) return <LoadingBlock />;
  if (error || !data) return <ErrorBlock error={error} onRetry={() => void refetch()} />;
  const unit = units?.find((u) => u.code === user.department?.code);

  return (
    <>
      <PageHeader title={tr('صفحهٔ من')} subtitle={tr('روش‌های ورود و دستگاه‌هایی که با آن‌ها وارد شده‌اید')} />
      <PageBody>
        <div className="space-y-5" data-testid="me">
          <Card>
            <div className="flex flex-wrap items-center gap-4 p-5">
              <Avatar name={user.fullName} unit={user.department?.code} color={unit?.color} size="lg" />
              {/* A floor for the name's column, so on a phone the link wraps below it rather than squeezing it to a word a line (audit UI-V). */}
              <div className="min-w-[11rem] flex-1">
                <p className="text-lg font-semibold text-ink-900">{user.fullName}</p>
                <p className="text-sm text-ink-600">{trx(user.jobTitle)}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {user.department && <UnitTag code={user.department.code} />}
                  {user.roles.map((r) => <Badge key={r} tone="neutral">{roleName(r)}</Badge>)}
                </div>
              </div>
              <Link to={`/people/${user.id}`} className="text-sm text-brand-700 underline">{tr('صفحهٔ من از دید همکاران')}</Link>
            </div>
          </Card>
          <div className="grid gap-5 lg:grid-cols-2">
            <WaysIn profile={data} />
            <Devices profile={data} />
          </div>
          <Preferences />
        </div>
      </PageBody>
    </>
  );
}

function WaysIn({ profile }: { profile: MyProfile }) {
  const qc = useQueryClient();
  const toast = useToast();
  const reload = () => qc.invalidateQueries({ queryKey: ['/me/profile'] });
  const ways = (profile.hasPassword ? 1 : 0) + (profile.phoneVerified ? 1 : 0) + profile.identities.length;
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); toast(ok); await reload(); } catch (e) { toast((e as Error).message, 'danger'); }
  };
  const google = profile.identities.filter((i) => i.provider === 'google');

  return (
    <Card tour="ways-in" title={tr('روش‌های ورود')} subtitle={tr('دست‌کم یک روش همیشه می‌ماند.')}>
      <div className="divide-y divide-ink-100">
        <section className="p-4" data-testid="way-password">
          <p className="mb-2 text-sm font-medium text-ink-800">{tr('ایمیل و رمز عبور')}{' '}{profile.hasPassword ? <Badge tone="success">{tr('فعال')}</Badge> : <Badge tone="neutral">{tr('گذاشته نشده')}</Badge>}</p>
          <PasswordForm hasPassword={profile.hasPassword} onDone={() => void reload()} />
        </section>

        <section className="p-4" data-testid="way-phone">
          <p className="mb-2 text-sm font-medium text-ink-800">
            {tr('شمارهٔ همراه')}{' '}
            {profile.phoneVerified ? <Badge tone="success">{tr('تأییدشده')}</Badge> : <Badge tone="neutral">{tr('تأیید نشده')}</Badge>}
          </p>
          {profile.phoneVerified && (
            <p className="mb-2 flex items-center gap-2 text-sm text-ink-700">
              <span className="ltr">{profile.phone}</span>
              <Button size="sm" variant="ghost" disabled={ways <= 1} title={ways <= 1 ? tr('این تنها راه ورود شماست') : undefined}
                onClick={() => void run(() => apiDelete('/me/phone'), tr('ورود با شمارهٔ همراه برداشته شد.'))}>{tr('برداشتن')}</Button>
            </p>
          )}
          {profile.available.phone
            ? <PhoneForm current={profile.phone} onDone={() => void reload()} />
            : <p className="text-xs text-ink-500">{tr('ارسال پیامک در این نصب فعال نیست.')}</p>}
        </section>

        <section className="p-4" data-testid="way-google">
          <p className="mb-2 text-sm font-medium text-ink-800">{tr('حساب گوگل')}</p>
          {google.map((g) => (
            <p key={g.id} className="mb-2 flex items-center gap-2 text-sm text-ink-700">
              <span className="ltr">{g.email}</span>
              {g.lastUsedAt && <span className="text-[12.5px] text-ink-400">{tr('آخرین ورود {0}', formatDateTime(g.lastUsedAt))}</span>}
              <Button size="sm" variant="ghost" disabled={ways <= 1} title={ways <= 1 ? tr('این تنها راه ورود شماست') : undefined}
                onClick={() => void run(() => apiDelete(`/me/identities/${g.id}`), tr('حساب گوگل جدا شد.'))}>{tr('جدا کردن')}</Button>
            </p>
          ))}
          {profile.available.google
            ? !google.length && <Button size="sm" variant="secondary" onClick={() => void goToGoogleLink().catch((e) => toast((e as Error).message, 'danger'))}>{tr('وصل کردن حساب گوگل')}</Button>
            : !google.length && <p className="text-xs text-ink-500">{tr('ورود با گوگل در این نصب پیکربندی نشده است.')}</p>}
        </section>
      </div>
    </Card>
  );
}

function PasswordForm({ hasPassword, onDone }: { hasPassword: boolean; onDone: () => void }) {
  const toast = useToast();
  const { signOut } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const strong = next.length >= 12 && /[a-z]/.test(next) && /[A-Z]/.test(next) && /[0-9]/.test(next);
  const save = async () => {
    setBusy(true);
    try {
      if (hasPassword) {
        await apiPost('/auth/change-password', { currentPassword: current, newPassword: next });
        toast(tr('رمز عوض شد؛ همهٔ دستگاه‌ها باید دوباره وارد شوند.'));
        await signOut();
      } else {
        await apiPost('/me/password', { newPassword: next });
        toast(tr('رمز گذاشته شد؛ از این پس با ایمیل و همین رمز هم می‌توانید وارد شوید.'));
        setNext(''); onDone();
      }
    } catch (e) { toast((e as Error).message, 'danger'); } finally { setBusy(false); }
  };
  return (
    <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
      {hasPassword && <Field label={tr('رمز فعلی')}><Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" className="ltr" /></Field>}
      <Field label={hasPassword ? tr('رمز تازه') : tr('رمز عبور')} hint={tr('دست‌کم ۱۲ نویسه، با حرف کوچک، حرف بزرگ و عدد لاتین')}>
        <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" className="ltr" />
      </Field>
      <Button size="sm" variant="secondary" loading={busy} disabled={!strong || (hasPassword && !current)} onClick={() => void save()}>
        {hasPassword ? tr('عوض کردن رمز') : tr('گذاشتن رمز')}
      </Button>
    </div>
  );
}

function PhoneForm({ current, onDone }: { current: string | null; onDone: () => void }) {
  const toast = useToast();
  const [phone, setPhone] = useState(current ?? '');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } catch (e) { toast((e as Error).message, 'danger'); } finally { setBusy(false); }
  };
  return (
    <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
      <Field label={sent ? tr('کد پیامک‌شده') : tr('شمارهٔ همراه برای ورود')}>
        {sent
          ? <Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} className="ltr text-center tracking-[0.4em]" aria-label={tr('کد پیامک‌شده')} />
          : <Input type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} className="ltr" placeholder="0912 123 4567" aria-label={tr('شمارهٔ همراه برای ورود')} />}
      </Field>
      {sent ? (
        <Button size="sm" variant="primary" loading={busy} disabled={code.length < 6}
          onClick={() => void run(async () => { await apiPost('/me/phone/verify', { phone, code }); toast(tr('شمارهٔ همراه تأیید شد؛ از این پس با آن هم وارد می‌شوید.')); setSent(false); setCode(''); onDone(); })}>
          {tr('تأیید')}
        </Button>
      ) : (
        <Button size="sm" variant="secondary" loading={busy} disabled={!phone.trim()}
          onClick={() => void run(async () => { await apiPost('/me/phone/start', { phone }); setSent(true); })}>
          {tr('فرستادن کد')}
        </Button>
      )}
    </div>
  );
}

function Devices({ profile }: { profile: MyProfile }) {
  const qc = useQueryClient();
  const toast = useToast();
  const reload = () => qc.invalidateQueries({ queryKey: ['/me/profile'] });
  const others = profile.sessions.filter((s) => !s.current).length;
  return (
    <Card tour="devices" title={tr('دستگاه‌های واردشده')} subtitle={tr('هر دستگاهی که نمی‌شناسید را خارج کنید.')}
      action={others > 0 ? <Button size="sm" variant="ghost" onClick={async () => { try { await apiPost('/me/sessions/revoke-others'); toast(tr('دستگاه‌های دیگر خارج شدند.')); await reload(); } catch (e) { toast((e as Error).message, 'danger'); } }}>{tr('خروج همهٔ دستگاه‌های دیگر')}</Button> : undefined}>
      <ul className="divide-y divide-ink-100" data-testid="devices">
        {profile.sessions.map((s) => (
          <li key={s.id} className="flex items-center gap-3 px-4 py-3 text-sm">
            <div className="min-w-0 flex-1">
              <p className="font-medium text-ink-800">{device(s.userAgent)}{s.current && <Badge tone="success" className="ms-2">{tr('همین دستگاه')}</Badge>}</p>
              <p className="text-[12.5px] text-ink-500"><span className="ltr">{s.ipAddress}</span>{' · '}{tr('از {0}', formatDateTime(s.createdAt))}</p>
            </div>
            {!s.current && (
              <Button size="sm" variant="ghost" onClick={async () => { try { await apiDelete(`/me/sessions/${s.id}`); toast(tr('دستگاه خارج شد.')); await reload(); } catch (e) { toast((e as Error).message, 'danger'); } }}>{tr('خروج')}</Button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Preferences() {
  const { locale, setLocale } = useLocale();
  return (
    <Card title={tr('زبان')}>
      <div className="flex flex-wrap items-center gap-2 p-4">
        <Button size="sm" variant={locale === 'fa' ? 'primary' : 'secondary'} onClick={() => void setLocale('fa')}>فارسی</Button>
        <Button size="sm" variant={locale === 'en' ? 'primary' : 'secondary'} onClick={() => void setLocale('en')}>English</Button>
      </div>
    </Card>
  );
}
