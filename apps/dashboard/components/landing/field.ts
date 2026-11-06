/**
 * The landing page's one visual: 1,072 points, which is a hash key's 67 chains of 16 steps, changing shape with the story.
 * Plain 2D canvas: no WebGL to check for, nothing to fall back from, and it draws a still frame when motion is off.
 */
const COLS = 67;
const ROWS = 16;
const N = COLS * ROWS;
const TAU = Math.PI * 2;

/** Which token each point takes. Red and amber appear only where the story is in that state. */
const enum Ink {
  Quiet,
  Bright,
  Arc,
  Danger,
  Warn,
}

interface P {
  x: number;
  y: number;
  z: number;
  a: number;
  k: Ink;
}

type Scene = { spin: boolean; left: boolean; draw: (o: P, c: number, r: number, i: number, u: number, time: number, levels: number[]) => void };

const noise = (i: number) => {
  const s = Math.sin(i * 127.1) * 43758.5453;
  return s - Math.floor(s);
};

/** A golden-angle spiral over the surface, so the outline reads as one solid form. `share` is this point's place along the bolt, 0 to 1. */
const bolt = (o: P, share: number, i: number, scale: number, cx: number) => {
  const v = share * 2 - 1;
  const theta = i * 2.399963;
  const radius = 0.66 * Math.pow(Math.abs(Math.sin(Math.PI * v)), 0.85) * (1 - Math.abs(v) * 0.3) + 0.03;
  o.x = cx + radius * Math.cos(theta) * scale;
  o.z = radius * Math.sin(theta) * scale;
  o.y = v * 1.28 * scale;
};

const SCENES: Scene[] = [
  // The bolt: vajra means thunderbolt, and diamond.
  { spin: true, left: false, draw: (o, _c, _r, i) => (bolt(o, (i + 0.5) / N, i, 1, 0), (o.a = 0.95), (o.k = Ink.Bright)) },
  // You spend: a quiet ledger, and one small part of it is the day's limit.
  {
    spin: false,
    left: false,
    draw: (o, c, r) => {
      o.x = (c / (COLS - 1) - 0.5) * 2.8;
      o.y = (r / (ROWS - 1) - 0.5) * 1.1;
      o.z = 0;
      const limit = c < 7;
      o.a = limit ? 1 : 0.42;
      o.k = limit ? Ink.Bright : Ink.Quiet;
    },
  },
  // The seed is stolen: the same key, twice, and the chain cannot tell them apart.
  {
    spin: true,
    left: false,
    draw: (o, _c, _r, i) => {
      const thief = i % 2 === 1;
      bolt(o, (i + 0.5) / N, i >> 1, 0.66, thief ? 0.72 : -0.72);
      o.a = 0.95;
      o.k = thief ? Ink.Danger : Ink.Bright;
    },
  },
  // The theft has to wait: the payment, running down in public.
  {
    spin: false,
    left: false,
    draw: (o, c, r, _i, u) => {
      o.x = (c / (COLS - 1) - 0.5) * 2.8;
      o.y = (r / (ROWS - 1) - 0.5) * 0.46;
      o.z = 0;
      const left = c / COLS < 1 - u * 0.85;
      o.a = left ? 1 : 0.2;
      o.k = Ink.Warn;
    },
  },
  // You cancel it: 67 chains, each stopped where the signature says.
  {
    spin: false,
    left: false,
    draw: (o, c, r, _i, _u, _t, levels) => {
      o.x = (c / (COLS - 1) - 0.5) * 2.9;
      o.y = -0.85 + r * 0.115;
      o.z = 0;
      o.a = r <= levels[c]! ? 1 : 0.14;
      o.k = Ink.Arc;
    },
  },
  // The thief blocks your exit: one lane stops at a wall, and the other goes through.
  {
    spin: false,
    left: false,
    draw: (o, c, r, i, _u, time) => {
      const top = r < 8;
      const row = r % 8;
      o.z = 0;
      if (top) {
        const wall = c > 57;
        o.x = wall ? 0.34 + (c - 58) * 0.012 : -1.45 + (c / 57) * 1.72;
        o.y = wall ? 0.05 + (row / 7) * 0.8 : 0.45 + (row / 7 - 0.5) * 0.22;
        o.a = wall ? 1 : 0.55;
        o.k = wall ? Ink.Danger : Ink.Quiet;
      } else {
        o.x = -1.45 + ((c / COLS + time * 0.05 + noise(i) * 0.02) % 1) * 2.9;
        o.y = -0.45 + (row / 7 - 0.5) * 0.22;
        o.a = 1;
        o.k = Ink.Arc;
      }
    },
  },
  // You get paid privately: almost everything dissolves, and one thin thread stays yours.
  {
    spin: false,
    left: false,
    draw: (o, c, r, i, _u, time) => {
      const mine = c === 33;
      o.x = mine ? Math.sin(r * 0.8 + time * 0.3) * 0.05 : (noise(i) - 0.5) * 3.6;
      o.y = mine ? (r / (ROWS - 1) - 0.5) * 1.1 : (noise(i + 9) - 0.5) * 2.2;
      o.z = 0;
      o.a = mine ? 1 : 0.2;
      o.k = mine ? Ink.Bright : Ink.Quiet;
    },
  },
  // You lose the master key: a new tree grows from a proof.
  {
    spin: false,
    left: false,
    draw: (o, c, r, _i, u) => {
      const spread = (r + 1) / ROWS;
      o.x = (c / (COLS - 1) - 0.5) * 2.7 * spread;
      o.y = 1 - (r / (ROWS - 1)) * 1.9;
      o.z = 0;
      const grown = r / ROWS < u * 1.5;
      o.a = grown ? 1 : 0.18;
      o.k = grown ? Ink.Arc : Ink.Quiet;
    },
  },
  // Private savings: a sealed shell, with the rules still around what is inside.
  {
    spin: true,
    left: false,
    draw: (o, c, r, i) => {
      const inner = r < 2;
      const radius = inner ? 0.3 : 1.05;
      const y = 1 - ((i + 0.5) / N) * 2;
      const ring = Math.sqrt(1 - y * y);
      const turn = i * 2.399963;
      o.x = Math.cos(turn) * ring * radius;
      o.y = (inner ? noise(i) * 2 - 1 : y) * radius;
      o.z = Math.sin(turn) * ring * radius;
      o.a = inner ? 1 : 0.6;
      o.k = inner ? Ink.Arc : Ink.Quiet;
    },
  },
  // Back to the bolt.
  { spin: true, left: false, draw: (o, _c, _r, i) => (bolt(o, (i + 0.5) / N, i, 1, 0), (o.a = 0.95), (o.k = Ink.Arc)) },
];

