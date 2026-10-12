import React, { useMemo } from 'react';
import { THEME, resolved, runs, rowText, screenRows, type Cell } from '../lib/ansi';
import { MONO, SANS } from '../fonts/fonts';
import type { PaneBox } from '../design';

/** First screen row shown when a pane is cropped to its latest `tail` rows (ending at the last non-blank row). */
export function windowStart(rows: Cell[][], tail: number): number {
  if (!tail || tail >= rows.length) return 0;
  let last = rows.length - 1;
  while (last > 0 && rowText(rows[last]) === '') last--;
  return Math.max(0, Math.min(rows.length - tail, last + 1 - tail));
}

/**
 * The rows a pane draws: the whole screen, or (cropped panes) its latest `box.rows` rows; a compact pane drops
 * blank rows first, so a small window holds more. Each row keeps its screen index.
 */
export function visibleRows(ansi: string, nrows: number, box: PaneBox): { row: Cell[]; index: number }[] {
  let rows = screenRows(ansi, nrows).map((row, index) => ({ row, index }));
  if (box.compact) rows = rows.filter((r) => rowText(r.row) !== '');
  const start = windowStart(rows.map((r) => r.row), box.tail);
  return rows.slice(start, start + box.rows);
}

export const Row: React.FC<{ row: Cell[]; box: PaneBox }> = ({ row, box }) => {
  const rs = runs(row);
  return (
    <>
      {rs.map((r, i) => {
        const { fg, bg } = resolved(r.style, THEME);
        const deco = [r.style.underline && 'underline', r.style.strike && 'line-through'].filter(Boolean).join(' ');
        return (
          <span
            key={i}
            style={{
              position: 'absolute',
              left: r.col * box.cell,
              width: r.cells * box.cell,
              top: 0,
              height: box.line,
              lineHeight: `${box.line}px`,
              color: fg,
              background: bg ?? undefined,
              fontWeight: r.style.bold ? 700 : 400,
              fontStyle: r.style.italic ? 'italic' : 'normal',
              opacity: r.style.dim ? 0.6 : 1,
              textDecoration: deco || undefined,
              textAlign: r.solo ? 'center' : 'left',
              overflow: 'visible',
            }}
          >
            {r.text}
          </span>
        );
      })}
    </>
  );
};

type Props = {
  ansi: string;
  box: PaneBox;
  /** the session's screen height (meta rows) */
  screenRows: number;
  title: string;
  subtitle?: string;
  style?: React.CSSProperties;
};

/**
 * A terminal window replaying one captured screen: macOS-style chrome with the seat's name, then the ANSI
 * screen drawn on a fixed cell grid (every run pinned to its columns, so fallback glyphs cannot drift).
 */
export const Terminal: React.FC<Props> = ({ ansi, box, screenRows: nrows, title, subtitle, style }) => {
  const shown = useMemo(() => visibleRows(ansi, nrows, box), [ansi, nrows, box]);
  const dot = box.bar * 0.24;
  return (
    <div
      style={{
        position: 'absolute',
        left: box.x,
        top: box.y,
        width: box.w,
        height: box.h,
        background: THEME.bg,
        borderRadius: box.bar * 0.36,
        boxShadow: `0 0 0 1px ${THEME.border}, 0 ${box.bar * 0.6}px ${box.bar * 2.2}px rgba(0,0,0,0.55)`,
        overflow: 'hidden',
        ...style,
      }}
    >
      <div
        style={{
          height: box.bar,
          background: THEME.bar,
          borderBottom: `1px solid ${THEME.border}`,
          display: 'flex',
          alignItems: 'center',
          position: 'relative',
        }}
      >
        <div style={{ display: 'flex', gap: dot * 0.75, marginLeft: box.bar * 0.42 }}>
          {['#ff5f57', '#febc2e', '#28c840'].map((c) => (
            <div key={c} style={{ width: dot, height: dot, borderRadius: dot, background: c, opacity: 0.9 }} />
          ))}
        </div>
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            textAlign: 'center',
            fontFamily: SANS,
            fontSize: box.bar * 0.4,
            color: THEME.titleFg,
            letterSpacing: '0.01em',
          }}
        >
          <span style={{ color: '#e7e9ee', fontWeight: 600 }}>{title}</span>
          {subtitle ? <span style={{ opacity: 0.75 }}>{'  ·  ' + subtitle}</span> : null}
        </div>
      </div>
      <div
        style={{
          position: 'absolute',
          left: box.padX,
          top: box.bar + box.padY,
          fontFamily: MONO,
          fontSize: box.fontSize,
          color: THEME.fg,
          whiteSpace: 'pre',
          fontVariantLigatures: 'none',
          fontFeatureSettings: '"liga" 0, "calt" 0',
          fontKerning: 'none',
        }}
      >
        {shown.map(({ row, index }, i) => (
          <div key={index} style={{ position: 'absolute', top: i * box.line, left: 0, height: box.line }}>
            <Row row={row} box={box} />
          </div>
        ))}
      </div>
    </div>
  );
};
