import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PageBody, PageHeader } from '../components/Shell';
import { Badge, Button, Card, Tabs, cx, useToast } from '../components/ui';
import { platformOf, useInstall, type Platform } from '../lib/install';
import { isEnglish, tr } from '../i18n';

/**
 * Installing Hivamis on a device (audit F-8). The app is a PWA: one installable app for Android,
 * iOS, Windows, macOS and Linux, from the browser people already have. Where the browser offers
 * an install prompt, one click; elsewhere, that browser's own steps.
 */

const PLATFORMS: { key: Platform; label: () => string }[] = [
  { key: 'android', label: () => tr('اندروید') },
  { key: 'ios', label: () => tr('آیفون و آیپد') },
  { key: 'windows', label: () => tr('ویندوز') },
  { key: 'mac', label: () => tr('مک') },
  { key: 'linux', label: () => tr('لینوکس') },
];

const STEPS: Record<Exclude<Platform, 'other'>, () => { steps: string[]; note: string }> = {
  android: () => ({
    steps: [
      tr('این صفحه را در Chrome، Edge یا Samsung Internet باز کنید.'),
      tr('منوی ⋮ را بزنید و «نصب برنامه» یا «افزودن به صفحهٔ اصلی» را برگزینید.'),
      tr('«نصب» را بزنید. هیوامیس با نماد خودش در فهرست برنامه‌ها می‌نشیند و بی‌نوار نشانی باز می‌شود.'),
    ],
    note: tr('اعلان‌های گوشی پس از نصب کار می‌کنند؛ از زنگ بالای «هیوامیس همراه» روشنشان کنید.'),
  }),
  ios: () => ({
    steps: [
      tr('این صفحه را در Safari باز کنید (در iOS 16.4 به بعد Chrome هم می‌شود).'),
      tr('دکمهٔ اشتراک‌گذاری (مربع با پیکان رو به بالا) را بزنید.'),
      tr('«افزودن به صفحهٔ اصلی» (Add to Home Screen) و سپس «افزودن» را بزنید.'),
    ],
    note: tr('اعلان در آیفون فقط برای برنامهٔ نصب‌شده و از iOS 16.4 به بعد کار می‌کند.'),
  }),
  windows: () => ({
    steps: [
      tr('این صفحه را در Edge یا Chrome باز کنید.'),
      tr('نماد نصب (⊕) را در سمت راست نوار نشانی بزنید، یا از منو «برنامه‌ها ← نصب هیوامیس» را برگزینید.'),
      tr('«نصب» را بزنید. هیوامیس در منوی Start پیدا می‌شود و می‌توانید آن را به نوار وظیفه سنجاق کنید.'),
    ],
    note: tr('در Edge می‌توانید از edge://apps بخواهید هیوامیس با ورود به ویندوز باز شود.'),
  }),
  mac: () => ({
    steps: [
      tr('در Chrome یا Edge: نماد نصب (⊕) را در نوار نشانی بزنید.'),
      tr('در Safari 17 به بعد: از منوی File گزینهٔ «Add to Dock» را برگزینید.'),
      tr('هیوامیس در Dock و Launchpad می‌نشیند و مانند برنامه‌ای جدا باز می‌شود.'),
    ],
    note: tr('اعلان‌ها از راه اعلان‌های خود macOS می‌رسند.'),
  }),
  linux: () => ({
    steps: [
      tr('این صفحه را در Chrome، Chromium یا Edge باز کنید.'),
      tr('نماد نصب (⊕) را در نوار نشانی بزنید، یا از منو «نصب هیوامیس» را برگزینید.'),
      tr('هیوامیس در فهرست برنامه‌های میزکار شما می‌نشیند.'),
    ],
    note: tr('Firefox برنامهٔ وب نصب نمی‌کند؛ برای نصب Chromium را به کار ببرید.'),
  }),
};

export default function Install() {
  const toast = useToast();
  const { canPrompt, installed, prompt } = useInstall();
  const guessed = platformOf();
  const [platform, setPlatform] = useState<Platform>(guessed === 'other' ? 'android' : guessed);
  const { steps, note } = STEPS[platform as Exclude<Platform, 'other'>]();

  const install = async () => {
    if (await prompt()) toast(tr('هیوامیس نصب شد.'));
  };

  return (
    <>
      <PageHeader title={tr('نصب هیوامیس')} subtitle={tr('یک برنامه برای گوشی، تبلت و رایانه — از همان مرورگری که دارید، بی‌فروشگاه')} />
      <PageBody>
        <div className="space-y-5" data-testid="install">
        <Card>
          <div className="flex flex-wrap items-center gap-3 p-5">
            {installed ? (
              <p className="text-sm text-ink-700"><Badge tone="success" className="me-2">{tr('نصب‌شده')}</Badge>{tr('هیوامیس هم‌اکنون به‌صورت برنامه باز است.')}</p>
            ) : canPrompt ? (
              <>
                <p className="flex-1 text-sm text-ink-700">{tr('این مرورگر می‌تواند هیوامیس را همین‌جا نصب کند.')}</p>
                <Button variant="primary" onClick={() => void install()}>{tr('نصب روی این دستگاه')}</Button>
              </>
            ) : (
              <p className="text-sm text-ink-700">{tr('این مرورگر دکمهٔ نصب نمی‌دهد؛ گام‌های زیر را دنبال کنید.')}</p>
            )}
            <p className="basis-full text-xs text-ink-500">
              {tr('نشانی این نصب برای دستگاه‌های دیگر:')} <span className="ltr font-mono">{window.location.origin}</span>
            </p>
          </div>
        </Card>

        <Card title={tr('گام‌ها برای هر دستگاه')}>
          <div className="px-2"><Tabs active={platform} onChange={(k) => setPlatform(k as Platform)} tabs={PLATFORMS.map((p) => ({ key: p.key, label: p.label() }))} /></div>
          <ol className={cx('space-y-2 px-10 py-4 text-sm leading-7 text-ink-800', isEnglish() ? 'list-decimal' : '[list-style-type:persian]')} data-testid="install-steps">
            {steps.map((s) => <li key={s}>{s}</li>)}
          </ol>
          <p className="border-t border-ink-100 px-5 py-3 text-xs leading-6 text-ink-600">{note}</p>
        </Card>

        <Card title={tr('هیوامیس همراه، برای کار میدانی')}>
          <p className="px-5 py-4 text-sm leading-7 text-ink-700">
            {tr('روی گوشی، نشانی /m را باز کنید و همان‌جا نصب کنید: برنامه‌ای جدا که با سه کار میدانی — پذیرش سفارش، تأیید فرم و QC واحد — باز می‌شود و اعلان‌هایش را دارد.')}{' '}
            <Link to="/m" className="text-brand-700 underline">{tr('باز کردن هیوامیس همراه')}</Link>
          </p>
        </Card>
        </div>
      </PageBody>
    </>
  );
}
