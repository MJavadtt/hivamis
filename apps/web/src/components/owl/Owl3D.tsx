import { useEffect, useRef } from 'react';
import {
  BoxGeometry, CanvasTexture, CapsuleGeometry, CircleGeometry, ConeGeometry, CylinderGeometry, DirectionalLight, Group,
  HemisphereLight, Mesh, MeshBasicMaterial, MeshStandardMaterial, PerspectiveCamera, Scene, SphereGeometry, WebGLRenderer,
  type BufferGeometry, type Material, type Object3D,
} from 'three';
import type { OwlMood } from './mood';

/**
 * Hiva the owl, in three dimensions (Hivamis task 8) — built from spheres and cones rather than a
 * model file, so it costs nothing to ship but the library and draws in a few milliseconds. It breathes,
 * blinks, turns its head to the pointer (or to what the tour is showing), talks, thinks, waves,
 * hops and flies — wings beating, body pitched forward and turned the way it is going. It stops drawing when it is off screen or the tab is hidden, and holds still for people who
 * asked for less motion.
 */

const C = {
  body: '#8a5a3b', wing: '#6e4529', dark: '#4b2e1c', belly: '#f2e2c4', face: '#ecd9b8', mark: '#b98a5e',
  eye: '#ffffff', iris: '#f5a524', pupil: '#1c1917', beak: '#e98a1c', cap: '#2563eb', capTop: '#1d4ed8', gold: '#f2c14e',
};

const mat = (color: string, roughness = 0.7) => new MeshStandardMaterial({ color, roughness, metalness: 0 });
const ball = (r: number, m: Material, seg = 32) => new Mesh(new SphereGeometry(r, seg, Math.round(seg * 0.75)), m);
const at = <T extends Object3D>(o: T, x: number, y: number, z: number): T => { o.position.set(x, y, z); return o; };
const scaled = <T extends Object3D>(o: T, x: number, y: number, z: number): T => { o.scale.set(x, y, z); return o; };

/** A soft round shadow under the feet. */
function shadowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64);
  grad.addColorStop(0, 'rgba(30,20,60,0.35)');
  grad.addColorStop(1, 'rgba(30,20,60,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new CanvasTexture(c);
}

