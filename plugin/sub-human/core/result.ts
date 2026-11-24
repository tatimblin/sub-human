// The plugin's one Result: what a call that can fail returns instead of throwing. `error` is one plain line, written
// as what didn't happen (R43), so a caller can show it or log it as is.

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

export function ok<T>(value: T): Result<T> { return { ok: true, value }; }
export function err<T = never>(error: string): Result<T> { return { ok: false, error }; }
