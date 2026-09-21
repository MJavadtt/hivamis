import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../lib/api';
import { Code } from './common';
import { Badge, Card, EmptyState, ProgressBar, Table, Td, Th, Tr } from './ui';
import { formatCurrency, toPersianDigits } from '../lib/format';

interface Row {
  workOrderId: string; code: string; title: string; departmentCode: string; state: string;
  budget: number | null; declared: number; variance: number | null; variancePercent: number | null;
  status: 'NO_BUDGET' | 'UNDER' | 'NEAR' | 'OVER'; declarations: number;
}
interface Budget {
  project: { plannedBudget: number | null; allocated: number; declared: number; unallocated: number | null; status: Row['status'] };
  units: { departmentCode: string; budget: number; declared: number; orders: number; status: Row['status'] }[];
  workOrders: Row[];
}

const STATUS: Record<Row['status'], { fa: string; tone: 'neutral' | 'success' | 'warning' | 'danger' }> = {
  NO_BUDGET: { fa: 'بدون بودجه', tone: 'neutral' }, UNDER: { fa: 'در محدوده', tone: 'success' },
  NEAR: { fa: 'نزدیک سقف', tone: 'warning' }, OVER: { fa: 'عبور کرده', tone: 'danger' },
};

/**
 * Budget against declared cost per work order — the level at which someone can still act. The
 * project-level bar above it moves too late; this table says which unit, and by how much.
 */
export function BudgetByOrder({ projectId }: { projectId: string }) {
  const { data } = useQuery<Budget>({
    queryKey: ['/projects', projectId, 'budget'], queryFn: () => apiGet(`/projects/${projectId}/budget`),
  });
  if (!data) return null;
  const used = (r: { budget: number | null; declared: number }) => (r.budget ? Math.min(150, (r.declared / r.budget) * 100) : 0);
  return (
    <Card title="بودجه در برابر واقعیت — به تفکیک سفارش کار"
      subtitle={`تخصیص‌یافته ${formatCurrency(data.project.allocated)} · اعلام‌شده ${formatCurrency(data.project.declared)}${data.project.unallocated != null ? ` · تخصیص‌نیافته ${formatCurrency(data.project.unallocated)}` : ''}`}>
      {!data.workOrders.length ? <EmptyState title="سفارش کاری صادر نشده" /> : (
        <Table>
          <thead className="bg-ink-50/60">
            <tr><Th>سفارش</Th><Th>واحد</Th><Th>بودجه</Th><Th>اعلام‌شده</Th><Th>انحراف</Th><Th>مصرف</Th><Th>وضعیت</Th></tr>
          </thead>
          <tbody data-testid="budget-rows">
            {data.workOrders.map((w) => (
              <Tr key={w.workOrderId}>
                <Td><p className="text-sm">{w.title}</p><Code>{w.code}</Code></Td>
                <Td className="text-xs">{w.departmentCode}</Td>
                <Td className="nums text-xs">{w.budget == null ? '—' : formatCurrency(w.budget)}</Td>
                <Td className="nums text-xs">{formatCurrency(w.declared)} <span className="text-ink-400">({toPersianDigits(w.declarations)})</span></Td>
                <Td className={`nums text-xs ${w.variance != null && w.variance < 0 ? 'text-rose-700' : 'text-ink-600'}`}>
                  {w.variance == null ? '—' : `${formatCurrency(w.variance)}${w.variancePercent != null ? ` (${toPersianDigits(w.variancePercent)}٪)` : ''}`}
                </Td>
                <Td><div className="w-24"><ProgressBar value={used(w)} tone={STATUS[w.status].tone === 'neutral' ? 'success' : STATUS[w.status].tone} /></div></Td>
                <Td><Badge tone={STATUS[w.status].tone}>{STATUS[w.status].fa}</Badge></Td>
              </Tr>
            ))}
          </tbody>
          {data.units.length > 1 && (
            <tfoot className="bg-ink-50/40 text-xs">
              {data.units.map((u) => (
                <tr key={u.departmentCode}>
                  <Td className="text-ink-500">جمع واحد</Td>
                  <Td>{u.departmentCode}</Td>
                  <Td className="nums">{formatCurrency(u.budget)}</Td>
                  <Td className="nums">{formatCurrency(u.declared)}</Td>
                  <Td className="nums">{formatCurrency(u.budget - u.declared)}</Td>
                  <Td />
                  <Td><Badge tone={STATUS[u.status].tone}>{STATUS[u.status].fa}</Badge></Td>
                </tr>
              ))}
            </tfoot>
          )}
        </Table>
      )}
    </Card>
  );
}
