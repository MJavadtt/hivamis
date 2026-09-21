import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { WORKFLOWS, stateLabelFa } from '@hiva/contracts';
import { apiGet } from '../lib/api';
import { Code } from './common';
import { Badge, Card, EmptyState, LoadingBlock, Select, StatTile, Table, Td, Th, Tr } from './ui';
import { toPersianDigits } from '../lib/format';

interface Node { state: string; visits: number; meanDwellHours: number | null; open: number; declared: boolean; initial: boolean; terminal: boolean }
interface Edge { from: string; to: string; action: string; count: number; cases: number; meanHours: number | null; declared: boolean; cascade: boolean }
interface Mining {
  entity: string; labelFa: string; cases: number; events: number; nodes: Node[]; edges: Edge[];
  unusedDeclared: { from: string; to: string; action: string; labelFa: string }[];
  loops: { from: string; to: string; action: string; count: number; cases: number }[];
  variants: { path: string[]; count: number; share: number; meanHours: number | null }[];
  happyPath: string[] | null;
  cycleTime: { meanHours: number | null; medianHours: number | null; completed: number };
  bottlenecks: { state: string; meanDwellHours: number; visits: number }[];
}

const h = (n: number | null) => (n == null ? '—' : `${toPersianDigits(Math.round(n * 10) / 10)} س`);

/**
 * The process as it is actually run, drawn from the event log, against the one declared.
 * Edge width is how often the move happens; edge colour is how long cases waited before it —
 * the picture is where the frequency and the waiting live, which no state machine diagram shows.
 */
