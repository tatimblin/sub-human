/**
 * plugin/sub-human/lib/cli/types.ts: the shared types of lib/cli/*.ts (type-only; nothing here runs).
 */

import type { PipeSpec, SshSpec, WsSpec } from '../remote/types-rest.ts';
import type { ProtoRange } from '../remote/types-core.ts';
import type { LinkState } from '../room/types.ts';
import type { RoomCode } from '../brand.ts';

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
  reply?: HelloReply | undefined;
  error?: string;
  code?: string;
  stderr?: string;
  skipped?: boolean;
}

/** A link's hello as the report keeps it (diagnoseLink, unless --quick). */
export interface Reach {
  ok: boolean;
  ms: number;
  error?: string | undefined;
  /** the hello's error code (PROTOCOL: the two sides speak no common version) */
  code?: string;
  skipped: boolean;
  hint: string | null;
  stderr: string;
  protocol: { v?: number | undefined; proto: ProtoRange | null; server: string | null } | null;
  skewMs: number | null;
}

/** diagnoseLink(code, opts) -> one link's report. */
export interface LinkReport {
  code: RoomCode;
  transport: { kind?: string | undefined; describe: string; user?: string | undefined; host?: string | undefined; port?: number | undefined; home?: string | undefined; login?: true };
  credential: string;
  daemon: { running: boolean; pid?: number | null };
  state: LinkStateView;
  recent: string[];
  reach?: Reach;
  /** The room is known to be closed: the mirror's room Claude stopped, or the host's hello says so. */
  closed?: true;
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
  probe: { total: number; missing: string[] } | null;
}

/** doctor --bundle's file (lib/cli/doctor/redact.ts bundle): the report as an allowlist, every free text redacted,
 * host, user and room names hashed with the bundle's salt. */
export interface Bundle {
  kind: string;
  format: number;
  generated_at: string;
  note: string;
  versions: Report['versions'];
  config: {
    /** lib/config.ts's numeric and boolean values, by name */
    timings: Record<string, unknown>;
    /** the SUB_HUMAN_*_MS knobs set in the env, as numbers */
    env_overrides: Record<string, number>;
    ssh_opts_set: boolean;
    home_is_default: boolean;
  };
  checks: Check[];
  links: {
    room: string;
    transport: { kind: string | undefined; host: string | undefined; user: string | undefined; port: number | undefined };
    credential: string;
    daemon: { running: boolean };
    state: Pick<LinkState, 'state'> & { [K in 'since' | 'attempt' | 'rttMs' | 'queued' | 'lastError' | 'source']?: LinkState[K] | undefined };
    reach: (Pick<Reach, 'ok' | 'ms' | 'skipped' | 'protocol' | 'skewMs'> & { error: string | undefined; ssh_error: string[] | undefined }) | undefined;
    recent_errors: string[];
  }[];
  probe: Report['probe'];
}

/** doctor parseArgs(args) -> options */
export interface DoctorOptions {
  quick: boolean;
  fix: boolean;
  json: boolean;
  bundle: string | null;
  timeoutMs: number;
}
