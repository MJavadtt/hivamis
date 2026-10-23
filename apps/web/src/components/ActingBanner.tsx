import { useState } from 'react';
import { useAuth } from '../lib/auth';
import { formatDateTime } from '../lib/format';
import { tr } from '../i18n';
import { Button, cx } from './ui';

/**
 * The system administrator in someone else's account (owner's report, 2026-10-23), said above every
 * page for as long as it lasts: whose account, that everything is recorded under the administrator's
 * own name, until when — and the way back.
 */
export function ActingBanner({ className }: { className?: string }) {
  const { user, endActing } = useAuth();
  const [busy, setBusy] = useState(false);
  if (!user?.actingAs) return null;
  return (
    <div role="status" data-testid="acting-banner"
      className={cx('flex flex-wrap items-center justify-between gap-2 rounded-xl bg-amber-100 px-4 py-2.5 text-sm text-amber-950 ring-1 ring-inset ring-amber-300', className)}>
      <p>
        <strong>{tr('در حساب {0} کار می‌کنید.', user.fullName)}</strong>{' '}
        {tr('هر کاری که انجام دهید با نام شما، {0}، در سابقه ثبت می‌شود؛ ایشان هم باخبر شده‌اند. تا {1}.', user.actingAs.by.fullName, formatDateTime(user.actingAs.until))}
      </p>
      <Button size="sm" variant="secondary" loading={busy} onClick={() => { setBusy(true); void endActing().finally(() => setBusy(false)); }}>
        {tr('بازگشت به حساب خودم')}
      </Button>
    </div>
  );
}
