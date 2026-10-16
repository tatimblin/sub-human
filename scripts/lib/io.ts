/** io: small read helpers shared by the scripts (never throw; missing files give the default). */
import fs from 'node:fs';

/**
 * A JSON file's value, or `d` when it is missing or unreadable. The value is not checked: `T` is what the caller
 * expects the file to hold (a demo artefact the scripts themselves wrote), and `unknown` when it says nothing.
 */
export function readJson<T = unknown>(f: string, d: T): T;
export function readJson<T = unknown>(f: string): T | undefined;
export function readJson<T>(f: string, d?: T): T | undefined {
  try { return parseJson<T>(fs.readFileSync(f, 'utf8')); } catch { return d; }
}
/** JSON.parse typed as what the caller expects (as readJson's `T`: not checked), `unknown` when it says nothing. */
export const parseJson: <T = unknown>(text: string) => T = JSON.parse;
export const readText = (f: string): string | null => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
/** The JSON lines of a file (unparsable lines dropped); `T` as readJson's. */
export const jsonl = <T = Record<string, unknown>>(f: string): T[] =>
  (readText(f) || '').split('\n').filter(Boolean).map((l): T | null => { try { return parseJson<T>(l); } catch { return null; } }).filter((x): x is T => x != null);
export const clip = (s: unknown, n = 160): string => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
export const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The text of a message's content (a string, or text/tool_result blocks joined). */
export const textOf = (c: unknown): string => (typeof c === 'string' ? c : Array.isArray(c)
  ? c.map((x: { text?: string, content?: unknown } | null) => (x && (x.text || (typeof x.content === 'string' ? x.content : ''))) || '').join('\n')
  : '');
