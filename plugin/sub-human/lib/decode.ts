/**
 * plugin/sub-human/lib/decode.ts: decoders for data that comes from outside the type system (a file, stdin, the
 * wire, a child's stdout): `unknown` until a decoder accepts it. Zero dependencies; load it only where data is decoded
 * (lib/io.ts readJson takes a decoder by type alone).
 *
 *   Result<T, E>                 {ok: true, value} | {ok: false, error} (lib/errors.ts's, re-exported)
 *   Decoder<T>                   (v: unknown) -> Result<T, DecodeError>; error.at is where (".a.b[2]"), expected what
 *   Infer<D>                     the type a decoder gives
 *   str num int bool             a string; a number (finite); an integer; a boolean
 *   unknown_                     anything (a field that must only be present, or is read with its own checks)
 *   lit(...values)               one of these values (===)
 *   arr(d)                       an array whose every item d accepts
 *   record(d)                    a plain object (not an array) whose every own value d accepts
 *   obj({k: d, ...})             a plain object whose listed fields the decoders accept; other keys are allowed and
 *                                kept: the value is the input itself, never a copy (a record a newer version wrote
 *                                keeps its fields when it is written back)
 *   opt(d)                       in obj: the field may be missing (or undefined)
 *   nullable(d)                  null, or what d accepts
 *   union(tag, {value: d, ...})  an object whose field tag names the decoder that reads it
 *   refine(d, pred, expected)    what d accepts and pred holds for
 *   decode(d, v) -> T | null     the value, or null when d refuses it
 *   decodeOr(d, v, fallback)     the value, or fallback when d refuses it
 *   isObj(v)                     a plain object (not null, not an array): the guard obj and record start from
 *   objAs<T>()                   a plain object read as T, its fields unchecked: for a document whose readers check
 *                                each field as they use it, as they always have (this home's own records and store
 *                                documents, a link record; a Claude Code file read defensively). The one trust this
 *                                module grants: T must be what that document's writer writes, or all-optional
 *
 * A decoder never throws and never changes its input. Records on disk may have been written by an older version:
 * their decoders list a field as required only where every version wrote it, and leave unknown keys alone.
 */

import type { Result } from './errors.ts';
export type { Result }; // lib/errors.ts: the one Result

/** Where a decoder refused, and what it wanted there. */
export interface DecodeError { at: string; expected: string }

export type Decoder<T> = (v: unknown) => Result<T, DecodeError>;
/** opt()'s decoder: obj makes its field optional. */
export type OptDecoder<T> = Decoder<T | undefined> & { readonly optional: true };
export type Infer<D> = D extends Decoder<infer T> ? T : never;

type Shape = Record<string, Decoder<unknown>>;
type OptKeys<S extends Shape> = { [K in keyof S]: S[K] extends { readonly optional: true } ? K : never }[keyof S];
type Flat<T> = { [K in keyof T]: T[K] };
/** The object type obj(shape) gives: an opt() field is optional, every other one required. */
export type ObjOf<S extends Shape> = Flat<{ [K in Exclude<keyof S, OptKeys<S>>]: Infer<S[K]> } & { [K in OptKeys<S>]?: Infer<S[K]> }>;

const okv = <T>(value: T): Result<T, DecodeError> => ({ ok: true, value });
const no = (expected: string, at = ''): { ok: false; error: DecodeError } => ({ ok: false, error: { at, expected } });

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** d, read as a guard: true when d accepts v. */
const guard = <T>(d: Decoder<T>) => (v: unknown): v is T => d(v).ok;

export const str: Decoder<string> = v => (typeof v === 'string' ? okv(v) : no('a string'));
export const num: Decoder<number> = v => (typeof v === 'number' && Number.isFinite(v) ? okv(v) : no('a number'));
export const int: Decoder<number> = v => (typeof v === 'number' && Number.isInteger(v) ? okv(v) : no('an integer'));
export const bool: Decoder<boolean> = v => (typeof v === 'boolean' ? okv(v) : no('a boolean'));
export const unknown_: Decoder<unknown> = okv;

export function lit<const L extends readonly (string | number | boolean | null)[]>(...values: L): Decoder<L[number]> {
  return v => {
    for (const x of values) if (x === v) return okv(x);
    return no(values.map(x => JSON.stringify(x)).join(' | '));
  };
}

export function arr<T>(d: Decoder<T>): Decoder<T[]> {
  return v => {
    if (!Array.isArray(v)) return no('an array');
    for (let i = 0; i < v.length; i++) {
      const r = d(v[i]);
      if (!r.ok) return no(r.error.expected, `[${i}]${r.error.at}`);
    }
    return okv(v as T[]); // every item checked
  };
}

export function record<T>(d: Decoder<T>): Decoder<Record<string, T>> {
  return v => {
    if (!isObj(v)) return no('an object');
    for (const k of Object.keys(v)) {
      const r = d(v[k]);
      if (!r.ok) return no(r.error.expected, `.${k}${r.error.at}`);
    }
    return okv(v as Record<string, T>); // every value checked
  };
}

export function obj<S extends Shape>(shape: S): Decoder<ObjOf<S>> {
  const keys = Object.keys(shape);
  return v => {
    if (!isObj(v)) return no('an object');
    for (const k of keys) {
      const r = shape[k](v[k]);
      if (!r.ok) return no(r.error.expected, `.${k}${r.error.at}`);
    }
    return okv(v as ObjOf<S>); // every listed field checked; the others are the input's own
  };
}

export function opt<T>(d: Decoder<T>): OptDecoder<T> {
  const f: Decoder<T | undefined> = v => (v === undefined ? okv(undefined) : d(v));
  return Object.assign(f, { optional: true as const });
}

export function nullable<T>(d: Decoder<T>): Decoder<T | null> {
  return v => (v === null ? okv(null) : d(v));
}

export function union<K extends string, M extends Record<string, Decoder<unknown>>>(tag: K, cases: M): Decoder<Infer<M[keyof M]>> {
  return v => {
    if (!isObj(v)) return no('an object');
    const t = v[tag];
    if (typeof t !== 'string' || !Object.hasOwn(cases, t)) return no(Object.keys(cases).join(' | '), `.${tag}`);
    return cases[t](v) as Result<Infer<M[keyof M]>, DecodeError>; // the case's decoder: one of the union's
  };
}

export function refine<T, U extends T = T>(d: Decoder<T>, pred: ((x: T) => x is U) | ((x: T) => boolean), expected: string): Decoder<U> {
  return v => {
    const r = d(v);
    if (!r.ok) return r;
    return pred(r.value) ? okv(r.value as U) : no(expected); // pred holds (a guard's U, or T)
  };
}

export function objAs<T extends object>(): Decoder<T> {
  return v => (isObj(v) ? okv(v as T) : no('an object')); // its readers check its fields: see the header
}

export function decode<T>(d: Decoder<T>, v: unknown): T | null {
  const r = d(v);
  return r.ok ? r.value : null;
}

export function decodeOr<T>(d: Decoder<T>, v: unknown, fallback: NoInfer<T>): T;
export function decodeOr<T, F>(d: Decoder<T>, v: unknown, fallback: F): T | F;
export function decodeOr<T, F>(d: Decoder<T>, v: unknown, fallback: F): T | F {
  const r = d(v);
  return r.ok ? r.value : fallback;
}

export { guard };
