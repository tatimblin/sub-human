/**
 * plugin/sub-human/lib/cli/types.ts: the shared types of lib/cli/*.ts (type-only; nothing here runs).
 */

import type { PipeSpec, SshSpec, WsSpec } from '../remote/types-rest.ts';
import type { ProtoRange } from '../remote/types-core.ts';
import type { LinkState } from '../room/types.ts';

/** args.ts parse spec: 1 takes a value, 0 is a switch, '?' takes an optional value. */
export type FlagSpec = Readonly<Record<string, 0 | 1 | '?'>>;

/** The flags parse found for spec S: each one absent, or its value (true for a switch / a bare '?'). */
export type Flags<S extends FlagSpec> = {
  -readonly [K in keyof S]?: S[K] extends 0 ? true : S[K] extends 1 ? string : string | true;
};

/** args.ts parse(args, spec) -> {flags, rest, error?} */
export interface Parsed<S extends FlagSpec> {
  flags: Flags<S>;
  rest: string[];
  error?: string;
}

/** The output channels lib/cli/handoff.ts commands write through (main.ts passes die and console). */
export interface CliIo {
  die: (msg: string, code?: number) => never;
  out: (line: string) => void;
  err: (line: string) => void;
}

// ---------- doctor.ts ----------

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'info';

/** One doctor check: {id, status, title, detail, fix?} */
export interface Check {
  id: string;
  status: CheckStatus;
  title: string;
  detail: string;
  fix?: string;
}

/** A link file's transport as doctor reads it (lib/room/links.ts Link.transport): any built-in kind's fields, each
 * maybe missing (doctor reads a hand-edited file too). */
export type LinkTransportView = { kind?: string } & Partial<Omit<SshSpec, 'kind'> & Omit<PipeSpec, 'kind'> & Omit<WsSpec, 'kind'>>;

/** The link's state record (lib/room/link-state.ts read), or {state: 'offline'} when there is none. */
export type LinkStateView = Partial<LinkState> & Pick<LinkState, 'state'>;

/** A hello reply as the probe reads it (the server's JSON, unvalidated: every field may be missing). */
export interface HelloReply {
  v?: number;
  proto?: ProtoRange;
  server?: unknown;
  [k: string]: unknown;
}

/** doctor helloProbe(...) -> {ok, ms, reply?, error?, stderr?}; t0 and t1 are set on every answer (ok). */
export interface HelloProbe {
  ok: boolean;
  ms: number;
  t0?: number;
  t1?: number;
  reply?: HelloReply;
  error?: string;
  code?: string;
  stderr?: string;
  skipped?: boolean;
}

/** A link's hello as the report keeps it (diagnoseLink, unless --quick). */
export interface Reach {
  ok: boolean;
  ms: number;
  error?: string;
  skipped: boolean;
  hint: string | null;
  stderr: string;
  protocol: { v?: number; proto: ProtoRange | null; server: string | null } | null;
  skewMs: number | null;
}

/** diagnoseLink(code, opts) -> one link's report. */
export interface LinkReport {
  code: string;
  transport: { kind?: string; describe: string; user?: string; host?: string; port?: number; home?: string; login?: true };
  credential: string;
  daemon: { running: boolean; pid?: number | null };
  state: LinkStateView;
  recent: string[];
  request?: string;
  moved: { epoch?: number; host?: string; locator?: string; demoted: boolean; reached: boolean } | null;
  reach?: Reach;
  /** The room is known to be closed: the mirror's room Claude stopped, or the host's hello says so. */
  closed?: true;
}

/** One sub-human line of authorized_keys: unreadable, or parsed. */
export type KeyLine =
  | { ok: false; parse: false; raw: string; shimmed?: undefined; home?: undefined; type?: undefined; key?: undefined }
  | { ok: boolean; parse?: undefined; home: string; code: string; id: string; type: string; key: string; shimmed: boolean };

/** scanAuthorizedKeys(file) -> {file, exists, lines} */
export interface AuthorizedKeysScan {
  file: string;
  exists: boolean;
  lines: KeyLine[];
}

/** diagnose(opts) -> Report */
export interface Report {
  generated_at: string;
  versions: {
    plugin: string | null; node: string; claude: string | null; protocol: ProtoRange; ssh: string | null;
    platform: string; arch: string; os: string;
  };
  checks: Check[];
  links: LinkReport[];
  authorizedKeys: AuthorizedKeysScan;
  probe: { total: number; missing: string[] } | null;
}

/** doctor parseArgs(args) -> options */
export interface DoctorOptions {
  quick: boolean;
  fix: boolean;
  json: boolean;
  bundle: string | null;
  authorizedKeys: string | undefined;
  timeoutMs: number;
}
