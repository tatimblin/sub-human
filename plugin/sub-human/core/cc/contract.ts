/**
 * contract: contract.json typed, and the pure matcher the probe runs over it (ARCHITECTURE §2 principle 6, PRD C2).
 * The caller reads the files: `typings` is the snapshot's declarations, `binary` the Claude Code binary's bytes as a
 * latin1 string (one char a byte), so this file stays loadable by the module.
 */
import * as v from '../../vendor/valibot.mjs';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';

/**
 * The parts of sub-human a Claude Code fact serves, by which the canary groups its failures. Four of them can be
 * turned off with SUB_HUMAN_CC_OFF (config.ts GATED): wake, messages, tasks-bridge and invite-band.
 */
export const FEATURES = [
  'core', 'capture', 'tasks-bridge', 'context', 'status', 'cards', 'pane', 'plan-review', 'wake', 'presence', 'repo', 'messages', 'invite-band',
] as const;
export type Feature = (typeof FEATURES)[number];
/** PRD C2: at most this many entries may rest on undocumented behaviour. */
export const INTERNAL_CAP = 10;

const text = v.pipe(v.string(), v.minLength(1));
const version = v.pipe(v.string(), v.regex(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/));
const common = {
  id: v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]*$/)),
  feature: v.picklist(FEATURES),
  surface: text,
  checked: v.array(version),
  note: text,
};
const Fragment = v.union([text, v.strictObject({ in: text, has: v.pipe(v.array(text), v.minLength(1)) })]);
const ApiSchema = v.strictObject({ ...common, kind: v.literal('api'), typings: v.pipe(v.array(Fragment), v.minLength(1)) });
// The binary keeps non-ASCII string constants as UTF-16, so only an ASCII search string is found byte for byte.
const ascii = v.pipe(text, v.regex(/^[\x00-\x7f]*$/, 'a search string must be ASCII (the binary keeps the rest as UTF-16)'));
const InternalSchema = v.pipe(
  v.strictObject({
    ...common,
    kind: v.literal('internal'),
    search: v.array(ascii),
    unverified: v.optional(text),
    reason: text,
    fallback: text,
    request: text,
  }),
  v.check(e => e.unverified !== undefined || e.search.length > 0, 'a verified internal entry needs a search string'),
);
const ContractSchema: v.GenericSchema<unknown, Contract> = v.pipe(
  v.strictObject({ note: text, probed: version, entries: v.array(v.variant('kind', [ApiSchema, InternalSchema])) }),
  v.check(c => new Set(c.entries.map(e => e.id)).size === c.entries.length, 'entry ids must be unique'),
  v.check(c => c.entries.filter(e => e.kind === 'internal').length <= INTERNAL_CAP, `at most ${INTERNAL_CAP} internal entries (PRD C2)`),
);

interface Common { id: string, feature: Feature, surface: string, checked: string[], note: string }
/**
 * A declaration in the typings: a fragment of it, or members (`has`) inside the declaration that starts at `in`, so a
 * member is tied to its parent type whatever the members around it.
 */
export type Fragment = string | { in: string, has: string[] };
/** In the typings: each fragment is in the snapshot. */
export interface ApiEntry extends Common { kind: 'api', typings: Fragment[] }
/** Undocumented: each search string is in the binary, unless `unverified` says why none proves it yet. */
export interface InternalEntry extends Common {
  kind: 'internal', search: string[], unverified?: string | undefined, reason: string, fallback: string, request: string,
}
export type Entry = ApiEntry | InternalEntry;
export interface Contract { note: string, probed: string, entries: Entry[] }

/** contract.json's value checked, or the first problem with where it is. */
export function parseContract(json: unknown): Result<Contract> {
  const r = v.safeParse(ContractSchema, json);
  if (r.success) return ok(r.output);
  const issue = r.issues[0];
  return err(`${v.getDotPath(issue) ?? 'contract'}: ${issue.message}`);
}

export type Status = 'pass' | 'fail' | 'skip';
export interface Check { id: string, kind: Entry['kind'], feature: Feature, status: Status, missing: string[], why?: string }

/** Declarations only: comments out and whitespace squashed, as a declaration may be reflowed between versions. */
const squash = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/[^\n]*/gm, ' ').replace(/\s+/g, ' ');

/**
 * The declaration that starts at `at` in squashed typings: to the `;` or the `}` that closes it at depth 0, a `|` or
 * `&` after a `}` continuing it (a union of object types).
 */
function declarationAt(t: string, at: number): string {
  let depth = 0;
  for (let i = at; i < t.length; i++) {
    const c = t[i];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') {
      if (--depth === 0 && c === '}' && !/^ ?[|&]/.test(t.slice(i + 1, i + 3))) return t.slice(at, i + 1);
    } else if (c === ';' && depth === 0) return t.slice(at, i + 1);
  }
  return t.slice(at);
}

/** What of a fragment the squashed typings lack, as the lines the probe prints. */
function missingIn(t: string, f: Fragment): string[] {
  if (typeof f === 'string') return t.includes(squash(f)) ? [] : [f];
  const at = t.indexOf(squash(f.in));
  if (at < 0) return [`no ${f.in}`];
  const body = declarationAt(t, at);
  return f.has.filter(m => !body.includes(squash(m))).map(m => `${m} in ${f.in}`);
}

/** One entry against the haystacks: api entries need the typings, internal ones the binary (null: not read). */
export function check(e: Entry, hay: { typings: string | null, binary: string | null }): Check {
  const base = { id: e.id, kind: e.kind, feature: e.feature };
  if (e.kind === 'internal' && e.unverified !== undefined) return { ...base, status: 'skip', missing: [], why: `unverified: ${e.unverified}` };
  let missing: string[];
  if (e.kind === 'api') {
    if (hay.typings === null) return { ...base, status: 'skip', missing: [], why: 'no typings read' };
    const t = squash(hay.typings);
    missing = e.typings.flatMap(f => missingIn(t, f));
  } else {
    const binary = hay.binary;
    if (binary === null) return { ...base, status: 'skip', missing: [], why: 'no binary read' };
    missing = e.search.filter(s => !binary.includes(s));
  }
  return { ...base, status: missing.length ? 'fail' : 'pass', missing };
}

/** The probe over every entry. */
export const probe = (c: Contract, hay: { typings: string | null, binary: string | null }): Check[] => c.entries.map(e => check(e, hay));

/** Per feature: how many entries it has and which failed. Every feature with an entry is listed. */
export function byFeature(results: readonly Check[]): Partial<Record<Feature, { total: number, failed: string[] }>> {
  const out: Partial<Record<Feature, { total: number, failed: string[] }>> = {};
  for (const r of results) {
    const g = (out[r.feature] ??= { total: 0, failed: [] });
    g.total++;
    if (r.status === 'fail') g.failed.push(r.id);
  }
  return out;
}

/** The version a Claude Code binary was built as: its first `VERSION:"X"` literal (latin1 view), or null. */
export function binaryVersion(binary: string): string | null {
  const at = binary.indexOf('VERSION:"');
  return at < 0 ? null : /^VERSION:"(\d+\.\d+\.\d+(?:-[\w.]+)?)"/.exec(binary.slice(at, at + 48))?.[1] ?? null;
}
