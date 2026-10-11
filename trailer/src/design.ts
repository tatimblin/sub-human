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
