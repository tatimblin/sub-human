/** Design tokens: dark, restrained, one accent. */
export const COLORS = {
  bg: '#0c0d10',
  bgLift: '#121318',
  text: '#eef0f4',
  textSoft: '#a3a9b5',
  textFaint: '#6b7280',
  hairline: 'rgba(255,255,255,0.08)',
  /** the one accent: Claude's clay */
  accent: '#d97757',
};

/** Pane layout, in stage pixels. `tail` > 0 crops a pane to that many rows ending at its last non-blank row. */
export type PaneBox = {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
  cell: number; // cell width
  line: number; // row height
  bar: number; // title bar height
  padX: number;
  padY: number;
  rows: number; // rows shown
  tail: number; // 0 = whole screen
  compact: boolean; // drop blank rows (cropped panes only)
};

export type StageLayout = {
  kind: 'side' | 'stacked';
  width: number;
  height: number;
  panes: PaneBox[];
  /** the screen area the camera centres in (above the captions) */
  view: { top: number; bottom: number };
  captionBottom: number;
  captionSize: number;
  eyebrowSize: number;
};

export const LINE = 1.32; // row height / font size: JetBrains Mono's box glyphs span 1.32em, so rules join up
export const ADVANCE = 0.6; // JetBrains Mono advance / font size

function pane(name: string, x: number, y: number, w: number, cols: number, rows: number, tail: number, compact = false, barK = 2.6): PaneBox {
  const padX = Math.round(w * 0.018);
  const cell = (w - padX * 2) / cols;
  const fontSize = cell / ADVANCE;
  const line = fontSize * LINE;
  const bar = Math.round(fontSize * barK);
  const padY = Math.round(fontSize * 0.9);
  const shown = tail || rows;
  return { name, x, y, w, h: bar + padY * 2 + shown * line, fontSize, cell, line, bar, padX, padY, rows: shown, tail, compact: compact && tail > 0 };
}

/** Two panes side by side, whole screens (the 16:9 trailer). */
export function sideLayout(width: number, height: number, seats: string[], cols: number, rows: number): StageLayout {
  const mx = Math.round(width * 0.037);
  const gap = Math.round(width * 0.025);
  const w = (width - mx * 2 - gap) / 2;
  const probe = pane('', 0, 0, w, cols, rows, 0);
  const captionZone = Math.round(height * 0.17);
  const top = Math.max(Math.round(height * 0.07), (height - captionZone - probe.h) / 2);
  return {
    kind: 'side',
    width,
    height,
    panes: seats.map((s, i) => pane(s, mx + i * (w + gap), top, w, cols, rows, 0)),
    view: { top: 0, bottom: captionZone },
    captionBottom: Math.round(height * 0.055),
    captionSize: Math.round(height * 0.036),
    eyebrowSize: Math.round(height * 0.017),
  };
}

/** Panes stacked, each cropped to its latest rows (square and README sizes). */
export function stackedLayout(width: number, height: number, seats: string[], cols: number, opts: { top: number; captionZone: number; gap: number; mx: number; compact?: boolean }): StageLayout {
  const w = width - opts.mx * 2;
  const barK = 2.1;
  const probe = pane('', 0, 0, w, cols, 1, 1, false, barK);
  const each = (height - opts.top - opts.captionZone - opts.gap * (seats.length - 1)) / seats.length;
  const tail = Math.max(4, Math.floor((each - (probe.h - probe.line)) / probe.line));
  const h = pane('', 0, 0, w, cols, tail, tail, false, barK).h;
  const used = h * seats.length + opts.gap * (seats.length - 1);
  const top = opts.top + (height - opts.top - opts.captionZone - used) / 2;
  return {
    kind: 'stacked',
    width,
    height,
    panes: seats.map((s, i) => pane(s, opts.mx, top + i * (h + opts.gap), w, cols, tail, tail, !!opts.compact, barK)),
    view: { top: 0, bottom: opts.captionZone },
    captionBottom: Math.round(opts.captionZone * 0.3),
    captionSize: Math.round(Math.min(width, height) * 0.032),
    eyebrowSize: Math.round(Math.min(width, height) * 0.016),
  };
}

/**
 * Who is who: alice, bob and the room's Claude each keep one name and one colour for the whole cut. The colour
 * never appears without the name beside it (name plates, message tags, caption names).
 */