export function ProcessMap() {
  const entities = Object.entries(WORKFLOWS).map(([k, w]) => ({ key: k, labelFa: w.labelFa }));
  const [entity, setEntity] = useState('lead');
  const { data, isLoading } = useQuery<Mining>({
    queryKey: ['/reports/mining', entity], queryFn: () => apiGet(`/reports/mining/${entity}`),
  });

  return (
    <div className="space-y-5">
      <Card title="کشف فرآیند و تحلیل انطباق" subtitle="فرآیندی که نوشته‌اید و فرآیندی که اجرا می‌شود — از جدول انتقال‌ها، بدون هیچ ETL"
        action={
          <Select value={entity} onChange={(e) => setEntity(e.target.value)} className="w-auto text-xs" aria-label="موجودیت">
            {entities.map((e) => <option key={e.key} value={e.key}>{e.labelFa}</option>)}
          </Select>
        }>
        {isLoading ? <LoadingBlock /> : !data ? null : !data.cases ? <EmptyState title="هنوز انتقالی برای این موجودیت ثبت نشده" /> : (
          <>
            <div className="grid grid-cols-2 gap-3 p-4 lg:grid-cols-4">
              <StatTile label="پرونده‌ها" value={toPersianDigits(data.cases)} hint={`${toPersianDigits(data.events)} انتقال`} />
              <StatTile label="زمان چرخه (میانه)" value={h(data.cycleTime.medianHours)} hint={`${toPersianDigits(data.cycleTime.completed)} پروندهٔ خاتمه‌یافته · میانگین ${h(data.cycleTime.meanHours)}`} />
              <StatTile label="مسیرهای اعلام‌شدهٔ بی‌استفاده" value={toPersianDigits(data.unusedDeclared.length)} tone={data.unusedDeclared.length ? 'warning' : 'success'} />
              <StatTile label="حلقه‌ها" value={toPersianDigits(data.loops.reduce((s, l) => s + l.count, 0))} hint={`${toPersianDigits(data.loops.length)} یال بازگشتی`} tone={data.loops.length ? 'warning' : 'success'} />
            </div>
            <Graph data={data} />
          </>
        )}
      </Card>

      {data && data.cases > 0 && (
        <div className="grid gap-5 lg:grid-cols-2">
          <Card title="گلوگاه‌ها" subtitle="وضعیت‌هایی که پرونده‌ها بیشترین زمان را در آن‌ها منتظر می‌مانند (ساعت کاری)">
            <ul className="divide-y divide-ink-100" data-testid="bottlenecks">
              {data.bottlenecks.map((b) => (
                <li key={b.state} className="flex items-center justify-between px-4 py-2 text-xs">
                  <span>{stateLabelFa(b.state)} <Code>{b.state}</Code></span>
                  <span className="nums">{h(b.meanDwellHours)} · {toPersianDigits(b.visits)} پرونده</span>
                </li>
              ))}
            </ul>
          </Card>
          <Card title="مسیرهای اعلام‌شده که هیچ‌کس نمی‌رود" subtitle="در ماشین حالت هست، در واقعیت نیست — یا لازم نیست، یا کسی راهش را بلد نیست">
            {!data.unusedDeclared.length ? <EmptyState title="هر مسیر اعلام‌شده دست‌کم یک بار طی شده" /> : (
              <ul className="divide-y divide-ink-100" data-testid="unused">
                {data.unusedDeclared.map((u) => (
                  <li key={`${u.from}${u.action}`} className="px-4 py-2 text-xs">{stateLabelFa(u.from)} ← «{u.labelFa}» → {stateLabelFa(u.to)}</li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="حلقه‌ها" subtitle="بازگشت به وضعیتی که پرونده قبلاً در آن بوده: دوباره‌کاری، برگشت، رد">
            {!data.loops.length ? <EmptyState title="حلقه‌ای ثبت نشده" /> : (
              <Table>
                <thead className="bg-ink-50/60"><tr><Th>از</Th><Th>به</Th><Th>اقدام</Th><Th>دفعات</Th><Th>پرونده‌ها</Th></tr></thead>
                <tbody data-testid="loops">
                  {data.loops.map((l) => (
                    <Tr key={`${l.from}${l.to}${l.action}`}>
                      <Td className="text-xs">{stateLabelFa(l.from)}</Td><Td className="text-xs">{stateLabelFa(l.to)}</Td>
                      <Td><Code>{l.action}</Code></Td><Td className="nums text-xs">{toPersianDigits(l.count)}</Td><Td className="nums text-xs">{toPersianDigits(l.cases)}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          <Card title="مسیرهای واقعی" subtitle="توالی وضعیت‌هایی که پرونده‌ها واقعاً طی کرده‌اند، پرتکرارترین اول">
            <ul className="divide-y divide-ink-100" data-testid="variants">
              {data.variants.map((v, i) => (
                <li key={i} className="px-4 py-2 text-xs">
                  <div className="flex items-center gap-2">
                    <Badge tone={data.happyPath && v.path.join('>') === data.happyPath.join('>') ? 'success' : 'neutral'}>{toPersianDigits(v.share)}٪</Badge>
                    <span className="nums text-ink-500">{toPersianDigits(v.count)} پرونده · {h(v.meanHours)}</span>
                  </div>
                  <p className="mt-1 text-ink-700">{v.path.map(stateLabelFa).join(' ← ')}</p>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </div>
  );
}

/**
 * Nodes on the happy path sit on a line, in order; every other state sits in a row beneath.
 * Forward moves arc above the line, revisits arc below, so a loop is visible as a loop.
 */
function Graph({ data }: { data: Mining }) {
  const happy = data.happyPath ?? [];
  const rest = data.nodes.map((n) => n.state).filter((s) => !happy.includes(s));
  const W = 960, X0 = 80, GAP = Math.max(120, (W - 2 * X0) / Math.max(1, happy.length - 1));
  const pos = new Map<string, { x: number; y: number }>();
  happy.forEach((s, i) => pos.set(s, { x: X0 + i * Math.min(GAP, 180), y: 90 }));
  const restGap = Math.max(110, (W - 2 * X0) / Math.max(1, rest.length - 1));
  rest.forEach((s, i) => pos.set(s, { x: X0 + i * Math.min(restGap, 180), y: 230 }));
  const H = rest.length ? 300 : 180;
  const maxCount = Math.max(1, ...data.edges.map((e) => e.count));
  const maxWait = Math.max(0.01, ...data.edges.map((e) => e.meanHours ?? 0));
  const byState = new Map(data.nodes.map((n) => [n.state, n]));
  const colour = (e: Edge) => {
    const t = (e.meanHours ?? 0) / maxWait;
    return t > 0.66 ? '#be123c' : t > 0.33 ? '#d97706' : '#2563eb';
  };
  const revisit = (e: Edge) => happy.indexOf(e.to) !== -1 && happy.indexOf(e.from) !== -1 && happy.indexOf(e.to) <= happy.indexOf(e.from)
    || data.loops.some((l) => l.from === e.from && l.to === e.to && l.action === e.action);

  return (
    <div className="overflow-x-auto px-2 pb-3" dir="ltr">
      <svg viewBox={`0 0 ${W} ${H}`} className="min-w-[720px]" role="img" aria-label={`نقشهٔ فرآیند ${data.labelFa}`} data-testid="process-map">
        <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="context-stroke" /></marker></defs>
        {data.edges.map((e) => {
          const a = pos.get(e.from), b = pos.get(e.to);
          if (!a || !b) return null;
          const width = 1 + 5 * (e.count / maxCount);
          const back = revisit(e);
          const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 + (back ? 70 : -60 * Math.min(1, Math.abs(a.x - b.x) / 300)) };
          const self = a === b;
          const d = self ? `M ${a.x - 20} ${a.y - 25} C ${a.x - 60} ${a.y - 90}, ${a.x + 60} ${a.y - 90}, ${a.x + 20} ${a.y - 25}` : `M ${a.x} ${a.y} Q ${mid.x} ${mid.y} ${b.x} ${b.y}`;
          return (
            <g key={`${e.from}${e.to}${e.action}`} data-testid="edge">
              <path d={d} fill="none" stroke={colour(e)} strokeWidth={width} strokeDasharray={e.cascade ? '6 4' : e.declared ? undefined : '2 3'} markerEnd="url(#arrow)" opacity={0.85} />
              <text x={self ? a.x : mid.x} y={(self ? a.y - 95 : mid.y) - 6} fontSize="11" textAnchor="middle" fill="#334155">{e.action} ×{e.count}{e.meanHours != null ? ` · ${Math.round(e.meanHours * 10) / 10}h` : ''}</text>
            </g>
          );
        })}
        {[...pos.entries()].map(([s, p]) => {
          const n = byState.get(s);
          return (
            <g key={s} data-testid="node">
              <rect x={p.x - 52} y={p.y - 22} width={104} height={44} rx={10} fill={n?.terminal ? '#ecfdf5' : n?.initial ? '#eff6ff' : '#ffffff'} stroke={n?.declared === false ? '#be123c' : '#94a3b8'} strokeWidth={1.5} />
              <text x={p.x} y={p.y - 4} fontSize="11" textAnchor="middle" fill="#0f172a">{stateLabelFa(s)}</text>
              <text x={p.x} y={p.y + 12} fontSize="10" textAnchor="middle" fill="#64748b">{n ? `${n.visits}${n.open ? ` · ${n.open} open` : ''}${n.meanDwellHours != null ? ` · ${Math.round(n.meanDwellHours * 10) / 10}h` : ''}` : ''}</text>
            </g>
          );
        })}
      </svg>
      <p className="px-2 text-[11px] text-ink-500" dir="rtl">ضخامت یال = فراوانی · رنگ = میانگین انتظار پیش از انتقال (آبی کم، نارنجی میانه، قرمز زیاد) · خط‌چین = آبشاری · نقطه‌چین = خارج از مدل اعلام‌شده</p>
    </div>
  );
}
