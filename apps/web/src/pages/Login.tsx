import { useState } from 'react';
import { useAuth } from '../lib/auth';
import { Button, Field, Input } from '../components/ui';
import { tr } from '../i18n';

export default function Login() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim().toLowerCase(), password);
    } catch (err: any) {
      setError(err?.message ?? tr('ورود ناموفق بود.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center bg-ink-100 p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <span className="mx-auto mb-3 grid size-12 place-items-center rounded-xl bg-brand-600 text-xl font-bold text-white">{tr('ه')}</span>
          <h1 className="text-xl font-semibold text-ink-900">{tr('هیوامیس')}</h1>
          <p className="mt-1 text-sm text-ink-500">{tr('سیستم‌عامل سازمانی — ورود به سامانه')}</p>
        </div>

        <form onSubmit={submit} className="space-y-4 rounded-xl bg-surface p-6 shadow-sm ring-1 ring-ink-200">
          <Field label={tr('ایمیل سازمانی')} required>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              required
              className="ltr"
              placeholder="name@hiva.local"
            />
          </Field>
          <Field label={tr('رمز عبور')} required>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              className="ltr"
            />
          </Field>

          {error && (
            <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-inset ring-rose-200">
              {error}
            </p>
          )}

          <Button type="submit" variant="primary" loading={busy} className="w-full">{tr('ورود')}</Button>
        </form>

        <p className="mt-4 text-center text-xs text-ink-400">{tr('دسترسی شما بر اساس نقش سازمانی و قوانین حاکم بر فرآیند تعیین می‌شود.')}</p>
      </div>
    </div>
  );
}
