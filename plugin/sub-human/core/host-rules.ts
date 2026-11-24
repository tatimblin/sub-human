// The host's limits as pure rules (R30, R37, R40): how long a line and a card last, the connection caps per source and
// in all, the per-link write window, and how the addresses a line is made from are read. net/host.ts applies them.

export const INVITE_TTL_MS: number = 15 * 60_000;
export const ADMIT_MS: number = 5 * 60_000;
export const SOURCE_MAX: number = 8;
/** Every ssh -W connection is the one source `local`, so it has a cap of its own, well under the total. */
export const LOCAL_MAX: number = 32;
/** Connections not yet closed from every source together, so many made-up sources still hold little. */
export const TOTAL_MAX: number = 64;
/** Of those, what only local connections (ssh -W, which come with no PROXY header) may take: so public sources can't
 *  lock out ssh joiners. */
export const LOCAL_RESERVE: number = 8;
export type Rated = 'append' | 'put_blob' | 'put_doc' | 'message' | 'subscribe';
/** Per link and minute (R40); a plan or task call counts as an append. */
export const RATES: Readonly<Record<Rated, number>> = { append: 120, put_blob: 30, put_doc: 240, message: 120, subscribe: 6 };

/** Whether one more connection from `source` fits, with `n` open from it and `total` from all. */
export function fits(source: string, n: number, total: number): boolean {
  const local = source === 'local';
  return n < (local ? LOCAL_MAX : SOURCE_MAX) && total < (local ? TOTAL_MAX : TOTAL_MAX - LOCAL_RESERVE);
}

/** A minute's count of one kind of write; a refused write counts too. */
export interface Window { readonly at: number; readonly n: number }
export function allow(w: Window | undefined, now: number, cap: number): { readonly window: Window; readonly ok: boolean } {
  if (!w || now - w.at >= 60_000) return { window: { at: now, n: 1 }, ok: true };
  return { window: { at: w.at, n: w.n + 1 }, ok: w.n + 1 <= cap };
}

/** A source as its cap counts it: an IPv4 address, or an IPv6 one's /64, which one joiner holds whole. */
export const perNet = (s: string): string => (s.includes(':') ? `${s.split(':').slice(0, 4).join(':')}::/64` : s);
/** A loopback source: a local peer claiming to be tailscaled's forward. */
export const isLoopback = (s: string): boolean => /^(127\.|0:0:0:0:0:0:0:1$|0:0:0:0:0:ffff:7f)/.test(s);

/** A port written in decimal, 0 to 65535, or null. */
export function parsePort(s: string): number | null {
  const n = /^\d{1,5}$/.test(s) ? Number(s) : NaN;
  return n <= 65_535 ? n : null;
}

/** SUB_HUMAN_SSH_ADDR, `[user@]host[:port]`, or null when it is not one (never an ssh option: no leading '-'). */
export function sshAddress(s: string): { readonly host: string; readonly user: string | null; readonly sshPort: number | null } | null {
  const m = /^(?:([A-Za-z0-9_][A-Za-z0-9._-]*)@)?([A-Za-z0-9][A-Za-z0-9.-]*)(?::(\d{1,5}))?$/.exec(s);
  if (!m?.[2]) return null;
  return { host: m[2], user: m[1] ?? null, sshPort: m[3] ? Number(m[3]) : null };
}
