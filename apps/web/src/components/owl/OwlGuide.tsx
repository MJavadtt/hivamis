import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { guideFor, searchGuide, type GuideSection } from '@hiva/contracts';
import { useAuth } from '../../lib/auth';
import { apiDelete, apiGet, apiUpload } from '../../lib/api';
import { assistantBus, guideBus, guideLocale, gt, owlPrefs, sectionsFor, stepDuration } from '../../lib/guide';
import { useDismissable } from '../../hooks/useDismissable';
import { Button, cx, Modal, useToast } from '../ui';
import { HelpDrawer } from '../HelpDrawer';
import { formatNumber, localDigits } from '../../lib/format';
import { tr } from '../../i18n';
import { Owl, OwlSvg } from './Owl';
import type { OwlMood } from './mood';
import { drawnAt, flightPath, hover, type Flight, type Point } from './flight';

/**
 * Hiva the owl (Hivamis task 8): the guide, in person. It sits in the corner of every page; a click
 * opens what this page is for and how to do the usual things here, in the reader's language. «نمایش
 * گام‌به‌گام» plays the page like a video — the owl flies to each thing it talks about, the rest of
 * the page dims, and the steps move on by themselves — and a recorded video plays where the
 * organisation has added one. Asked a question, it answers from the guide at once, and passes it to
 * the assistant for anything more.
 *
 * It gets about by flying (flight.ts): in along an arc when it first appears in a session, from one
 * thing to the next during a tour, home to its corner afterwards, and up off its perch when clicked.
 */

const ARRIVED_KEY = 'hiva.owl.arrived';
const ENTRANCE_DELAY = 1200;
/** Where the owl was last drawn, kept past a remount (the app rebuilds its frame as it loads) so a
 * flight under way carries on instead of starting over or snapping to the end. */
const memory: { at: Point | null; entranceAt?: number } = { at: null };
const arrived = () => { try { return sessionStorage.getItem(ARRIVED_KEY) === '1'; } catch { return true; } };
const stillPreferred = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

interface Video { id: string; sectionId: string; locale: 'fa' | 'en'; title: string; sizeBytes: number; createdAt: string }
interface Tour { section: GuideSection; index: number; playing: boolean; done: boolean }
interface Rect { top: number; left: number; width: number; height: number }

const GAP = 16;
const useViewport = () => {
  const [vp, setVp] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const on = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return vp;
};
const rtl = () => document.documentElement.dir !== 'ltr';

