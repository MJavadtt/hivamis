import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../lib/auth';
import { tr } from '../../i18n';
import './intro.css';

/**
 * «هیواترو» (the owner, 2026-11-18): the metro module is new, so for a month its dashboard opens, once a
 * day for each person, with its name — a metro map drawn into an H, a train across it, then «هیواترو،
 * ماژول مدیریت خدمات مترو هیوا». A click, Escape or «رد کردن» closes it; it closes by itself after a few
 * seconds. Remembered on this device by person and day; after its last day it is never shown again.
 */
export const INTRO_LAST_DAY = '2026-12-17';
const SHOWN_FOR = 5200;

/** Today in Tehran, as the person's day is counted. */
const tehranDay = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran' }).format(now);
const keyFor = (userId: string) => `hiva.metro.intro.${userId}`;

export function shouldShowIntro(userId: string | undefined, now = new Date()): boolean {
  if (!userId) return false;
  const day = tehranDay(now);
  if (day > INTRO_LAST_DAY) return false;
  try { return localStorage.getItem(keyFor(userId)) !== day; } catch { return false; }
}

export function MetroIntro() {
  const { user } = useAuth();
  const [open, setOpen] = useState(() => shouldShowIntro(user?.id));
  const [leaving, setLeaving] = useState(false);
  const skip = useRef<HTMLButtonElement>(null);
  const close = () => { setLeaving(true); setTimeout(() => setOpen(false), 450); };

  useEffect(() => {
    if (!open || !user) return;
    // Counted as seen when it opens: a reload in the middle does not show it again today.
    try { localStorage.setItem(keyFor(user.id), tehranDay()); } catch { /* a private window: shown, not remembered */ }
    skip.current?.focus();
    const done = setTimeout(close, SHOWN_FOR);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => { clearTimeout(done); window.removeEventListener('keydown', onKey); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;
  return (
    <div className={`hm-stage${leaving ? ' hm-leaving' : ''}`} role="dialog" aria-modal="true" aria-label={tr('هیواترو، ماژول مدیریت خدمات مترو هیوا')} onClick={close} data-testid="metro-intro">
      <span className="hm-glow hm-glow-a" aria-hidden /><span className="hm-glow hm-glow-b" aria-hidden /><span className="hm-glow hm-glow-c" aria-hidden />
      <div className="hm-card">
        <svg className="hm-mark" width="200" height="200" viewBox="0 0 200 200" aria-hidden>
          <defs>
            <linearGradient id="hm-ring-grad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#e2231a" /><stop offset="0.35" stopColor="#f8e100" /><stop offset="0.65" stopColor="#2fb4e9" /><stop offset="1" stopColor="#7f3f98" />
            </linearGradient>
          </defs>
          <circle className="hm-ring" cx="100" cy="100" r="92" />
          {/* An H drawn as a metro map: two lines up, one across. */}
          <path className="hm-line hm-line-1" d="M64 150 V50" />
          <path className="hm-line hm-line-2" d="M136 150 V50" />
          <path className="hm-line hm-line-3" d="M64 100 H136" />
          <circle className="hm-station hm-s1" cx="64" cy="50" r="8" />
          <circle className="hm-station hm-s2" cx="136" cy="150" r="8" />
          <circle className="hm-station hm-s3" cx="64" cy="100" r="9" />
          <circle className="hm-station hm-s4" cx="136" cy="100" r="9" />
          {/* The train, at rest on the crossing. */}
          <g className="hm-train">
            <rect x="80" y="89" width="40" height="22" rx="8" fill="#ffffff" />
            <rect x="85" y="93" width="9" height="7" rx="2" fill="#0d1024" /><rect x="96" y="93" width="9" height="7" rx="2" fill="#0d1024" /><rect x="107" y="93" width="9" height="7" rx="2" fill="#0d1024" />
            <rect x="84" y="104" width="32" height="3" rx="1.5" fill="#e2231a" />
          </g>
        </svg>
        <div className="hm-name" lang="fa">{tr('هیواترو')}</div>
        <div className="hm-rule" aria-hidden />
        <div className="hm-tag">{tr('ماژول مدیریت خدمات مترو هیوا')}</div>
        <span className="hm-new">{tr('تازه')}</span>
      </div>
      <button ref={skip} type="button" className="hm-skip" onClick={(e) => { e.stopPropagation(); close(); }}>{tr('رد کردن')}</button>
    </div>
  );
}
