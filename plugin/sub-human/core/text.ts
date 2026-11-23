// One line of outside text, safe to draw or hand to a Claude: terminal escapes, other control characters, bidi
// overrides and zero-width characters removed, whitespace collapsed to single spaces, clipped to `max` with an ellipsis.

// oxlint-disable-next-line no-control-regex -- matching escape sequences is the point
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-_])/g;
// C0 and C1 controls (tab and line breaks among them, which become spaces) and the bidi embeddings, overrides and isolates
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
/** Zero-width characters, which hide inside a word: removed, not spaced. */
export const ZERO_WIDTH: RegExp = /[\u200b-\u200d\ufeff]/g;

export function oneLine(text: string, max: number): string {
  const one = text.replace(ANSI, '').replace(ZERO_WIDTH, '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}
