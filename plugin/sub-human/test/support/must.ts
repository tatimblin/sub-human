/** v, or a thrown error naming what was missing: how a test narrows without `!`. */
export function must<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined) throw new Error(`expected ${what}`);
  return v;
}
