import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../lib/api';
import { PageBody, PageHeader } from '../components/Shell';
import { Code } from '../components/common';
import {
  Badge, Card, EmptyState, ErrorBlock, Input, LoadingBlock, Select,
  Table, Tabs, Td, Th, Tr,
} from '../components/ui';
import { formatDateTime, toPersianDigits } from '../lib/format';
import { useAuth } from '../lib/auth';
import { WorkCalendars } from '../components/WorkCalendars';
import { RuleVersions } from '../components/RuleVersions';
import { RuleLab } from '../components/RuleLab';
import { FormRouting } from '../components/FormRouting';
import { FormDesigner } from '../components/FormDesigner';
import { SecurityAlerts } from '../components/SecurityAlerts';
import { ApiKeys, Webhooks } from '../components/Integrations';
import { MessengerAdmin } from '../components/Messenger';

export default function Admin() {
  const [tab, setTab] = useState('users');
  const { can } = useAuth();
  return (
    <>
      <PageHeader title="مدیریت سیستم" subtitle="کاربران، نقش‌ها، سیاست‌های SLA و رهگیری حسابرسی" />
      <div className="border-b border-ink-200 bg-surface px-2">
        <Tabs
          active={tab} onChange={setTab}
          tabs={[
            { key: 'users', label: 'کاربران' },
            { key: 'roles', label: 'نقش‌ها و دسترسی‌ها' },
            { key: 'sla', label: 'سیاست‌های SLA' },
            { key: 'calendar', label: 'تقویم کاری' },
            { key: 'rules', label: 'نسخه‌های قوانین' },
            { key: 'lab', label: 'آزمایشگاه قانون' },
            { key: 'designer', label: 'طراح فرم' },
            { key: 'routing', label: 'مسیریابی فرم‌ها' },
            { key: 'audit', label: 'رهگیری حسابرسی' },
            { key: 'security', label: 'هشدارهای امنیتی' },
            ...(can('admin.keys') ? [{ key: 'integrations', label: 'یکپارچه‌سازی' }] : []),
            { key: 'ai', label: 'گزارش عملیات هوش مصنوعی' },
          ]}
        />
      </div>
      <PageBody>
        {tab === 'users' && <Users />}
        {tab === 'roles' && <Roles />}
        {tab === 'sla' && <SlaPolicies />}
        {tab === 'calendar' && <WorkCalendars />}
        {tab === 'rules' && <RuleVersions />}
        {tab === 'lab' && <RuleLab />}
        {tab === 'designer' && <FormDesigner />}
        {tab === 'routing' && <FormRouting />}
        {tab === 'audit' && <AuditTrail />}
        {tab === 'security' && <SecurityAlerts />}
        {tab === 'integrations' && <div className="space-y-5"><ApiKeys /><Webhooks /><MessengerAdmin /></div>}
        {tab === 'ai' && <AiLog />}
      </PageBody>
    </>
  );
}

