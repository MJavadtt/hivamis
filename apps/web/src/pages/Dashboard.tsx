import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../lib/api';
import { useAuth } from '../lib/auth';
import { PageBody, PageHeader } from '../components/Shell';
import { Count, HealthDot } from '../components/common';
import {
  Badge, Card, EmptyState, ErrorBlock, LoadingBlock, StateBadge, StatTile,
  Table, Td, Th, Tr, IconAlert, IconCheckCircle, IconClock, IconFile,
} from '../components/ui';
import { formatDate, formatRelative, toPersianDigits, daysFromNow } from '../lib/format';
import { REVISION_REASON_LABELS } from '@hiva/contracts';

interface MyDashboard {
  tasks: {
    items: { id: string; code: string; title: string; state: string; dueDate: string | null; project: { id: string; code: string; name: string } }[];
    total: number; overdue: number; dueThisWeek: number; awaitingAcceptance: number;
  };
  projects: { id: string; code: string; name: string; state: string; healthStatus: string; plannedEnd: string | null; company: { legalName: string } }[];
  forms: { mySubmissionsPending: number; awaitingMyApproval: number };
  revisions: { items: { id: string; code: string; reason: string; dueDate: string; deliverable: { name: string } | null }[]; overdue: number };
  sla: { items: { id: string; state: string; dueAt: string; policy: { labelFa: string } }[]; breached: number; atRisk: number };
  unreadNotifications: number;
}

