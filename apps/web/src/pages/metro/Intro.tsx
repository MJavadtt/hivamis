import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../lib/auth';
import { tr } from '../../i18n';
import { HivaLogo } from '../../components/Brand';
import './intro.css';

/**
 * «هیواترو» (the owner, 2026-11-18): the metro module is new, so for a month its dashboard opens, once a
 * day for each person, with its name — in the project's own look: the app's pastel canvas, a glass card,
 * the Hiva mark revealed inside a ring of the accent, «هیواترو، ماژول مدیریت خدمات مترو هیوا», and a
 * metro line in the accent's gradient that a train glides along. A click, Escape or «رد کردن» closes it; it closes by itself after a few
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
      <span className="hm-halo" aria-hidden />
      <div className="hm-card">
        <div className="hm-mark-wrap">
          <svg className="hm-ring" viewBox="0 0 132 132" aria-hidden>
            <defs>
              <linearGradient id="hm-accent" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#6150ea" /><stop offset="0.48" stopColor="#4f5fe6" /><stop offset="1" stopColor="#336bd0" />
              </linearGradient>
            </defs>
            <circle cx="66" cy="66" r="62" />
          </svg>
          {/* The Hiva mark itself, in the ink of the page. */}
          <HivaLogo kind="mark" className="hm-mark" label="Hiva" />
        </div>
        <div className="hm-name" lang="fa">{tr('هیواترو')}</div>
        <div className="hm-tag">{tr('ماژول مدیریت خدمات مترو هیوا')}</div>
        <div className="hm-track" aria-hidden>
          <span className="hm-rail" />
          <span className="hm-stop" /><span className="hm-stop" /><span className="hm-stop" /><span className="hm-stop" />
          <span className="hm-train" />
        </div>
        <span className="hm-new">{tr('تازه')}</span>
      </div>
      <button ref={skip} type="button" className="hm-skip" onClick={(e) => { e.stopPropagation(); close(); }}>{tr('رد کردن')}</button>
    </div>
  );
}