function Users() {
  const { can } = useAuth();
  const { data, isLoading, error, refetch } = useQuery<any>({
    queryKey: ['/users'], queryFn: () => apiGet('/users', { pageSize: 100 }),
  });
  if (isLoading) return <LoadingBlock />;
  if (error) return <ErrorBlock error={error} onRetry={() => void refetch()} />;

  // This page is reachable with admin.audit alone (CEO and Deputy hold it), but roles,
  // capacity, last sign-in and account status need admin.users and are simply absent from the
  // response otherwise. Render the columns the caller actually receives.
  const detailed = can('admin.users');

  return (
    <Card
      title="کاربران سازمان"
      subtitle={detailed ? undefined : 'برای مشاهده نقش‌ها و وضعیت حساب، دسترسی مدیریت کاربران لازم است.'}
    >
      <Table>
        <thead className="bg-ink-50/60">
          <tr>
            <Th>نام</Th><Th>ایمیل</Th><Th>واحد</Th>
            {detailed && <><Th>نقش‌ها</Th><Th>ظرفیت هفتگی</Th><Th>آخرین ورود</Th><Th>وضعیت</Th></>}
          </tr>
        </thead>
        <tbody>
          {data?.items.map((u: any) => (
            <Tr key={u.id}>
              <Td><p className="text-sm font-medium">{u.fullName}</p><p className="text-[11px] text-ink-400">{u.jobTitle}</p></Td>
              <Td className="ltr text-xs">{u.email}</Td>
              <Td className="text-xs">{u.department?.nameFa ?? '—'}</Td>
              {detailed && (
                <>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {(u.roles ?? []).map((r: any) => <Badge key={r.role.code} tone="progress">{r.role.nameFa}</Badge>)}
                    </div>
                  </Td>
                  <Td className="nums text-xs">{toPersianDigits(Number(u.weeklyCapacityHours ?? 0))} ساعت</Td>
                  <Td className="text-xs">{u.lastLoginAt ? formatDateTime(u.lastLoginAt) : '—'}</Td>
                  <Td>{u.isActive ? <Badge tone="success">فعال</Badge> : <Badge tone="neutral">غیرفعال</Badge>}</Td>
                </>
              )}
            </Tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

function Roles() {
  const { data, isLoading, error, refetch } = useQuery<any[]>({
    queryKey: ['/roles'], queryFn: () => apiGet('/roles'),
  });
  if (isLoading) return <LoadingBlock />;
  if (error) return <ErrorBlock error={error} onRetry={() => void refetch()} />;

  return (
    <div className="space-y-4">
      <p className="rounded-lg bg-ink-50 px-4 py-3 text-xs text-ink-600">
        دسترسی‌ها شکل ماشین‌خوانِ قوانین حاکم بر فرآیند هستند. برای مثال هیچ نقش فروشی مجوز
        <Code>pricing.set_price</Code> یا <Code>project.authorize</Code> ندارد — این تفکیک، قانون ۲ را در سطح دسترسی تضمین می‌کند.
      </p>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {data?.map((r) => (
          <Card key={r.id} title={r.nameFa} subtitle={r.code}
            action={<Badge tone="neutral">{toPersianDigits(r.userCount)} کاربر</Badge>}>
            <div className="max-h-56 overflow-y-auto p-3">
              <div className="flex flex-wrap gap-1">
                {r.permissions.slice(0, 60).map((p: string) => (
                  <span key={p} className="ltr rounded bg-ink-100 px-1.5 py-0.5 font-mono text-[10px] text-ink-600">{p}</span>
                ))}
              </div>
              {r.permissions.length > 60 && (
                <p className="mt-2 text-xs text-ink-400">و {toPersianDigits(r.permissions.length - 60)} دسترسی دیگر…</p>
              )}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

function SlaPolicies() {
  const { data, isLoading, error, refetch } = useQuery<any[]>({
    queryKey: ['/sla-policies'], queryFn: () => apiGet('/sla-policies'),
  });
  if (isLoading) return <LoadingBlock />;
  if (error) return <ErrorBlock error={error} onRetry={() => void refetch()} />;

  return (
    <Card title="سیاست‌های SLA" subtitle="مهلت‌ها بر حسب ساعت کاری و مطابق تقویم سازمان محاسبه می‌شوند">
      <Table>
        <thead className="bg-ink-50/60">
          <tr><Th>عنوان</Th><Th>کد</Th><Th>مهلت</Th><Th>آستانه هشدار</Th><Th>مرجع Doc_H</Th><Th>وضعیت</Th></tr>
        </thead>
        <tbody>
          {data?.map((p) => (
            <Tr key={p.id}>
              <Td className="text-sm">{p.labelFa}</Td>
              <Td><Code>{p.code}</Code></Td>
              <Td className="nums text-xs">{toPersianDigits(Number(p.hours))} ساعت کاری</Td>
              <Td className="nums text-xs">{toPersianDigits(Math.round(Number(p.warnAt) * 100))}٪</Td>
              <Td className="text-xs text-ink-500">{p.docRef}</Td>
              <Td>{p.isActive ? <Badge tone="success">فعال</Badge> : <Badge tone="neutral">غیرفعال</Badge>}</Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

const ACTION_LABELS: Record<string, string> = {
  CREATE: 'ایجاد', UPDATE: 'ویرایش', DELETE: 'حذف', STATE_TRANSITION: 'تغییر وضعیت',
  APPROVE: 'تأیید', REJECT: 'رد', LOGIN: 'ورود', LOGIN_FAILED: 'ورود ناموفق',
  LOGOUT: 'خروج', PERMISSION_DENIED: 'دسترسی رد شد', AI_ACTION: 'عملیات هوش مصنوعی',
  FILE_UPLOAD: 'بارگذاری فایل', FILE_DOWNLOAD: 'دریافت فایل', FILE_VIEW: 'مشاهدهٔ فایل', EXPORT: 'خروجی‌گیری',
};

function AuditTrail() {
  const [entityType, setEntityType] = useState('');
  const [action, setAction] = useState('');
  const { data, isLoading, error, refetch } = useQuery<any>({
    queryKey: ['/audit-events', entityType, action],
    queryFn: () => apiGet('/audit-events', {
      pageSize: 100, entityType: entityType || undefined, action: action || undefined,
    }),
  });

  return (
    <Card
      title="رهگیری حسابرسی"
      subtitle="هر تغییر مهم: چه کسی، چه چیزی، چه زمانی، قبل، بعد و چرا"
      action={
        <div className="flex gap-2">
          <Select value={action} onChange={(e) => setAction(e.target.value)} className="w-auto text-xs">
            <option value="">همه اقدامات</option>
            {Object.entries(ACTION_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
          <Input value={entityType} onChange={(e) => setEntityType(e.target.value)} placeholder="نوع موجودیت" className="w-32 text-xs" />
        </div>
      }
    >
      {isLoading ? <LoadingBlock /> : error ? <ErrorBlock error={error} onRetry={() => void refetch()} /> : (
        <Table>
          <thead className="bg-ink-50/60">
            <tr><Th>زمان</Th><Th>کاربر</Th><Th>اقدام</Th><Th>موجودیت</Th><Th>تغییر</Th><Th>دلیل</Th></tr>
          </thead>
          <tbody>
            {data?.items.map((e: any) => (
              <Tr key={e.id}>
                <Td className="whitespace-nowrap text-xs">{formatDateTime(e.createdAt)}</Td>
                <Td className="text-xs">{e.actor?.fullName ?? 'سیستم'}</Td>
                <Td><Badge tone={e.action === 'PERMISSION_DENIED' || e.action === 'LOGIN_FAILED' ? 'danger'
                  : e.action === 'APPROVE' ? 'success' : 'neutral'}>
                  {ACTION_LABELS[e.action] ?? e.action}
                </Badge></Td>
                <Td className="text-xs"><Code>{e.entityType}</Code></Td>
                <Td className="text-xs">
                  {e.before?.state && e.after?.state
                    ? <span className="ltr">{e.before.state} → {e.after.state}</span>
                    : e.after ? <span className="text-ink-400">—</span> : '—'}
                </Td>
                <Td className="max-w-xs truncate text-xs text-ink-500">{e.reason ?? '—'}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function AiLog() {
  const { data, isLoading, error, refetch } = useQuery<any>({
    queryKey: ['/ai/interactions'], queryFn: () => apiGet('/ai/interactions', { pageSize: 50 }),
  });
  if (isLoading) return <LoadingBlock />;
  if (error) return <ErrorBlock error={error} onRetry={() => void refetch()} />;

  return (
    <Card title="گزارش عملیات هوش مصنوعی" subtitle="هر فراخوانی هوش مصنوعی با کاربر، دامنه و مستندات پشتیبان ثبت می‌شود">
      {!data?.items.length ? <EmptyState title="عملیاتی ثبت نشده" /> : (
        <Table>
          <thead className="bg-ink-50/60">
            <tr><Th>زمان</Th><Th>کاربر</Th><Th>قابلیت</Th><Th>مدل</Th><Th>موجودیت</Th><Th>نتیجه</Th></tr>
          </thead>
          <tbody>
            {data.items.map((i: any) => (
              <Tr key={i.id}>
                <Td className="whitespace-nowrap text-xs">{formatDateTime(i.createdAt)}</Td>
                <Td className="text-xs">{i.user?.fullName}</Td>
                <Td><Code>{i.capability}</Code></Td>
                <Td className="ltr text-xs">{i.model}</Td>
                <Td className="text-xs">{i.entityType ?? '—'}</Td>
                <Td>{i.succeeded ? <Badge tone="success">موفق</Badge> : <Badge tone="danger">ناموفق</Badge>}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