export const SCENE_COUNT = SCENES.length;

const smooth = (t: number) => t * t * (3 - 2 * t);
const clamp = (t: number) => Math.min(1, Math.max(0, t));

function rgb(value: string): [number, number, number] {
  const hex = value.trim().replace("#", "");
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}

export class Field {
  private ctx: CanvasRenderingContext2D;
  private inks: [number, number, number][];
  private w = 0;
  private h = 0;
  private ratio = 1;
  private a: P = { x: 0, y: 0, z: 0, a: 0, k: Ink.Quiet };
  private b: P = { x: 0, y: 0, z: 0, a: 0, k: Ink.Quiet };

  constructor(
    private canvas: HTMLCanvasElement,
    private levels: number[],
  ) {
    this.ctx = canvas.getContext("2d")!;
    const style = getComputedStyle(document.documentElement);
    this.inks = ["--t60", "--t100", "--arc", "--danger", "--warn"].map((name) => rgb(style.getPropertyValue(name)));
    this.resize();
  }

  resize() {
    const box = this.canvas.getBoundingClientRect();
    this.ratio = Math.min(window.devicePixelRatio || 1, 2);
    this.w = box.width;
    this.h = box.height;
    this.canvas.width = Math.round(box.width * this.ratio);
    this.canvas.height = Math.round(box.height * this.ratio);
  }

  /** `scene` runs from 0 to SCENE_COUNT - 1. `u` is how far through its own chapter the reader is. `offset` moves the field aside for the text. */
  draw(scene: number, u: number, time: number, offset: { x: number; y: number; scale: number }) {
    const { ctx, w, h, ratio, a, b, inks, levels } = this;
    const from = Math.min(Math.floor(scene), SCENES.length - 1);
    const to = Math.min(from + 1, SCENES.length - 1);
    const t = scene - from;
    const A = SCENES[from]!;
    const B = SCENES[to]!;
    const spin = (A.spin ? 1 - t : 0) + (B.spin ? t : 0);
    const wrapped = (((time * 0.22) % TAU) + TAU) % TAU;
    const angle = (wrapped > Math.PI ? wrapped - TAU : wrapped) * spin;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const size = Math.min(w, h) * 0.36 * offset.scale;
    const cx = w * offset.x;
    const cy = h * offset.y;

    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, w, h);
    for (let i = 0; i < N; i++) {
      const c = i % COLS;
      const r = (i / COLS) | 0;
      A.draw(a, c, r, i, from === to ? u : 1, time, levels);
      B.draw(b, c, r, i, u, time, levels);
      // A wave across the columns, so the shape travels instead of cross-fading.
      const m = smooth(clamp(t * 1.5 - (c / COLS) * 0.5));
      const x0 = a.x + (b.x - a.x) * m;
      const y0 = a.y + (b.y - a.y) * m;
      const z0 = a.z + (b.z - a.z) * m;
      const x = x0 * cos - z0 * sin;
      const z = x0 * sin + z0 * cos;
      const depth = 1 / (1 + z * 0.28);
      const alpha = (a.a + (b.a - a.a) * m) * (0.5 + 0.5 * clamp(1 - z * 0.6));
      const ca = inks[a.k]!;
      const cb = inks[b.k]!;
      ctx.fillStyle = `rgba(${(ca[0] + (cb[0] - ca[0]) * m) | 0},${(ca[1] + (cb[1] - ca[1]) * m) | 0},${(ca[2] + (cb[2] - ca[2]) * m) | 0},${alpha.toFixed(2)})`;
      const dot = 2.3 * depth;
      ctx.fillRect(cx + x * size * depth - dot / 2, cy - y0 * size * depth - dot / 2, dot, dot);
    }
  }
}
