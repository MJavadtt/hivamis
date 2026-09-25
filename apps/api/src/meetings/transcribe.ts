/**
 * Speech to text for meeting recordings (roadmap #23) — an adapter.
 *
 * Persian speech recognition is a model this repository does not ship and a service it cannot
 * hold credentials for. What it can do is speak the one interface nearly every option exposes:
 * an OpenAI-shaped `POST /audio/transcriptions` (multipart: `file`, `model`, `language`). A hosted
 * service, or a whisper.cpp / faster-whisper server on the organisation's own network — which is
 * what an on-prem deployment without egress will run — both answer it. Configure TRANSCRIPTION_URL
 * (+ TRANSCRIPTION_MODEL, TRANSCRIPTION_API_KEY).
 *
 * Unconfigured, it says so. It never pretends to have heard a recording, because a minutes draft
 * built from an imagined transcript is worse than none: the notes can always be typed.
 */
import { env } from '../env.js';
import { AppError } from '../lib/errors.js';

export const transcriptionConfigured = () => env.TRANSCRIPTION_URL.length > 0;

export async function transcribe(audio: Buffer, fileName: string, mimeType: string): Promise<{ text: string; model: string }> {
  if (!transcriptionConfigured()) {
    throw new AppError(501, 'TRANSCRIPTION_NOT_CONFIGURED',
      'رونویسی صوت پیکربندی نشده است — متن یادداشت‌های جلسه را وارد کنید تا پیش‌نویس صورتجلسه ساخته شود.');
  }
  const form = new FormData();
  form.append('file', new Blob([audio], { type: mimeType }), fileName);
  form.append('model', env.TRANSCRIPTION_MODEL);
  form.append('language', 'fa');
  form.append('response_format', 'json');
  let res: Response;
  try {
    res = await fetch(env.TRANSCRIPTION_URL, {
      method: 'POST',
      headers: env.TRANSCRIPTION_API_KEY ? { authorization: `Bearer ${env.TRANSCRIPTION_API_KEY}` } : {},
      body: form,
      signal: AbortSignal.timeout(10 * 60_000),
    });
  } catch {
    throw new AppError(502, 'TRANSCRIPTION_UNREACHABLE', 'سرویس رونویسی در دسترس نیست — دوباره تلاش کنید یا متن را وارد کنید.');
  }
  if (!res.ok) {
    throw new AppError(502, 'TRANSCRIPTION_FAILED', `سرویس رونویسی پاسخ ${res.status} داد — متن را دستی وارد کنید.`);
  }
  const body = (await res.json().catch(() => null)) as { text?: string } | null;
  if (!body?.text?.trim()) {
    throw new AppError(502, 'TRANSCRIPTION_EMPTY', 'سرویس رونویسی متنی برنگرداند.');
  }
  return { text: body.text.trim(), model: env.TRANSCRIPTION_MODEL };
}