function buildOwl() {
  const m = {
    body: mat(C.body), wing: mat(C.wing), dark: mat(C.dark), belly: mat(C.belly, 0.85), face: mat(C.face, 0.8), mark: mat(C.mark),
    eye: mat(C.eye, 0.25), iris: mat(C.iris, 0.3), pupil: mat(C.pupil, 0.2), beak: mat(C.beak, 0.5),
    cap: mat(C.cap, 0.6), capTop: mat(C.capTop, 0.6), gold: mat(C.gold, 0.4), glint: new MeshBasicMaterial({ color: '#ffffff' }),
  };
  const root = new Group();

  root.add(scaled(at(ball(1, m.body, 48), 0, -0.1, 0), 1, 1.12, 0.92));
  root.add(scaled(at(ball(0.82, m.belly, 40), 0, -0.3, 0.48), 0.95, 1, 0.55));
  // Chevron marks on the belly, set on its surface.
  for (const [x, y] of [[-0.28, -0.05], [0, 0.02], [0.28, -0.05], [-0.15, -0.32], [0.15, -0.32], [-0.3, -0.58], [0, -0.55], [0.3, -0.58]] as const) {
    const ex = x / (0.82 * 0.95);
    const ey = (y + 0.3) / 0.82;
    const z = 0.48 + 0.82 * 0.55 * Math.sqrt(Math.max(0, 1 - ex * ex - ey * ey));
    root.add(scaled(at(ball(0.07, m.mark, 12), x, y, z - 0.01), 1.4, 0.55, 0.4));
  }

  // The head turns on its own pivot; owls have no neck to speak of.
  const head = at(new Group(), 0, 0.95, 0);
  root.add(head);
  head.add(scaled(at(ball(0.82, m.body, 48), 0, 0.1, 0), 1.12, 0.92, 0.95));
  const eyes: Group[] = [];
  const looks: Group[] = [];
  const brows: Mesh[] = [];
  for (const side of [-1, 1]) {
    head.add(scaled(at(ball(0.4, m.face, 32), side * 0.33, 0.12, 0.62), 1, 1, 0.35));
    const eye = at(new Group(), side * 0.33, 0.14, 0.72);
    eye.add(ball(0.22, m.eye, 32));
    const look = new Group();
    look.add(scaled(at(ball(0.14, m.iris, 24), 0, 0, 0.17), 1, 1, 0.35));
    look.add(scaled(at(ball(0.08, m.pupil, 20), 0, 0, 0.215), 1, 1, 0.4));
    look.add(at(ball(0.03, m.glint, 10), 0.05, 0.06, 0.245));
    eye.add(look);
    head.add(eye);
    eyes.push(eye);
    looks.push(look);
    const brow = new Mesh(new CapsuleGeometry(0.035, 0.22, 4, 8), m.dark);
    // Inner ends a little raised: curious and kind, not cross.
    brow.rotation.z = Math.PI / 2 - side * 0.14;
    head.add(at(brow, side * 0.33, 0.43, 0.7));
    brows.push(brow);
    const tuft = new Mesh(new ConeGeometry(0.13, 0.38, 16), m.dark);
    tuft.rotation.z = -side * 0.45;
    head.add(at(tuft, side * 0.55, 0.78, 0));
  }
  const beak = new Mesh(new ConeGeometry(0.085, 0.2, 16), m.beak);
  beak.rotation.x = Math.PI + 0.35;
  head.add(at(beak, 0, -0.04, 0.86));
  const jaw = at(new Group(), 0, -0.11, 0.84);
  const lower = new Mesh(new ConeGeometry(0.055, 0.1, 12), m.beak);
  lower.rotation.x = Math.PI;
  jaw.add(at(lower, 0, -0.04, 0));
  head.add(jaw);

  // The guide's cap: a mortarboard in the house colour, with a tassel that swings.
  const cap = at(new Group(), 0, 0.84, -0.02);
  cap.rotation.set(-0.12, 0, 0.1);
  cap.add(new Mesh(new CylinderGeometry(0.36, 0.38, 0.18, 32), m.cap));
  const board = at(new Mesh(new BoxGeometry(0.98, 0.05, 0.98), m.capTop), 0, 0.11, 0);
  board.rotation.y = Math.PI / 4;
  cap.add(board);
  cap.add(at(new Mesh(new CylinderGeometry(0.05, 0.05, 0.03, 16), m.gold), 0, 0.15, 0));
  const tassel = at(new Group(), 0.0, 0.15, 0);
  const cord = new Mesh(new CylinderGeometry(0.012, 0.012, 0.6, 6), m.gold);
  cord.rotation.z = Math.PI / 2;
  tassel.add(at(cord, 0.3, 0, 0));
  tassel.add(at(new Mesh(new CylinderGeometry(0.012, 0.012, 0.3, 6), m.gold), 0.6, -0.15, 0));
  const end = new Mesh(new ConeGeometry(0.055, 0.14, 12), m.gold);
  tassel.add(at(end, 0.6, -0.34, 0));
  cap.add(tassel);
  head.add(cap);

  const wings: Group[] = [];
  for (const side of [-1, 1]) {
    const pivot = at(new Group(), side * 0.88, 0.35, -0.05);
    const wing = scaled(at(ball(1, m.wing, 32), 0, -0.5, 0), 0.24, 0.72, 0.5);
    wing.rotation.z = side * 0.12;
    pivot.add(wing);
    root.add(pivot);
    wings.push(pivot);
  }
  for (const side of [-1, 1]) {
    for (const dx of [-0.09, 0, 0.09]) {
      const toe = new Mesh(new CapsuleGeometry(0.055, 0.1, 4, 8), m.beak);
      toe.rotation.x = Math.PI / 2;
      root.add(at(toe, side * 0.36 + dx, -1.17, 0.5));
    }
  }
  const shadow = new Mesh(new CircleGeometry(1.15, 32), new MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2;
  at(shadow, 0, -1.24, 0.1);

  return { root, head, eyes, looks, brows, jaw, wings, tassel, shadow };
}

export interface Owl3DProps {
  size: number;
  mood: OwlMood;
  /** While flying: which way, −1 (left) to 1 (right). */
  heading?: number;
  /** A point on the screen to look at; otherwise the pointer. */
  lookAt?: { x: number; y: number } | null;
  onFail?: () => void;
  className?: string;
}

export default function Owl3D({ size, mood, heading = 0, lookAt, onFail, className }: Owl3DProps) {
  const host = useRef<HTMLDivElement>(null);
  const live = useRef({ mood, heading, lookAt, redraw: () => {} });
  live.current.mood = mood;
  live.current.heading = heading;
  live.current.lookAt = lookAt;

  useEffect(() => {
    // A canvas of its own each time: a context given up on unmount cannot be had back on the same one.
    const el = document.createElement('canvas');
    el.style.width = el.style.height = `${size}px`;
    el.setAttribute('aria-hidden', 'true');
    host.current?.appendChild(el);
    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({ canvas: el, antialias: true, alpha: true, powerPreference: 'low-power' });
    } catch {
      el.remove();
      onFail?.();
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(size, size, false);
    const scene = new Scene();
    const camera = new PerspectiveCamera(30, 1, 0.1, 50);
    camera.position.set(0, 0.4, 8.2);
    camera.lookAt(0, 0.2, 0);
    scene.add(new HemisphereLight('#fff7ed', '#5b7bd5', 1.7));
    const key = new DirectionalLight('#ffffff', 2.6);
    key.position.set(3, 5, 6);
    scene.add(key);
    const rim = new DirectionalLight('#c7d2fe', 1.3);
    rim.position.set(-4, 3, -5);
    scene.add(rim);
    const owl = buildOwl();
    scene.add(owl.root, owl.shadow);

    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const pointer = { x: 0, y: 0, at: -1e9 };
    const onMove = (e: PointerEvent) => { pointer.x = e.clientX; pointer.y = e.clientY; pointer.at = performance.now(); };
    window.addEventListener('pointermove', onMove, { passive: true });

    let last = performance.now();
    const start = last;
    let nextBlink = start + 1800;
    let blinkAt = -1e9;
    let wander = { yaw: 0, pitch: 0, next: start + 3000 };
    let seenMood = live.current.mood;
    let moodAt = start;
    let frame = 0;
    let visible = true;
    const ease = (cur: number, target: number, k: number) => cur + (target - cur) * k;

    const draw = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const t = (now - start) / 1000;
      const { mood: md, heading: towards, lookAt: target } = live.current;
      const flying = md === 'fly';
      if (md !== seenMood) { seenMood = md; moodAt = now; }
      const since = (now - moodAt) / 1000;
      const k = 1 - Math.exp(-dt * 6);

      // Where to look: the tour's target, the pointer while it moves, or around the room.
      let yaw = 0, pitch = 0;
      const box = el.getBoundingClientRect();
      const cx = box.left + box.width / 2, cy = box.top + box.height * 0.35;
      const point = target ?? (now - pointer.at < 5000 ? pointer : null);
      if (point) {
        yaw = Math.max(-0.75, Math.min(0.75, (point.x - cx) / 480));
        pitch = Math.max(-0.28, Math.min(0.32, (point.y - cy) / 520));
      } else {
        if (now > wander.next) wander = { yaw: (Math.random() - 0.5) * 0.9, pitch: (Math.random() - 0.4) * 0.25, next: now + 2500 + Math.random() * 2500 };
        yaw = wander.yaw; pitch = wander.pitch;
      }
      let tilt = 0;
      if (md === 'think') { yaw = 0.3; pitch = -0.22; tilt = 0.24; }
      if (md === 'sleep') { yaw = 0; pitch = 0.25; tilt = 0.12; }
      // In flight it looks where it is going.
      if (flying) { yaw = towards * 0.5; pitch = 0.1; }

      const breath = Math.sin(t * 2.2);
      owl.root.scale.y = 1 + 0.012 * breath;
      let lift = 0.03 * breath;
      if (md === 'hop' && since < 0.5) lift += 0.38 * Math.sin(Math.PI * since / 0.5);
      if (md === 'talk') lift += 0.02 * Math.abs(Math.sin(t * 6.5));
      // Each downstroke lifts the body a little.
      const beat = Math.sin(t * 24);
      if (flying) lift += 0.18 + 0.07 * beat;
      owl.root.position.y = ease(owl.root.position.y, lift, flying ? 0.5 : 0.35);
      owl.root.rotation.z = ease(owl.root.rotation.z, flying ? -towards * 0.22 : 0.025 * Math.sin(t * 0.9), k);
      owl.root.rotation.x = ease(owl.root.rotation.x, flying ? 0.32 : 0, k);
      owl.root.rotation.y = ease(owl.root.rotation.y, flying ? towards * 0.6 : 0, k);
      owl.shadow.scale.setScalar(Math.max(0.35, 1 - owl.root.position.y * (flying ? 1.6 : 0.5)));

      owl.head.rotation.y = ease(owl.head.rotation.y, yaw, k);
      owl.head.rotation.x = ease(owl.head.rotation.x, pitch + (md === 'talk' ? 0.04 * Math.sin(t * 6.5) : 0), k);
      owl.head.rotation.z = ease(owl.head.rotation.z, tilt, k);
      for (const look of owl.looks) {
        look.rotation.y = ease(look.rotation.y, yaw * 0.45, k);
        look.rotation.x = ease(look.rotation.x, pitch * 0.6, k);
      }
      // A brow lifts while it thinks.
      owl.brows[1]!.position.y = ease(owl.brows[1]!.position.y, md === 'think' ? 0.5 : 0.43, k);

      if (now > nextBlink) { blinkAt = now; nextBlink = now + 2200 + Math.random() * 3000 + (Math.random() < 0.2 ? -1800 : 0); }
      const b = (now - blinkAt) / 160;
      const lid = md === 'sleep' ? 0.12 : b >= 0 && b < 1 ? Math.max(0.08, Math.abs(1 - 2 * b)) : 1;
      for (const eye of owl.eyes) eye.scale.y = lid;

      owl.jaw.rotation.x = md === 'talk' ? 0.45 * Math.abs(Math.sin(t * 13)) : ease(owl.jaw.rotation.x, 0, k);
      owl.tassel.rotation.z = 0.18 * Math.sin(t * 1.7) - owl.head.rotation.y * 0.3;

      const [left, right] = owl.wings as [Group, Group];
      if (flying) {
        // Wings out and beating: from just above level to well below, about four strokes a second.
        const stroke = 1.05 + 0.75 * beat;
        left.rotation.z = -stroke;
        right.rotation.z = stroke;
        left.rotation.x = right.rotation.x = 0.25 * Math.cos(t * 24);
      } else {
        const flutter = 0.04 * Math.sin(t * 2.2);
        left.rotation.x = ease(left.rotation.x, 0, k);
        right.rotation.x = ease(right.rotation.x, 0, k);
        left.rotation.z = ease(left.rotation.z, -flutter, k);
        right.rotation.z = md === 'wave' && since < 1.8 ? 1.25 + 0.4 * Math.sin(since * 14) : ease(right.rotation.z, flutter, k);
      }

      renderer.render(scene, camera);
    };

    const loop = (now: number) => {
      draw(now);
      if (visible && !still && !document.hidden) frame = requestAnimationFrame(loop);
      else frame = 0;
    };
    const resume = () => { if (!frame && visible && !still && !document.hidden) { last = performance.now(); frame = requestAnimationFrame(loop); } };
    live.current.redraw = () => { if (still) draw(performance.now()); };

    const io = typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver(([e]) => { visible = !!e?.isIntersecting; resume(); })
      : null;
    io?.observe(el);
    document.addEventListener('visibilitychange', resume);
    if (still) draw(start); else frame = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(frame);
      io?.disconnect();
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('pointermove', onMove);
      scene.traverse((o) => {
        const mesh = o as Mesh;
        if (mesh.geometry) (mesh.geometry as BufferGeometry).dispose();
        const mats = mesh.material ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) : [];
        for (const mm of mats) { (mm as MeshBasicMaterial).map?.dispose(); mm.dispose(); }
      });
      renderer.dispose();
      renderer.forceContextLoss();
      el.remove();
    };
    // The scene is built once per size; mood and gaze are read live.
  }, [size, onFail]);

  // Someone who asked for less motion still sees the owl change its expression.
  useEffect(() => { live.current.redraw(); }, [mood, lookAt]);

  return <div ref={host} style={{ width: size, height: size }} className={className} data-owl="3d" />;
}
