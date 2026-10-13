import { useRef, useState } from 'react';
import { useMaybeAuth } from '../lib/auth';
import { streamEvents } from '../lib/chat';
import { locale as uiLocale, tr } from '../i18n';
import { Button, Checkbox, Field, Input, Modal, Select, Textarea } from './ui';

/**
 * Writing with the assistant (audit F-2): beside a long text field, a draft from an instruction or a
 * rewrite of what is already there, in Persian or English, and a button that puts it in the field.
 * Nothing is written into the form until the person says so. Shown only to someone with `ai.write`.
 */

export type WriteKind = 'brief' | 'proposal' | 'email' | 'minutes' | 'other';

export function WriteAssist({ value, onUse, kind = 'other' }: { value: string; onUse: (text: string) => void; kind?: WriteKind }) {
  const auth = useMaybeAuth();
  const [open, setOpen] = useState(false);
  if (!auth?.can('ai.write')) return null;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="mt-1 text-[12.5px] font-semibold text-brand-700 hover:underline" data-testid="write-assist">
        {tr('نوشتن با دستیار')}
      </button>
      {open && <WritePanel value={value} kind={kind} onClose={() => setOpen(false)} onUse={(t) => { onUse(t); setOpen(false); }} />}
    </>
  );
}

function WritePanel({ value, kind: initialKind, onUse, onClose }: { value: string; kind: WriteKind; onUse: (text: string) => void; onClose: () => void }) {
  const [instruction, setInstruction] = useState('');
  const [kind, setKind] = useState<WriteKind>(initialKind);
  const [lang, setLang] = useState<'fa' | 'en'>(uiLocale() === 'en' ? 'en' : 'fa');
  const [rewrite, setRewrite] = useState(Boolean(value.trim()));
  const [draft, setDraft] = useState('');
  const [state, setState] = useState<'idle' | 'writing' | 'done'>('idle');
  const [waiting, setWaiting] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const write = async () => {
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setDraft(''); setError(null); setWaiting(null); setState('writing');
    try {
      await streamEvents('/api/v1/ai/write', { kind, instruction, text: rewrite ? value : null, locale: lang }, (e) => {
        if (e.event === 'queue') setWaiting(e.data.position as number);
        if (e.event === 'delta') { setWaiting(null); setDraft((d) => d + (e.data.text as string)); }
        if (e.event === 'error') setError(e.data.message as string);
      }, ctrl.signal);
      setState('done');
    } catch (e) {
      if (!ctrl.signal.aborted) { setError((e as Error).message); setState('idle'); }
    }
  };
  const close = () => { abort.current?.abort(); onClose(); };

  return (
    <Modal open title={tr('نوشتن با دستیار')} onClose={close} wide>
      <div className="space-y-3">
        <Field label={rewrite ? tr('چه تغییری بدهد؟') : tr('چه بنویسد؟')} required>
          <Input value={instruction} onChange={(e) => setInstruction(e.target.value)} maxLength={2000} autoFocus
            placeholder={rewrite ? tr('مثلاً: رسمی‌تر و کوتاه‌تر کن') : tr('مثلاً: بریف کمپین معرفی محصول جدید برای جوانان شهری')} />
        </Field>
        <div className="flex flex-wrap items-end gap-3">
          <Field label={tr('نوع متن')}>
            <Select value={kind} onChange={(e) => setKind(e.target.value as WriteKind)}>
              <option value="brief">{tr('بریف')}</option>
              <option value="proposal">{tr('پروپوزال')}</option>
              <option value="email">{tr('ایمیل')}</option>
              <option value="minutes">{tr('صورت‌جلسه')}</option>
              <option value="other">{tr('متن دیگر')}</option>
            </Select>
          </Field>
          <Field label={tr('زبان')}>
            <Select value={lang} onChange={(e) => setLang(e.target.value as 'fa' | 'en')}>
              <option value="fa">{tr('فارسی')}</option>
              <option value="en">English</option>
            </Select>
          </Field>
          {value.trim() && <Checkbox label={tr('بازنویسی متن فعلی فرم')} checked={rewrite} onChange={(e) => setRewrite(e.target.checked)} />}
        </div>
        <Button variant="primary" onClick={() => void write()} disabled={!instruction.trim() || state === 'writing'} loading={state === 'writing'}>
          {state === 'done' ? tr('دوباره بنویس') : tr('بنویس')}
        </Button>
        {waiting != null && <p className="text-xs text-ink-500">{tr('دستیار مشغول پاسخ به دیگران است؛ نوبت شما: {0}', String(waiting))}</p>}
        {error && <p className="text-xs text-rose-700" role="alert">{error}</p>}
        {(draft || state === 'writing') && (
          <Field label={tr('پیش‌نویس — پیش از گذاشتن در فرم می‌توانید ویرایشش کنید')}>
            <Textarea rows={10} value={draft} onChange={(e) => setDraft(e.target.value)} dir={lang === 'en' ? 'ltr' : 'rtl'} data-testid="write-draft" />
          </Field>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={close}>{tr('انصراف')}</Button>
          <Button variant="primary" onClick={() => onUse(draft.trim())} disabled={state !== 'done' || !draft.trim()}>{tr('گذاشتن در فرم')}</Button>
        </div>
      </div>
    </Modal>
  );
}