/** The first visible element a step points at, waiting a little for a page still loading. */
async function findTarget(selector: string | undefined, signal: { cancelled: boolean }): Promise<HTMLElement | null> {
  if (!selector) return null;
  for (let i = 0; i < 12 && !signal.cancelled; i++) {
    const hit = [...document.querySelectorAll<HTMLElement>(selector)].find((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    });
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

export function OwlGuide() {
  const { can, canAny } = useAuth();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const vp = useViewport();
  const section = guideFor(pathname);
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(owlPrefs.hidden);
  const [greeting, setGreeting] = useState(false);
  const [mood, setMood] = useState<OwlMood>('idle');
  const [tour, setTour] = useState<Tour | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [pending, setPending] = useState<{ sectionId: string; step: number } | null>(null);
  const [manual, setManual] = useState<string | null>(null);
  // A video playing over the panel takes Escape and outside clicks for itself.
  const [layered, setLayered] = useState(false);
  const size = vp.w < 640 ? 64 : 88;

  const startTour = useCallback((s: GuideSection, step = 0, playing = true) => {
    setOpen(false);
    setGreeting(false);
    setTour({ section: s, index: Math.max(0, Math.min(step, s.steps.length - 1)), playing, done: false });
  }, []);

  // The ? in the top bar, and tours asked for from elsewhere.
  useEffect(() => guideBus.on((signal) => {
    if (signal.type === 'open') { setTour(null); setOpen(true); return; }
    const s = sectionsFor(can as never, canAny as never).find((x) => x.id === signal.sectionId);
    if (s) startTour(s, signal.step ?? 0);
  }), [can, canAny, startTour]);

  // A new page ends a tour of the old one — unless the tour was asked for on the new page.
  useEffect(() => {
    setTour(null);
    if (pending && guideFor(pathname)?.id === pending.sectionId) {
      const s = guideFor(pathname)!;
      const step = pending.step;
      setPending(null);
      const id = setTimeout(() => startTour(s, step), 500);
      return () => clearTimeout(id);
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Hello, once.
  useEffect(() => {
    if (hidden || owlPrefs.greeted()) return;
    const id = setTimeout(() => { setGreeting(true); setMood('wave'); }, arrived() ? 1500 : ENTRANCE_DELAY + 2000);
    return () => clearTimeout(id);
  }, [hidden]);

  // A step: find what it is about, bring it into view, and keep the light on it.
  useEffect(() => {
    if (!tour || tour.done) { setRect(null); return; }
    const step = tour.section.steps[tour.index]!;
    const signal = { cancelled: false };
    let el: HTMLElement | null = null;
    let raf = 0;
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (!el) return;
        const r = el.getBoundingClientRect();
        setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
      });
    };
    setMood('hop');
    void findTarget(step.target, signal).then((found) => {
      if (signal.cancelled) return;
      el = found;
      if (!el) { setRect(null); return; }
      const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      el.scrollIntoView?.({ block: 'center', inline: 'nearest', behavior: still ? 'auto' : 'smooth' });
      setTimeout(measure, still ? 0 : 380);
    });
    const talk = setTimeout(() => setMood('talk'), 650);
    const quiet = setTimeout(() => setMood('idle'), 650 + Math.min(3500, stepDuration(gt(step.body)) * 0.5));
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      signal.cancelled = true;
      cancelAnimationFrame(raf);
      clearTimeout(talk);
      clearTimeout(quiet);
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [tour?.section, tour?.index, tour?.done]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (tour?.done) setMood('wave'); }, [tour?.done]);
  useEffect(() => { if (open) setMood('talk'); const id = setTimeout(() => setMood('idle'), 1600); return () => clearTimeout(id); }, [open]);

  // Where the owl is: in its corner, or beside what the tour is showing.
  const cardW = Math.min(340, vp.w - 24);
  const cardH = 190;
  const card = useMemo(() => {
    if (!tour) return null;
    if (!rect || tour.done) return { left: (vp.w - cardW) / 2, top: Math.max(size, (vp.h - cardH) / 2) };
    const below = rect.top + rect.height + GAP + size * 0.6;
    const top = below + cardH < vp.h ? below : rect.top - GAP - cardH >= size * 0.6 ? rect.top - GAP - cardH : Math.max(size * 0.6, vp.h - cardH - GAP);
    const left = Math.max(12, Math.min(vp.w - cardW - 12, rect.left + rect.width / 2 - cardW / 2));
    return { left, top };
  }, [tour, rect, vp, cardW, size]);
  const restX = rtl() ? GAP : vp.w - GAP - size;
  const restY = vp.h - GAP - size;
  const owlX = card ? (rtl() ? card.left + cardW - size * 0.8 : card.left - size * 0.2) : restX;
  const owlY = card ? Math.max(4, card.top - size * 0.72) : restY;
  const showOwl = !hidden || open || !!tour;

  // The flight from wherever the owl is drawn now to wherever it should be.
  const perch = useRef<HTMLButtonElement>(null);
  const placed = useRef<Point | null>(null);
  const [flying, setFlying] = useState(false);
  const [heading, setHeading] = useState(0);
  const fly = useCallback((el: HTMLButtonElement, path: Flight, land: Point) => {
    const anim = el.animate(path.keyframes, { duration: path.duration, easing: 'cubic-bezier(.4,.1,.3,1)', fill: 'forwards' });
    setFlying(true);
    setHeading(path.heading);
    anim.onfinish = () => {
      el.style.transform = `translate3d(${land.x}px, ${land.y}px, 0)`;
      anim.cancel();
      setFlying(false);
      setHeading(0);
    };
    return anim;
  }, []);
  useLayoutEffect(() => {
    const el = perch.current;
    if (!el) { placed.current = null; return undefined; }
    const to = { x: owlX, y: owlY };
    // From where it is drawn — mid-flight, where the flight has got to; after a remount, where it was;
    // the first time this session, from above its corner: it flies in.
    let from = el.getAnimations?.().length || el.style.transform ? drawnAt(el) : memory.at;
    const entrance = !arrived();
    if (from === null && entrance) from = { x: to.x + (rtl() ? 120 : -120), y: -size * 1.6 };
    placed.current = to;
    const moved = from && Math.hypot(from.x - to.x, from.y - to.y) > 2;
    el.getAnimations?.().forEach((a) => a.cancel());
    if (!moved || stillPreferred() || typeof el.animate !== 'function') {
      el.style.transform = `translate3d(${to.x}px, ${to.y}px, 0)`;
      memory.at = to;
      setFlying(false);
      try { sessionStorage.setItem(ARRIVED_KEY, '1'); } catch { /* private mode */ }
      return undefined;
    }
    let anim: Animation | null = null;
    const takeOff = () => {
      anim = fly(el, flightPath(from!, to), to);
      const landed = anim.onfinish;
      anim.onfinish = (e) => {
        landed?.call(anim!, e);
        memory.at = to;
        try { sessionStorage.setItem(ARRIVED_KEY, '1'); } catch { /* private mode */ }
      };
    };
    // The entrance waits for the page to settle: a flight drawn while the page is still loading
    // arrives in two jumps.
    let wait = 0;
    let idle = 0;
    if (entrance) {
      el.style.transform = `translate3d(${from!.x}px, ${from!.y}px, 0)`;
      memory.entranceAt ??= performance.now() + ENTRANCE_DELAY;
      wait = window.setTimeout(() => {
        if (typeof requestIdleCallback === 'function') idle = requestIdleCallback(takeOff, { timeout: 1500 });
        else takeOff();
      }, Math.max(0, memory.entranceAt - performance.now()));
    } else {
      takeOff();
    }
    return () => {
      clearTimeout(wait);
      if (idle) cancelIdleCallback(idle);
      if (anim) anim.onfinish = null;
      // Leaving mid-flight (a remount, a new target): remember where it had got to.
      memory.at = drawnAt(el) ?? memory.at;
    };
  }, [owlX, owlY, showOwl, size, fly]);
  const flutter = () => {
    const el = perch.current;
    if (!el || !placed.current || stillPreferred() || typeof el.animate !== 'function' || el.getAnimations?.().length) return;
    fly(el, hover(placed.current), placed.current);
  };

  // Toasts stand clear of the owl.
  useEffect(() => {
    document.documentElement.style.setProperty('--toast-offset', showOwl && !tour ? `${size + GAP * 1.5}px` : '1rem');
  }, [showOwl, tour, size]);

  const lookAt = rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
  const corner = useDismissable<HTMLDivElement>({ open: open && !tour && !layered, onClose: () => setOpen(false), restoreFocus: false });

  return (
    <>
      {tour && <Spotlight rect={tour.done ? null : rect} />}
      <div ref={corner}>
        {showOwl && (
          <button
            type="button"
            data-tour="owl"
            ref={perch}
            onClick={() => { if (tour) return; setGreeting(false); owlPrefs.setGreeted(); if (!open) flutter(); setOpen((o) => !o); }}
            aria-label={tr('هیوا — راهنمای این صفحه')}
            aria-expanded={open}
            title={tr('هیوا — راهنمای این صفحه')}
            data-mood={flying ? 'fly' : mood}
            className="fixed left-0 top-0 z-[55] rounded-full outline-none will-change-transform focus-visible:ring-2 focus-visible:ring-brand-500"
            style={{ width: size, height: size }}
          >
            <Owl size={size} mood={flying ? 'fly' : mood} heading={heading} lookAt={flying ? null : lookAt} />
          </button>
        )}
        {greeting && !open && !tour && (
          <div role="status" className="bg-panel animate-in fixed z-[55] w-64 rounded-2xl p-3 text-sm leading-6 text-ink-700 shadow-glass ring-1 ring-edge"
            style={{ insetInlineEnd: GAP + size * 0.4, bottom: GAP + size + 6 }}>
            {tr('سلام! من هیوا هستم. هر جا سؤالی داشتید، روی من بزنید تا راهنمای همان صفحه را بگویم.')}
            <div className="mt-2 flex justify-end">
              <Button size="sm" variant="secondary" onClick={() => { setGreeting(false); owlPrefs.setGreeted(); setMood('idle'); }}>{tr('باشه')}</Button>
            </div>
          </div>
        )}
        {open && !tour && (
          <GuidePanel
            section={section}
            bottom={showOwl ? GAP + size + 8 : GAP}
            hidden={hidden}
            onHide={(h) => { setHidden(h); owlPrefs.setHidden(h); }}
            onClose={() => setOpen(false)}
            onTour={(s, step) => {
              if (s.id === section?.id) { startTour(s, step); return; }
              if (s.path) { setOpen(false); setPending({ sectionId: s.id, step }); navigate(s.path); }
            }}
            onManual={(m) => { setOpen(false); setManual(m); }}
            onLayer={setLayered}
          />
        )}
      </div>
      {tour && card && (
        <TourCard
          tour={tour}
          style={{ left: card.left, top: card.top, width: cardW }}
          missing={!rect && !tour.done && !!tour.section.steps[tour.index]?.target}
          onMove={(index) => setTour((x) => x && ({ ...x, index, done: false }))}
          onPlay={(playing) => setTour((x) => x && ({ ...x, playing }))}
          onDone={() => setTour((x) => x && ({ ...x, done: true, playing: false }))}
          onClose={() => { setTour(null); setMood('idle'); }}
          onReplay={() => setTour((x) => x && ({ ...x, index: 0, playing: true, done: false }))}
        />
      )}
      <HelpDrawer open={manual !== null} onClose={() => setManual(null)} initialSection={manual ?? undefined} />
    </>
  );
}

/** Everything dims but the thing being talked about. */
function Spotlight({ rect }: { rect: Rect | null }) {
  const pad = 6;
  return rect ? (
    <div aria-hidden className="pointer-events-none fixed z-[54] rounded-xl ring-2 ring-brand-400 transition-all duration-300 motion-reduce:transition-none"
      style={{ top: rect.top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: rect.height + pad * 2, boxShadow: '0 0 0 9999px rgba(15, 23, 42, 0.55)' }} />
  ) : <div aria-hidden className="pointer-events-none fixed inset-0 z-[54] bg-ink-900/55" />;
}

function TourCard({ tour, style, missing, onMove, onPlay, onDone, onClose, onReplay }: {
  tour: Tour; style: React.CSSProperties; missing: boolean;
  onMove: (i: number) => void; onPlay: (p: boolean) => void; onDone: () => void; onClose: () => void; onReplay: () => void;
}) {
  const { section, index, playing, done } = tour;
  const steps = section.steps;
  const step = steps[index]!;
  const duration = stepDuration(gt(step.body));
  const clock = useRef({ spent: 0, since: Date.now() });
  const box = useRef<HTMLDivElement>(null);
  const last = index === steps.length - 1;
  const next = useCallback(() => (last ? onDone() : onMove(index + 1)), [last, index, onDone, onMove]);

  useEffect(() => { clock.current = { spent: 0, since: Date.now() }; }, [index]);
  useEffect(() => {
    if (!playing || done) { clock.current.spent += Date.now() - clock.current.since; return; }
    clock.current.since = Date.now();
    const id = setTimeout(next, Math.max(0, duration - clock.current.spent));
    return () => clearTimeout(id);
  }, [playing, done, index, duration, next]);
  useEffect(() => { box.current?.querySelector<HTMLButtonElement>('[data-autofocus]')?.focus(); }, [done]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
      if (done) return;
      const forward = rtl() ? 'ArrowLeft' : 'ArrowRight';
      const back = rtl() ? 'ArrowRight' : 'ArrowLeft';
      if (e.key === forward) next();
      else if (e.key === back && index > 0) onMove(index - 1);
      else if (e.key === ' ' && (e.target as HTMLElement)?.tagName !== 'BUTTON') { e.preventDefault(); onPlay(!playing); }
    };
    document.addEventListener('keydown', key, true);
    return () => document.removeEventListener('keydown', key, true);
  }, [done, index, playing, next, onMove, onPlay, onClose]);

  return (
    <div ref={box} role="dialog" aria-label={tr('راهنمای «{0}»', gt(section.title))} data-testid="tour"
      className="bg-panel animate-in fixed z-[56] rounded-2xl p-4 pt-5 shadow-2xl ring-1 ring-edge" style={style}>
      {done ? (
        <div className="space-y-3 text-center">
          <p className="text-sm font-semibold text-ink-900">{tr('پایان راهنمای «{0}»', gt(section.title))}</p>
          <p className="text-xs text-ink-500">{tr('هر وقت خواستید، دوباره روی من بزنید.')}</p>
          <div className="flex justify-center gap-2">
            <Button size="sm" variant="secondary" onClick={onReplay}>{tr('دوباره')}</Button>
            <Button size="sm" variant="primary" data-autofocus onClick={onClose}>{tr('بستن')}</Button>
          </div>
        </div>
      ) : (
        <>
          <p className="text-[12.5px] font-medium text-brand-700">{tr('گام {0} از {1}', localDigits(index + 1), localDigits(steps.length))} · {gt(section.title)}</p>
          <h3 className="mt-1 text-sm font-semibold text-ink-900">{gt(step.title)}</h3>
          <p aria-live="polite" className="mt-1 text-sm leading-6 text-ink-700">{gt(step.body)}</p>
          {missing && <p className="mt-1 text-[12.5px] text-ink-400">{tr('این بخش الان روی صفحه نیست — شاید در زبانهٔ دیگری است یا برای نقش شما نمایش داده نمی‌شود.')}</p>}
          <div className="mt-3 h-1 overflow-hidden rounded-full bg-ink-100" aria-hidden>
            <div key={index} className="tour-progress h-full rounded-full bg-brand-500"
              style={{ animationDuration: `${duration}ms`, animationPlayState: playing ? 'running' : 'paused' }} />
          </div>
          <div className="mt-3 flex items-center gap-1.5">
            <Button size="sm" variant="ghost" disabled={index === 0} onClick={() => onMove(index - 1)} aria-label={tr('گام قبلی')}>{rtl() ? '→' : '←'}</Button>
            <Button size="sm" variant="secondary" data-autofocus onClick={() => onPlay(!playing)}>{playing ? tr('توقف') : tr('پخش')}</Button>
            <Button size="sm" variant="ghost" onClick={next} aria-label={tr('گام بعدی')}>{rtl() ? '←' : '→'}</Button>
            <span className="flex-1" />
            <Button size="sm" variant="ghost" onClick={onClose}>{tr('بستن')}</Button>
          </div>
        </>
      )}
    </div>
  );
}

