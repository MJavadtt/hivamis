import { lazy, Suspense, useCallback, useState } from 'react';
import { cx } from '../ui';
import type { OwlMood } from './mood';

/**
 * Hiva the owl (Hivamis task 8). In three dimensions where the browser can draw them — the library
 * is loaded only when the owl first appears — and drawn flat everywhere else: an old machine, a
 * browser with WebGL off, the tests.
 */

const Owl3D = lazy(() => import('./Owl3D'));

let webgl: boolean | null = null;
export function canDraw3D(): boolean {
  if (webgl !== null) return webgl;
  try {
    if (typeof document === 'undefined' || /jsdom/i.test(navigator.userAgent)) return (webgl = false);
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext | null;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    webgl = !!gl;
  } catch {
    webgl = false;
  }
  return webgl;
}

export function Owl({ size, mood = 'idle', lookAt, className }: {
  size: number; mood?: OwlMood; lookAt?: { x: number; y: number } | null; className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const fail = useCallback(() => setFailed(true), []);
  const flat = <OwlSvg size={size} mood={mood} className={className} />;
  if (failed || !canDraw3D()) return flat;
  return (
    <Suspense fallback={flat}>
      <Owl3D size={size} mood={mood} lookAt={lookAt} onFail={fail} className={className} />
    </Suspense>
  );
}

/** The owl drawn flat: the same bird, the same cap. */
export function OwlSvg({ size, mood = 'idle', className }: { size: number; mood?: OwlMood; className?: string }) {
  return (
    <svg viewBox="0 0 100 112" width={size} height={size} aria-hidden data-owl="svg"
      className={cx('owl-svg', mood === 'talk' && 'owl-talk', mood === 'wave' && 'owl-wave', mood === 'think' && 'owl-think', className)}>
      <ellipse cx="50" cy="106" rx="26" ry="4" fill="#1e143c" opacity="0.15" />
      <g className="owl-body">
        <ellipse className="owl-wing-l" cx="22" cy="70" rx="9" ry="22" fill="#6e4529" transform="rotate(10 22 70)" />
        <ellipse className="owl-wing-r" cx="78" cy="70" rx="9" ry="22" fill="#6e4529" transform="rotate(-10 78 70)" />
        <ellipse cx="50" cy="70" rx="29" ry="32" fill="#8a5a3b" />
        <ellipse cx="50" cy="76" rx="19" ry="21" fill="#f2e2c4" />
        <g fill="none" stroke="#b98a5e" strokeWidth="1.6" strokeLinecap="round">
          <path d="M40 70l3 2 3-2M54 70l3 2 3-2M47 79l3 2 3-2M40 87l3 2 3-2M54 87l3 2 3-2" />
        </g>
        <g fill="#e98a1c">
          <ellipse cx="41" cy="102" rx="6" ry="2.6" />
          <ellipse cx="59" cy="102" rx="6" ry="2.6" />
        </g>
        <g className="owl-head">
          <path d="M24 26l4-14 9 9zM76 26l-4-14-9 9z" fill="#4b2e1c" />
          <ellipse cx="50" cy="38" rx="30" ry="24" fill="#8a5a3b" />
          <circle cx="38" cy="39" r="13" fill="#ecd9b8" />
          <circle cx="62" cy="39" r="13" fill="#ecd9b8" />
          <g className="owl-eyes">
            <circle cx="38" cy="39" r="9" fill="#fff" />
            <circle cx="62" cy="39" r="9" fill="#fff" />
            <circle cx="39" cy="40" r="6" fill="#f5a524" />
            <circle cx="61" cy="40" r="6" fill="#f5a524" />
            <circle cx="39.5" cy="40.5" r="3.4" fill="#1c1917" />
            <circle cx="60.5" cy="40.5" r="3.4" fill="#1c1917" />
            <circle cx="41" cy="38.5" r="1.3" fill="#fff" />
            <circle cx="62" cy="38.5" r="1.3" fill="#fff" />
          </g>
          <path d="M30 27q8-4 15 1M70 27q-8-4-15 1" fill="none" stroke="#4b2e1c" strokeWidth="2" strokeLinecap="round" />
          <path d="M46 47h8l-4 7z" fill="#e98a1c" />
          <path className="owl-jaw" d="M47.5 53h5l-2.5 3z" fill="#c76f12" />
          <g transform="rotate(6 50 14)">
            <rect x="39" y="11" width="22" height="7" rx="2" fill="#2563eb" />
            <path d="M50 2l20 8-20 8-20-8z" fill="#1d4ed8" />
            <circle cx="50" cy="10" r="1.6" fill="#f2c14e" />
            <path d="M50 10h17v10" fill="none" stroke="#f2c14e" strokeWidth="1.2" />
            <path d="M65 19h4l-2 6z" fill="#f2c14e" />
          </g>
        </g>
      </g>
    </svg>
  );
}
