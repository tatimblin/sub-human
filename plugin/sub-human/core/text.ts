// One line of outside text, safe to draw or hand to a Claude: terminal escapes, other control characters, bidi
// overrides and zero-width characters removed, whitespace collapsed to single spaces, a `[room` that could forge a
// datamark's label defused, clipped to `max` with an ellipsis.

// oxlint-disable-next-line no-control-regex -- matching escape sequences is the point
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-_])/g;
// C0 and C1 controls (tab and line breaks among them, which become spaces) and the bidi embeddings, overrides and isolates
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
/** Zero-width characters (and the soft hyphen and word joiner), which hide inside a word: removed, not spaced. */
export const ZERO_WIDTH: RegExp = /[\u00ad\u200b-\u200d\u2060\ufeff]/g;

/** Why something failed, from whatever was thrown, as one short line. */
export function why(x: unknown): string { return oneLine(String(x), 200); }

export function oneLine(text: string, max: number): string {
  const one = defuse(clean(text).replace(/\s+/g, ' ').trim());
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

function clean(text: string): string {
  return text.replace(ANSI, '').replace(ZERO_WIDTH, '').replace(CONTROL, ' ');
}
const defuse = (text: string): string => text.replace(/\[room/gi, '(room');

/** A name or label as a datamark shows it: one line with no brackets, so it can't close the label and open another. */
export function markLabel(text: string, max: number = 300): string {
  return oneLine(text.replace(/[[\]]/g, ''), max);
}

/**
 * Text marked as data from the room (the one datamark): `[room CODE · LABEL] text`, with any `[room` inside defused so
 * it can't forge another label. One line clipped to `max` by default; a `block` keeps its lines, each cleaned, after
 * the label's line, and is cut at `max` characters with a line saying so.
 */
export function datamark(code: string, label: string, text: string, o: { readonly max?: number; readonly block?: true } = {}): string {
  const max = o.max ?? 300;
  const head = `[room ${markLabel(code, 64)} · ${markLabel(label)}]`;
  if (!o.block) return `${head} ${oneLine(text, max)}`;
  const body = defuse(text.split('\n').map(clean).join('\n'));
  return `${head}\n${body.length > max ? `${body.slice(0, max)}\n… (cut at ${max} characters)` : body}`;
}
