// The wiring tests' shared setup (mod/test/*.test.ts import it; `claude plugin test` runs only *.test.ts files).
// Each test file keeps its own world(): what the engine beneath answers differs per hook.

import type { EventOf, On } from 'claude-code';
import type { Engine } from 'claude-code/testing';

/** A seat as mod-hello prints it (types/index.d.ts SubHumanSeat). */
export type Seat = { name: string; code: string; role: 'member' | 'claude'; addr: string };

export const CODE = 'otter-4821';
/** A seat as mod-hello prints it. */
export const seatOf = (name: string, role: Seat['role'] = 'member'): Seat => ({ name, code: CODE, role, addr: `${name}.${CODE}` });
/** mod-hello's answer for a seat (null: unseated). */
export const helloOf = (seat: Seat | null) => ({ home: '/u/.sub-human', realHome: '/u/.sub-human', userHome: '/u', pluginRoot: '/p/sub-human', seat });
export const SEAT = seatOf('alice');
export const OUT = helloOf(SEAT);

/** A $.process.run result. */
export const ran = (stdout = '', exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } });
/** The hook a $.process.run call runs, as its handler file ("mod-hello.ts": node hooks/run.ts mod-hello). */
export const scriptOf = (e: EventOf['process.run']): string => (/\/hooks\/run\.ts$/.test(String(e.argv.at(-2))) ? `${e.argv.at(-1)}.ts` : String(e.argv.at(-1)).replace(/^.*\/hooks\//, ''));

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** A $.process.run call's stdin, parsed: the payload the hook got. */
export function stdinOf(e: EventOf['process.run']): Record<string, unknown> {
  const v: unknown = JSON.parse(e.init?.stdin ?? '');
  if (!isRecord(v)) throw new Error(`stdin is no JSON object: ${e.init?.stdin}`);
  return v;
}

/** v, asserted present (test/support/must.ts's, which a hooks module cannot import: it needs node:assert). */
export function must<T>(v: T | null | undefined, what = 'a value'): T {
  if (v === null || v === undefined) throw new Error(`expected ${what}`);
  return v;
}

/** The session every world starts from: its id, and a session.start the engine takes. */
export function session(on: On, sid: string): void {
  on('session.id', () => ({ value: sid }));
  on('session.start', (_$, e) => ({ cwd: e.cwd }));
}
export const start = ($: Engine, isInteractive = true) => $.session.start({ cwd: '/w', surface: null, isInteractive });