export type Who = { name: string; color: string };
export const PEOPLE: Record<string, Who> = {
  alice: { name: 'alice', color: '#6cb6ff' },
  bob: { name: 'bob', color: '#c39bff' },
  claude: { name: "the room's Claude", color: COLORS.accent },
};
export const who = (key: string): Who => PEOPLE[key] ?? { name: key, color: COLORS.textSoft };

/**
 * The split-screen layout (v2 edits): every pane is a fixed window onto its 120×36 screen, and the camera lives
 * inside each window (zoom within a half). Side by side for 16:9, stacked for square and portrait. `zoom0` is a
 * window's default framing (side: the whole screen's height, cropping the right of long lines; stacked: full
 * width, latest rows). `node` is where the room's Claude's plate sits, between the panes.
 */
export type SplitPane = PaneBox & { vw: number; vh: number; zoom0: number; contentH: number };
export type SplitLayout = Omit<StageLayout, 'kind' | 'panes'> & {
  kind: 'split';
  dir: 'row' | 'column';
  panes: SplitPane[];
  node: { x: number; y: number };
  plateSize: number;
  /** stage units: 1 at 1080p */
  u: number;
};

function splitPane(name: string, x: number, y: number, w: number, h: number, cols: number, rows: number, u: number, fitHeight: boolean, zoomStacked = 1, barPx = 40 * u): SplitPane {
  const padX = Math.round(14 * u);
  const cell = (w - padX * 2) / cols;
  const fontSize = cell / ADVANCE;
  const line = fontSize * LINE;
  const bar = Math.round(barPx);
  const padY = Math.round(10 * u);
  const vw = w - padX * 2;
  const vh = h - bar - padY * 2;
  const contentH = rows * line;
  // side by side: the screen's full height; stacked: closer in (long lines crop at the right), so it reads small
  const zoom0 = fitHeight ? Math.max(1, vh / contentH) : zoomStacked;
  return { name, x, y, w, h, fontSize, cell, line, bar, padX, padY, rows, tail: 0, compact: false, vw, vh, zoom0, contentH };
}

export function splitLayout(width: number, height: number, seats: string[], cols: number, rows: number, opts: { captions: boolean; node: boolean }): SplitLayout {
  const u = Math.min(width / 1920, height / 1080) * (width / height < 1.5 ? 1.55 : 1);
  const side = width / height >= 1.5;
  const captionZone = opts.captions ? Math.round((side ? 150 : 210) * Math.min(width / 1920, height / 1080) * (side ? 1 : 1.45)) : Math.round(18 * u);
  const top = opts.node ? Math.round((side ? 92 : 104) * u * (side ? 1 : 0.62)) : Math.round(18 * u);
  if (side) {
    const mx = Math.round(width * 0.028);
    const gap = Math.round(width * 0.022);
    const w = (width - mx * 2 - gap) / 2;
    const h = height - top - captionZone;
    return {
      kind: 'split',
      dir: 'row',
      width,
      height,
      panes: seats.map((s, i) => splitPane(s, mx + i * (w + gap), top, w, h, cols, rows, u, true, 1, 50 * u)),
      view: { top: 0, bottom: captionZone },
      captionBottom: Math.round(captionZone * 0.3),
      captionSize: Math.round(height * 0.038),
      eyebrowSize: Math.round(height * 0.017),
      node: { x: width / 2, y: top / 2 },
      plateSize: Math.round(29 * u),
      u,
    };
  }
  const k = width / 1080;
  const mx = Math.round(width * 0.035);
  const gap = Math.round(22 * k);
  const top2 = opts.node ? Math.round(78 * k) : Math.round(18 * k);
  const w = width - mx * 2;
  const h = (height - top2 - captionZone - gap * (seats.length - 1)) / seats.length;
  return {
    kind: 'split',
    dir: 'column',
    width,
    height,
    panes: seats.map((s, i) => splitPane(s, mx, top2 + i * (h + gap), w, h, cols, rows, 1.15 * k, false, 1.4)),
    view: { top: 0, bottom: captionZone },
    captionBottom: Math.round(captionZone * 0.22),
    captionSize: Math.round(Math.min(width, height) * 0.043),
    eyebrowSize: Math.round(Math.min(width, height) * 0.018),
    node: { x: width / 2, y: top2 / 2 },
    plateSize: Math.round(27 * k),
    u: 1.4 * k,
  };
}
