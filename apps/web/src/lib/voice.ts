import { apiUpload } from './api';
import { locale } from '../i18n';

/**
 * Speaking to the assistant, and hearing it (audit F-4). The browser records; the installation's own
 * speech server writes it down, so the audio never leaves the organisation. Reading a reply aloud uses
 * a voice on the device itself — never one the browser would fetch from the network.
 */

/** Long enough for what a person says to the assistant; a meeting has its own recorder. */
export const MAX_SECONDS = 120;

export const canRecord = (): boolean =>
  typeof window !== 'undefined' && typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

/** What this browser records in: Opus where it can, MP4 (Safari) otherwise. The server takes either. */
export function recordingType(): string | undefined {
  for (const type of ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4']) {
    if (MediaRecorder.isTypeSupported?.(type)) return type;
  }
  return undefined;
}

export async function transcribeVoice(audio: Blob): Promise<string> {
  const form = new FormData();
  const ext = audio.type.includes('mp4') ? 'm4a' : audio.type.includes('ogg') ? 'ogg' : 'webm';
  form.append('file', audio, `voice.${ext}`);
  return (await apiUpload<{ text: string }>('/ai/voice/transcribe', form)).text.trim();
}

/** A voice on this device for the reader's language, or none — then no "read aloud" is offered. */
export function localVoice(): SpeechSynthesisVoice | null {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null;
  const lang = locale();
  return window.speechSynthesis.getVoices().find((v) => v.localService && v.lang.toLowerCase().startsWith(lang)) ?? null;
}

/** The reply as it is heard: no markdown marks, no tables' rules, no codes spelled letter by letter. */
export function spoken(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*\|?[-:|\s]+\|?\s*$/gm, ' ')
    .replace(/[*_`#>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function speak(text: string, voice: SpeechSynthesisVoice, onEnd: () => void): void {
  const synth = window.speechSynthesis;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(spoken(text));
  u.voice = voice;
  u.lang = voice.lang;
  u.onend = onEnd;
  u.onerror = onEnd;
  synth.speak(u);
}

export const stopSpeaking = () => { if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel(); };
