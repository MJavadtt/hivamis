import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../lib/api';
import { useAuth } from '../lib/auth';
import { PageBody, PageHeader } from '../components/Shell';
import { Count, HealthDot } from '../components/common';
import {
  Badge, Card, EmptyState, ErrorBlock, LoadingBlock, StateBadge, StatTile,
  Table, Tabs, Td, Th, Tr, IconAlert, IconCheckCircle, IconClock, IconFile,
} from '../components/ui';
import { formatCurrency, formatDate, formatRelative, localDigits, daysFromNow } from '../lib/format';
import { REVISION_REASON_LABELS } from '@hiva/contracts';
import { flow, loc, tr, trx } from '../i18n';
import { HalfGauge } from '../components/Gauge';

interface MyDashboard {
  tasks: {
    items: { id: string; code: string; title: string; state: string; dueDate: string | null; project: { id: string; code: string; name: string } }[];
    total: number; overdue: number; dueThisWeek: number; awaitingAcceptance: number;
  };
  projects: { id: string; code: string; name: string; state: string; healthStatus: string; plannedEnd: string | null; company: { legalName: string } }[];
  /** The opportunities I own and have not yet won or lost; null when the pipeline is not mine to see. */
  opportunities: { id: string; code: string; title: string; state: string; estimatedValue: string; expectedCloseDate: string | null; company: { legalName: string } }[] | null;
  forms: { mySubmissionsPending: number; awaitingMyApproval: number };
  revisions: { items: { id: string; code: string; reason: string; dueDate: string; deliverable: { name: string } | null }[]; overdue: number };
  sla: { items: { id: string; state: string; dueAt: string; policy: { labelFa: string } }[]; breached: number; atRisk: number };
  unreadNotifications: number;
}

/** A tile is a way in: it opens the list it counts. */
const TileLink = ({ to, children }: { to: string; children: React.ReactNode }) => (
  <Link to={to} className="block rounded-xl transition-shadow hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600">{children}</Link>
);

