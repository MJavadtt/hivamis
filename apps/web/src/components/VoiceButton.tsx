import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../lib/api';
import { canRecord, MAX_SECONDS, recordingType, transcribeVoice } from '../lib/voice';
import { cx, IconMic, Spinner } from './ui';
import { localDigits } from '../lib/format';
import { tr } from '../i18n';

/**
 * Speaking instead of typing (audit F-4). One press starts, the next stops; what was said comes back
 * as text for the person to read, correct and send — it is never sent for them. Shown only where the
 * installation has a speech server and the browser can record.
 */
export function VoiceButton({ onText, onError, large = false, className }: {
  onText: (text: string) => void; onError: (message: string) => void; large?: boolean; className?: string;
}) {
  const { data } = useQuery<{ configured: boolean }>({ queryKey: ['/ai/voice/status'], queryFn: () => apiGet('/ai/voice/status'), staleTime: 60_000 });
  // 'asking': the browser is asking the person for the microphone, which may take a while.
  const [state, setState] = useState<'idle' | 'asking' | 'recording' | 'working'>('idle');
  const [seconds, setSeconds] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const alive = useRef(true);

  const release = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    recorder.current?.stream.getTracks().forEach((t) => t.stop());
  };
  // Leaving the page stops the microphone — nothing records unseen.
  useEffect(() => () => {
    alive.current = false;
    const rec = recorder.current;
    if (rec?.state === 'recording') { rec.onstop = null; rec.stop(); }
    release();
  }, []);

  if (!data?.configured || !canRecord()) return null;

  const start = async () => {
    let stream: MediaStream;
    setState('asking');
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      if (!alive.current) return;
      setState('idle');
      onError((e as Error).name === 'NotAllowedError' || (e as Error).name === 'SecurityError'
        ? tr('اجازهٔ میکروفون داده نشد. آن را در تنظیمات مرورگر برای این نشانی باز کنید.')
        : tr('میکروفون در دسترس نیست؛ وصل بودنش را بررسی کنید.'));
      return;
    }
    // Closed while the browser was asking: the microphone is let go at once.
    if (!alive.current) { stream.getTracks().forEach((t) => t.stop()); return; }
    const type = recordingType();
    const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      release();
      setState('working');
      try {
        const text = await transcribeVoice(new Blob(chunks, { type: rec.mimeType || type || 'audio/webm' }));
        if (text) onText(text); else onError(tr('چیزی شنیده نشد؛ دوباره بگویید.'));
      } catch (e) {
        onError((e as Error).message);
      } finally {
        setState('idle');
      }
    };
    recorder.current = rec;
    rec.start();
    setSeconds(0);
    setState('recording');
    const began = Date.now();
    timer.current = setInterval(() => {
      const s = Math.floor((Date.now() - began) / 1000);
      setSeconds(s);
      if (s >= MAX_SECONDS && rec.state === 'recording') rec.stop();
    }, 500);
  };

  const label = state === 'recording' ? tr('پایان و نوشتن') : state === 'working' ? tr('در حال نوشتن آنچه گفتید…')
    : state === 'asking' ? tr('در انتظار اجازهٔ میکروفون…') : tr('گفتن با صدا');
  return (
    <button type="button" disabled={state === 'working' || state === 'asking'} aria-pressed={state === 'recording'} aria-label={label} title={label} data-testid="voice"
      onClick={() => { if (state === 'recording') recorder.current?.stop(); else if (state === 'idle') void start(); }}
      className={cx(
        'relative grid shrink-0 place-items-center rounded-full ring-1 ring-inset transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500 disabled:opacity-60',
        large ? 'size-14 shadow-lg' : 'size-10',
        state === 'recording' ? 'bg-rose-600 text-white ring-rose-700' : large ? 'btn-accent text-white ring-transparent' : 'bg-surface text-ink-600 ring-ink-200 hover:text-brand-700',
        className,
      )}>
      {state === 'working' || state === 'asking' ? <Spinner className={large ? 'size-6' : 'size-4'} /> : <IconMic className={large ? 'size-6' : 'size-5'} />}
      {state === 'recording' && (
        <span className="absolute -top-2 rounded-full bg-rose-700 px-1.5 text-[12px] font-medium leading-5 text-white" aria-live="polite">{localDigits(seconds)}</span>
      )}
    </button>
  );
}
