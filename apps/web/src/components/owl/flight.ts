/**
 * How Hiva gets from one place to another: it flies. The path is an arc — up and over, never a slide
 * along the glass — with the bird banking into the turn and growing a little at the top of the arc, as
 * something closer to the viewer would. Longer trips take longer, within bounds a person will wait for.
 */

export interface Point { x: number; y: number }
export interface Flight {
  duration: number;
  keyframes: Keyframe[];
  /** Which way it is headed, −1 (left) to 1 (right): the bird turns its body to face it. */
  heading: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function flightPath(from: Point, to: Point, steps = 28): Flight {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  // The arc rises above the higher of the two ends; a short hop still clears the ground.
  const rise = clamp(dist * 0.35, 36, 180);
  const control = { x: from.x + dx / 2, y: Math.min(from.y, to.y) - rise };
  const keyframes: Keyframe[] = [];
  let prev = from;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const x = u * u * from.x + 2 * u * t * control.x + t * t * to.x;
    const y = u * u * from.y + 2 * u * t * control.y + t * t * to.y;
    // Bank into the direction of travel, most in the middle of the trip, level on landing.
    const vx = i === 0 ? 0 : x - prev.x;
    const bank = i === 0 || i === steps ? 0 : clamp(vx * 1.6, -16, 16);
    const scale = 1 + 0.1 * Math.sin(Math.PI * t);
    // The ends are exact: the landing is where the owl will then be set down.
    const px = i === 0 ? String(from.x) : i === steps ? String(to.x) : x.toFixed(1);
    const py = i === 0 ? String(from.y) : i === steps ? String(to.y) : y.toFixed(1);
    keyframes.push({ offset: t, transform: `translate3d(${px}px, ${py}px, 0) rotate(${bank.toFixed(1)}deg) scale(${scale.toFixed(3)})` });
    prev = { x, y };
  }
  return {
    duration: Math.round(clamp(520 + dist * 0.7, 700, 1700)),
    keyframes,
    heading: dist < 4 ? 0 : clamp(dx / 260, -1, 1),
  };
}

/** Up off the perch and back down where it was: the owl answering a click. */
export function hover(at: Point, height = 22): Flight {
  const frames = [0, 0.3, 0.55, 0.8, 1].map((offset, i) => {
    const lift = [0, height, height * 0.8, height * 0.35, 0][i]!;
    return { offset, transform: `translate3d(${at.x}px, ${at.y - lift}px, 0)` };
  });
  return { duration: 650, keyframes: frames, heading: 0 };
}

/** Where an element is drawn right now: mid-flight, where the flight has got to; at rest, its perch. */
export function drawnAt(el: HTMLElement): Point | null {
  if (el.getAnimations?.().length && typeof DOMMatrixReadOnly === 'function') {
    try {
      const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
      return { x: m.m41, y: m.m42 };
    } catch { /* fall back to the perch */ }
  }
  const m = /translate3d\((-?[\d.]+)px,\s*(-?[\d.]+)px/.exec(el.style.transform);
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
}