export default function Dashboard() {
  const { user } = useAuth();
  const [projectsTab, setProjectsTab] = useState<'active' | 'sales'>('active');
  const { data, isLoading, error, refetch } = useQuery<MyDashboard>({
    queryKey: ['/reports/my-dashboard'],
    queryFn: () => apiGet('/reports/my-dashboard'),
  });

  return (
    <>
      <PageHeader
        title={tr('سلام، {0}', user?.fullName ?? '')}
        subtitle={
          <span>
            {loc(user?.department, 'name')}
            {user?.jobTitle && ` — ${trx(user.jobTitle)}`}
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
            <div data-tour="tiles" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatTile
                label={tr('وظایف باز من')}
                value={<Count value={data.tasks.total} />}
                hint={data.tasks.dueThisWeek ? tr('{0} مورد در این هفته', localDigits(data.tasks.dueThisWeek)) : tr('مهلتی در این هفته نیست')}
                icon={<IconCheckCircle className="size-4" />}
              />
              <TileLink to="/my-work">
                <StatTile
                  label={tr('وظایف تاخیردار')}
                  value={<Count value={data.tasks.overdue} />}
                  tone={data.tasks.overdue > 0 ? 'danger' : 'success'}
                  hint={data.tasks.overdue > 0 ? tr('نیازمند اقدام فوری') : tr('همه در برنامه')}
                  icon={<IconClock className="size-4" />}
                />
              </TileLink>
              <TileLink to="/forms?tab=inbox">
                <StatTile
                  label={tr('در انتظار تأیید')}
                  value={<Count value={data.forms.awaitingMyApproval} />}
                  tone={data.forms.awaitingMyApproval > 0 ? 'warning' : 'neutral'}
                  hint={tr('فرم‌های ارجاع‌شده')}
                  icon={<IconFile className="size-4" />}
                />
              </TileLink>
              <TileLink to="/my-work">
                <StatTile
                  label={tr('نقض روند')}
                  value={<Count value={data.sla.atRisk + data.sla.breached} />}
                  tone={data.sla.breached > 0 ? 'danger' : data.sla.atRisk > 0 ? 'warning' : 'success'}
                  hint={tr('{0} نقض‌شده — {1} در خطر', localDigits(data.sla.breached), localDigits(data.sla.atRisk))}
                  icon={<IconAlert className="size-4" />}
                />
              </TileLink>
            </div>

            <div className="grid gap-5 xl:grid-cols-3">
              <Card
                tour="my-tasks"
                className="xl:col-span-2"
                title={tr('وظایف من')}
                subtitle={tr('مرتب‌شده بر اساس نزدیک‌ترین مهلت')}
                footer={<>
                  <span className="nums">{tr('{0} از {1} وظیفهٔ باز', localDigits(Math.min(8, data.tasks.items.length)), localDigits(data.tasks.total))}</span>
                  <Link to="/tasks" className="text-brand-700 hover:underline">{tr('همه وظایف')} {flow()}</Link>
                </>}
              >
                {!data.tasks.items.length ? (
                  <EmptyState title={tr('وظیفه بازی ندارید')} description={tr('وظایف تخصیص‌یافته اینجا نمایش داده می‌شوند.')} />
                ) : (
                  <Table>
                    <thead className="bg-ink-50/60">
                      <tr>
                        <Th>{tr('وظیفه')}</Th>
                        <Th>{tr('پروژه')}</Th>
                        <Th>{tr('مهلت')}</Th>
                        <Th>{tr('وضعیت')}</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.tasks.items.slice(0, 8).map((t) => {
                        const days = daysFromNow(t.dueDate);
                        return (
                          <Tr key={t.id}>
                            <Td>
                              <p className="font-medium text-ink-800">{t.title}</p>
                              <p className="ltr text-[12.5px] text-ink-400 whitespace-nowrap">{t.code}</p>
                            </Td>
                            <Td className="text-xs">
                              <Link to={`/projects/${t.project.id}`} className="text-brand-600 hover:underline">
                                {t.project.name}
                              </Link>
                            </Td>
                            <Td>
                              <span className={days !== null && days < 0 ? 'text-rose-700 font-medium' : ''}>
                                {formatDate(t.dueDate)}
                              </span>
                              <p className="text-[12.5px] text-ink-400">{formatRelative(t.dueDate)}</p>
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
                <Card title={tr('اصلاحیه‌ها')} subtitle={data.revisions.overdue ? tr('{0} مورد سررسید گذشته', localDigits(data.revisions.overdue)) : undefined}>
                  {!data.revisions.items.length ? (
                    <EmptyState title={tr('اصلاحیه بازی ندارید')} />
                  ) : (
                    <ul className="divide-y divide-ink-100">
                      {data.revisions.items.slice(0, 5).map((r) => (
                        <li key={r.id} className="px-4 py-2.5">
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-sm text-ink-800">{r.deliverable?.name ?? tr('خروجی')}</p>
                            {daysFromNow(r.dueDate)! < 0 && <Badge tone="danger">{tr('گذشته')}</Badge>}
                          </div>
                          <p className="mt-0.5 text-xs text-ink-500">{tr('{0} — مهلت {1}', REVISION_REASON_LABELS[r.reason] ?? r.reason, formatDate(r.dueDate))}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>

                <Card tour="my-slas" title={tr('روندهای من')}>
                  {!data.sla.items.length ? (
                    <EmptyState title={tr('روند فعالی ندارید')} />
                  ) : (
                    <>
                    <HalfGauge
                      value={data.sla.items.length - data.sla.breached - data.sla.atRisk}
                      total={data.sla.items.length}
                      label={tr('در مسیر')}
                      legend={[
                        { label: tr('در مسیر'), value: data.sla.items.length - data.sla.breached - data.sla.atRisk, tone: 'brand' },
                        { label: tr('در خطر'), value: data.sla.atRisk, tone: 'warning' },
                        { label: tr('نقض‌شده'), value: data.sla.breached, tone: 'danger' },
                      ]}
                    />
                    <ul className="divide-y divide-ink-200 border-t border-ink-200">
                      {data.sla.items.slice(0, 6).map((s) => (
                        <li key={s.id} className="flex items-center justify-between gap-2 px-4 py-2.5">
                          <div className="min-w-0">
                            <p className="truncate text-sm text-ink-800">{loc(s.policy, 'label')}</p>
                            <p className="text-[12.5px] text-ink-400">{tr('مهلت {0}', formatRelative(s.dueAt))}</p>
                          </div>
                          <StateBadge state={s.state} />
                        </li>
                      ))}
                    </ul>
                    </>
                  )}
                </Card>
              </div>
            </div>

            <Card tour="my-projects" title={tr('پروژه‌های من')}
              footer={<>
                <span />
                <Link to={projectsTab === 'sales' ? '/opportunities' : '/projects'} className="text-brand-700 hover:underline">{projectsTab === 'sales' ? tr('همه فرصت‌ها') : tr('همه پروژه‌ها')} {flow()}</Link>
              </>}>
              {data.opportunities && (
                <Tabs
                  active={projectsTab}
                  onChange={(k) => setProjectsTab(k as 'active' | 'sales')}
                  tabs={[
                    { key: 'active', label: tr('در حال اجرا (فعال)'), count: data.projects.length },
                    { key: 'sales', label: tr('فروش (فرصت فروش)'), count: data.opportunities.length },
                  ]}
                />
              )}
              {projectsTab === 'sales' && data.opportunities ? (
                !data.opportunities.length ? (
                  <EmptyState title={tr('فرصت فروش بازی ندارید')} description={tr('فرصت‌هایی که مسئولشان هستید و هنوز برده یا باخته نشده‌اند، اینجا می‌آیند.')} />
                ) : (
                  <Table>
                    <thead className="bg-ink-50/60">
                      <tr>
                        <Th>{tr('فرصت')}</Th>
                        <Th>{tr('مشتری')}</Th>
                        <Th>{tr('مرحله')}</Th>
                        <Th>{tr('ارزش تخمینی')}</Th>
                        <Th>{tr('بستن مورد انتظار')}</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.opportunities.map((o) => (
                        <Tr key={o.id}>
                          <Td>
                            <Link to={`/opportunities/${o.id}`} className="font-medium text-brand-600 hover:underline">{o.title}</Link>
                            <p className="ltr text-[12.5px] text-ink-400 whitespace-nowrap">{o.code}</p>
                          </Td>
                          <Td className="text-xs">{o.company?.legalName}</Td>
                          <Td><StateBadge state={o.state} /></Td>
                          <Td className="text-xs">{formatCurrency(o.estimatedValue)}</Td>
                          <Td className="text-xs">{o.expectedCloseDate ? formatDate(o.expectedCloseDate) : '—'}</Td>
                        </Tr>
                      ))}
                    </tbody>
                  </Table>
                )
              ) : !data.projects.length ? (
                <EmptyState title={tr('پروژه در حال اجرایی ندارید')} />
              ) : (
                <Table>
                  <thead className="bg-ink-50/60">
                    <tr>
                      <Th>{tr('پروژه')}</Th>
                      <Th>{tr('مشتری')}</Th>
                      <Th>{tr('وضعیت')}</Th>
                      <Th>{tr('سلامت')}</Th>
                      <Th>{tr('پایان برنامه‌ریزی‌شده')}</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.projects.map((p) => (
                      <Tr key={p.id}>
                        <Td>
                          <Link to={`/projects/${p.id}`} className="font-medium text-brand-600 hover:underline">
                            {p.name}
                          </Link>
                          <p className="ltr text-[12.5px] text-ink-400 whitespace-nowrap">{p.code}</p>
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