function GuidePanel({ section, bottom, hidden, onHide, onClose, onTour, onManual, onLayer }: {
  section: GuideSection | undefined; bottom: number; hidden: boolean;
  onHide: (hidden: boolean) => void; onClose: () => void;
  onTour: (s: GuideSection, step: number) => void; onManual: (heading: string) => void;
  onLayer: (layered: boolean) => void;
}) {
  const { can, canAny } = useAuth();
  const [q, setQ] = useState('');
  const [others, setOthers] = useState(false);
  const [video, setVideo] = useState<Video | null>(null);
  useEffect(() => { onLayer(!!video); return () => onLayer(false); }, [video, onLayer]);
  const allowed = useMemo(() => sectionsFor(can as never, canAny as never), [can, canAny]);
  const allowedIds = useMemo(() => new Set(allowed.map((s) => s.id)), [allowed]);
  const answers = useMemo(() => (q.trim().length < 2 ? [] : searchGuide(q, guideLocale(), 8).filter((m) => allowedIds.has(m.section.id)).slice(0, 5)), [q, allowedIds]);
  const { data: videos } = useQuery<Video[]>({ queryKey: ['/guide/videos'], queryFn: () => apiGet('/guide/videos'), staleTime: 300_000 });
  const mine = section && videos?.filter((v) => v.sectionId === section.id).sort((a) => (a.locale === guideLocale() ? -1 : 1))[0];
  const seconds = section ? Math.round(section.steps.reduce((n, st) => n + stepDuration(gt(st.body)), 0) / 1000) : 0;

  return (
    <section role="dialog" aria-label={tr('راهنمای هیوا')} data-testid="owl-panel"
      className="animate-in fixed z-[55] flex max-h-[70vh] w-[min(380px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl bg-panel shadow-2xl ring-1 ring-edge"
      style={{ bottom, insetInlineEnd: GAP }}>
      <header className="flex items-center gap-2 border-b border-ink-100 px-4 py-2.5">
        <OwlSvg size={28} />
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] text-ink-500">{tr('هیوا، راهنمای شما')}</p>
          <h2 className="truncate text-sm font-semibold text-ink-900">{section ? gt(section.title) : tr('راهنما')}</h2>
        </div>
        <button type="button" onClick={onClose} aria-label={tr('بستن')} className="rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700">✕</button>
      </header>
      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3">
        {section ? (
          <>
            <p className="text-sm leading-6 text-ink-700">{gt(section.summary)}</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="primary" onClick={() => onTour(section, 0)}>
                ▶ {tr('نمایش گام‌به‌گام')}
                <span className="ms-1 text-[12.5px] opacity-80">{tr('{0} گام · حدود {1} ثانیه', localDigits(section.steps.length), localDigits(seconds))}</span>
              </Button>
              {mine && <Button size="sm" variant="secondary" onClick={() => setVideo(mine)}>{tr('ویدیوی این بخش')}{mine.locale !== guideLocale() && <span className="ms-1 text-[12.5px] opacity-70">({mine.locale === 'fa' ? 'فارسی' : 'English'})</span>}</Button>}
            </div>
            <ol className="space-y-1">
              {section.steps.map((st, i) => (
                <li key={i}>
                  <button type="button" onClick={() => onTour(section, i)} className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-start hover:bg-ink-50">
                    <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-brand-50 text-[12.5px] font-semibold text-brand-700">{localDigits(i + 1)}</span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-ink-800">{gt(st.title)}</span>
                      <span className="block text-xs leading-5 text-ink-500">{gt(st.body)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </>
        ) : <p className="text-sm leading-6 text-ink-700">{tr('برای این صفحه راهنمای جداگانه‌ای نیست؛ سؤالتان را بپرسید یا بخش دیگری را انتخاب کنید.')}</p>}

        <div className="space-y-2">
          <label className="block text-xs font-medium text-ink-600" htmlFor="owl-ask">{tr('از هیوا بپرسید')}</label>
          <input id="owl-ask" value={q} onChange={(e) => setQ(e.target.value)} dir="auto" placeholder={tr('مثلاً: چطور فرمی را تأیید کنم؟')}
            className="w-full rounded-lg bg-surface px-3 py-2 text-sm text-ink-800 ring-1 ring-inset ring-ink-200 focus:outline-none focus:ring-2 focus:ring-brand-500" />
          {q.trim().length >= 2 && (
            <div className="space-y-1.5" data-testid="owl-answers">
              {answers.length ? answers.map((m, i) => {
                const stepIndex = m.step ? m.section.steps.indexOf(m.step) : 0;
                const here = m.section.id === section?.id;
                const reachable = here || !!m.section.path;
                return (
                  <button key={i} type="button" disabled={!reachable} onClick={() => onTour(m.section, stepIndex)}
                    className="block w-full rounded-lg bg-ink-50 px-3 py-2 text-start ring-1 ring-inset ring-ink-200 enabled:hover:bg-brand-50 disabled:cursor-default">
                    <span className="block text-[12.5px] text-brand-700">{gt(m.section.title)}{m.step ? ` › ${gt(m.step.title)}` : ''}</span>
                    <span className="block text-xs leading-5 text-ink-700">{gt(m.step ? m.step.body : m.section.summary)}</span>
                    {reachable && <span className="mt-0.5 block text-[12.5px] text-ink-400">{here ? tr('نشانم بده') : tr('برو و نشانم بده')}</span>}
                  </button>
                );
              }) : <p className="text-xs text-ink-500">{tr('در راهنما چیزی پیدا نکردم.')}</p>}
              {can('ai.chat') && (
                <Button size="sm" variant="ghost" onClick={() => { onClose(); assistantBus.ask(q.trim()); }}>{tr('از دستیار بپرسید')}</Button>
              )}
            </div>
          )}
        </div>

        <div>
          <button type="button" onClick={() => setOthers((o) => !o)} className="text-xs font-medium text-ink-600 hover:text-brand-700" aria-expanded={others}>
            {others ? '▾' : '▸'} {tr('راهنمای بخش‌های دیگر')}
          </button>
          {others && (
            <ul className="mt-1.5 grid grid-cols-2 gap-1">
              {allowed.filter((s) => s.path && s.id !== section?.id).map((s) => (
                <li key={s.id}>
                  <button type="button" onClick={() => onTour(s, 0)} className="w-full truncate rounded-md px-2 py-1 text-start text-xs text-ink-700 hover:bg-ink-50">{gt(s.title)}</button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {section && can('admin.settings') && <VideoAdmin section={section} videos={videos?.filter((v) => v.sectionId === section.id) ?? []} />}
      </div>
      <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-ink-100 px-4 py-2 text-xs">
        <button type="button" className="text-brand-700 hover:underline" onClick={() => onManual(section?.manual ?? '')}>{tr('راهنمای کامل نوشتاری')}</button>
        <span className="flex-1" />
        <button type="button" className="text-ink-500 hover:text-ink-800" onClick={() => onHide(!hidden)}>
          {hidden ? tr('نمایش هیوا در گوشهٔ صفحه') : tr('پنهان کردن هیوا')}
        </button>
      </footer>
      {video && <VideoPlayer video={video} onClose={() => setVideo(null)} />}
    </section>
  );
}

function VideoPlayer({ video, onClose }: { video: Video; onClose: () => void }) {
  const { data, error } = useQuery<{ url: string }>({ queryKey: ['/guide/videos/link', video.id], queryFn: () => apiGet(`/guide/videos/${video.id}/link`), staleTime: 3_600_000 });
  return (
    <Modal open wide title={video.title} onClose={onClose}>
      {error ? <p className="text-sm text-rose-700">{(error as Error).message}</p>
        : data ? <video src={data.url} controls autoPlay playsInline className="w-full rounded-lg bg-black" data-testid="guide-video" />
        : <p className="text-sm text-ink-500">{tr('در حال بارگذاری…')}</p>}
    </Modal>
  );
}

/** The system administrator adds, replaces or removes this section's recording, one per language. */
function VideoAdmin({ section, videos }: { section: GuideSection; videos: Video[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const upload = async (locale: 'fa' | 'en', file: File) => {
    setBusy(locale);
    try {
      const form = new FormData();
      form.append('file', file);
      await apiUpload(`/guide/videos?sectionId=${section.id}&locale=${locale}&title=${encodeURIComponent(section.title[locale])}`, form);
      await qc.invalidateQueries({ queryKey: ['/guide/videos'] });
      toast(tr('ویدیو گذاشته شد.'));
    } catch (e) {
      toast((e as Error).message, 'danger');
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="rounded-lg bg-ink-50 p-3 ring-1 ring-inset ring-ink-200" data-testid="video-admin">
      <p className="text-xs font-medium text-ink-700">{tr('ویدیوی این بخش (مدیر سیستم)')}</p>
      <p className="mt-0.5 text-[12.5px] leading-5 text-ink-500">{tr('یک فیلم ضبط‌شده از صفحه برای هر زبان — MP4 یا WebM.')}</p>
      {(['fa', 'en'] as const).map((locale) => {
        const v = videos.find((x) => x.locale === locale);
        return (
          <div key={locale} className="mt-2 flex items-center gap-2 text-xs">
            <span className="w-14 shrink-0 text-ink-600">{locale === 'fa' ? 'فارسی' : 'English'}</span>
            <span className={cx('min-w-0 flex-1 truncate', v ? 'text-ink-700' : 'text-ink-400')}>
              {v ? tr('{0} مگابایت', formatNumber(v.sizeBytes / 1_048_576, 1)) : tr('ندارد')}
            </span>
            <label className="cursor-pointer rounded-md bg-surface px-2 py-1 text-brand-700 ring-1 ring-inset ring-ink-200 hover:bg-brand-50">
              {busy === locale ? tr('در حال بارگذاری…') : v ? tr('جایگزینی') : tr('افزودن')}
              <input type="file" accept="video/mp4,video/webm" className="sr-only" disabled={!!busy}
                aria-label={tr('ویدیوی {0}', locale === 'fa' ? 'فارسی' : 'English')}
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void upload(locale, f); }} />
            </label>
            {v && (
              <button type="button" className="rounded-md px-1.5 py-1 text-ink-400 hover:bg-rose-50 hover:text-rose-700" aria-label={tr('حذف ویدیو')}
                onClick={async () => { await apiDelete(`/guide/videos/${v.id}`); await qc.invalidateQueries({ queryKey: ['/guide/videos'] }); }}>✕</button>
            )}
          </div>
        );
      })}
    </div>
  );
}