export default function Dashboard() {
  const { user } = useAuth();
  const { data, isLoading, error, refetch } = useQuery<MyDashboard>({
    queryKey: ['/reports/my-dashboard'],
    queryFn: () => apiGet('/reports/my-dashboard'),
  });

  return (
    <>
      <PageHeader
        title={`سلام، ${user?.fullName ?? ''}`}
        subtitle={
          <span>
            {user?.department?.nameFa}
            {user?.jobTitle && ` — ${user.jobTitle}`}
          </span>
        }
      />
      <PageBody className="space-y-5">
        {isLoading ? (
          <LoadingBlock />
        ) : error ? (
          <ErrorBlock error={error} onRetry={() => void refetch()} />
        ) : data ? (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatTile
                label="وظایف باز من"
                value={<Count value={data.tasks.total} />}
                hint={data.tasks.dueThisWeek ? `${toPersianDigits(data.tasks.dueThisWeek)} مورد در این هفته` : 'مهلتی در این هفته نیست'}
                icon={<IconCheckCircle className="size-4" />}
              />
              <StatTile
                label="سررسید گذشته"
                value={<Count value={data.tasks.overdue} />}
                tone={data.tasks.overdue > 0 ? 'danger' : 'success'}
                hint={data.tasks.overdue > 0 ? 'نیازمند اقدام فوری' : 'همه در برنامه'}
                icon={<IconClock className="size-4" />}
              />
              <StatTile
                label="در انتظار تأیید من"
                value={<Count value={data.forms.awaitingMyApproval} />}
                tone={data.forms.awaitingMyApproval > 0 ? 'warning' : 'neutral'}
                hint="فرم‌های ارجاع‌شده"
                icon={<IconFile className="size-4" />}
              />
              <StatTile
                label="SLA در خطر / نقض‌شده"
                value={<Count value={data.sla.atRisk + data.sla.breached} />}
                tone={data.sla.breached > 0 ? 'danger' : data.sla.atRisk > 0 ? 'warning' : 'success'}
                hint={`${toPersianDigits(data.sla.breached)} نقض‌شده`}
                icon={<IconAlert className="size-4" />}
              />
            </div>

            <div className="grid gap-5 xl:grid-cols-3">
              <Card
                className="xl:col-span-2"
                title="وظایف من"
                subtitle="مرتب‌شده بر اساس نزدیک‌ترین مهلت"
                action={<Link to="/tasks" className="text-xs text-brand-600 hover:underline">همه وظایف</Link>}
              >
                {!data.tasks.items.length ? (
                  <EmptyState title="وظیفه بازی ندارید" description="وظایف تخصیص‌یافته اینجا نمایش داده می‌شوند." />
                ) : (
                  <Table>
                    <thead className="bg-ink-50/60">
                      <tr>
                        <Th>وظیفه</Th>
                        <Th>پروژه</Th>
                        <Th>مهلت</Th>
                        <Th>وضعیت</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.tasks.items.slice(0, 8).map((t) => {
                        const days = daysFromNow(t.dueDate);
                        return (
                          <Tr key={t.id}>
                            <Td>
                              <p className="font-medium text-ink-800">{t.title}</p>
                              <p className="ltr text-[11px] text-ink-400">{t.code}</p>
                            </Td>
                            <Td className="text-xs">
                              <Link to={`/projects/${t.project.id}`} className="text-brand-600 hover:underline">
                                {t.project.name}
                              </Link>
                            </Td>
                            <Td>
                              <span className={days !== null && days < 0 ? 'text-rose-600 font-medium' : ''}>
                                {formatDate(t.dueDate)}
                              </span>
                              <p className="text-[11px] text-ink-400">{formatRelative(t.dueDate)}</p>
                            </Td>
                            <Td><StateBadge state={t.state} /></Td>
                          </Tr>
                        );
                      })}
                    </tbody>
                  </Table>
                )}
              </Card>

              <div className="space-y-5">
                <Card title="اصلاحیه‌های من" subtitle={data.revisions.overdue ? `${toPersianDigits(data.revisions.overdue)} مورد سررسید گذشته` : undefined}>
                  {!data.revisions.items.length ? (
                    <EmptyState title="اصلاحیه بازی ندارید" />
                  ) : (
                    <ul className="divide-y divide-ink-100">
                      {data.revisions.items.slice(0, 5).map((r) => (
                        <li key={r.id} className="px-4 py-2.5">
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-sm text-ink-800">{r.deliverable?.name ?? 'خروجی'}</p>
                            {daysFromNow(r.dueDate)! < 0 && <Badge tone="danger">گذشته</Badge>}
                          </div>
                          <p className="mt-0.5 text-xs text-ink-500">
                            {REVISION_REASON_LABELS[r.reason] ?? r.reason} — مهلت {formatDate(r.dueDate)}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>

                <Card title="SLAهای من">
                  {!data.sla.items.length ? (
                    <EmptyState title="SLA فعالی ندارید" />
                  ) : (
                    <ul className="divide-y divide-ink-100">
                      {data.sla.items.slice(0, 6).map((s) => (
                        <li key={s.id} className="flex items-center justify-between gap-2 px-4 py-2.5">
                          <div className="min-w-0">
                            <p className="truncate text-sm text-ink-800">{s.policy.labelFa}</p>
                            <p className="text-[11px] text-ink-400">مهلت {formatRelative(s.dueAt)}</p>
                          </div>
                          <StateBadge state={s.state} />
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </div>
            </div>

            <Card title="پروژه‌های من" action={<Link to="/projects" className="text-xs text-brand-600 hover:underline">همه پروژه‌ها</Link>}>
              {!data.projects.length ? (
                <EmptyState title="پروژه فعالی ندارید" />
              ) : (
                <Table>
                  <thead className="bg-ink-50/60">
                    <tr>
                      <Th>پروژه</Th>
                      <Th>مشتری</Th>
                      <Th>وضعیت</Th>
                      <Th>سلامت</Th>
                      <Th>پایان برنامه‌ریزی‌شده</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.projects.map((p) => (
                      <Tr key={p.id}>
                        <Td>
                          <Link to={`/projects/${p.id}`} className="font-medium text-brand-600 hover:underline">
                            {p.name}
                          </Link>
                          <p className="ltr text-[11px] text-ink-400">{p.code}</p>
                        </Td>
                        <Td className="text-xs">{p.company?.legalName}</Td>
                        <Td><StateBadge state={p.state} /></Td>
                        <Td><HealthDot status={p.healthStatus} /></Td>
                        <Td className="text-xs">{formatDate(p.plannedEnd)}</Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
          </>
        ) : null}
      </PageBody>
    </>
  );
}
