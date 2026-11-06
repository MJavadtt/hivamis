import { Link } from 'react-router-dom';
import { useDraftList, type DraftRow } from '../lib/drafts';
import { formatRelative, localDigits } from '../lib/format';
import { PageBody, PageHeader } from '../components/Shell';
import { Button, EmptyState } from '../components/ui';
import { tr } from '../i18n';

/**
 * Everything this person typed and has not saved (ADR-122), with what it says and where it belongs.
 * Only they see it. A draft leaves when its form is saved, or here, by their hand.
 */

const shown = (value: unknown) => {
  if (value === true) return tr('بله');
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
};

function DraftCard({ row, onDelete }: { row: DraftRow; onDelete: () => void }) {
  const inDialog = row.key.includes('#');
  const fields = Object.values(row.fields);
  return (
    <li className="rounded-xl bg-surface p-4 ring-1 ring-edge" data-testid="draft-row">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium text-ink-800">{row.title || row.path}</p>
          <p className="text-xs text-ink-500">{row.updatedAt ? tr('آخرین ذخیره: {0}', formatRelative(row.updatedAt)) : tr('در حال ذخیره…')} · {tr('{0} فیلد', localDigits(fields.length))}</p>
        </div>
        <div className="flex gap-2">
          <Link to={row.path}><Button size="sm" variant="primary">{tr('ادامه')}</Button></Link>
          <Button size="sm" variant="ghost" onClick={() => { if (window.confirm(tr('این پیش‌نویس حذف شود؟'))) onDelete(); }}>{tr('حذف')}</Button>
        </div>
      </div>
      <dl className="mt-2 space-y-1 text-sm">
        {fields.slice(0, 6).map((f) => (
          <div key={f.label} className="flex gap-2">
            <dt className="shrink-0 text-ink-500">{f.label}:</dt>
            <dd className="min-w-0 break-words text-ink-800">{shown(f.value)}</dd>
          </div>
        ))}
        {fields.length > 6 && <p className="text-xs text-ink-500">{tr('و {0} فیلد دیگر', localDigits(fields.length - 6))}</p>}
      </dl>
      {inDialog && <p className="mt-2 text-xs text-ink-500">{tr('این پیش‌نویس از یک پنجره است: در آن صفحه، همان پنجره را باز کنید تا برگردد.')}</p>}
    </li>
  );
}

export default function Drafts() {
  const { rows, remove } = useDraftList();
  return (
    <>
      <PageHeader title={tr('پیش‌نویس‌های من')} subtitle={tr('آنچه نوشته‌اید و هنوز ثبت نشده. فقط شما این‌ها را می‌بینید؛ با ثبت فرم یا با حذف شما از این‌جا می‌رود.')} />
      <PageBody>
        {!rows.length ? <EmptyState title={tr('پیش‌نویسی ندارید')} description={tr('هر فرمی را که پر کنید و ثبت نکنید، این‌جا پیدا می‌کنید.')} /> : (
          <ul className="space-y-3" data-tour="drafts">{rows.map((r) => <DraftCard key={r.key} row={r} onDelete={() => remove(r.key)} />)}</ul>
        )}
      </PageBody>
    </>
  );
}
