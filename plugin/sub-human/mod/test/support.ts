// The wiring tests' shared setup (mod/test/*.test.ts import it; `claude plugin test` runs only *.test.ts files).
// Each test file keeps its own world(): what the engine beneath answers differs per hook.

export const CODE = 'otter-4821';
/** A seat as mod-hello prints it. */
export const seatOf = (name, role = 'member') => ({ name, code: CODE, role, addr: `${name}.${CODE}` });
/** mod-hello's answer for a seat (null: unseated). */
export const helloOf = seat => ({ home: '/u/.sub-human', realHome: '/u/.sub-human', userHome: '/u', pluginRoot: '/p/sub-human', seat });
export const SEAT = seatOf('alice');
export const OUT = helloOf(SEAT);

/** A $.process.run result. */
export const ran = (stdout = '', exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } });
/** The hooks/ script a $.process.run call runs ("mod-hello.ts"). */
export const scriptOf = e => String(e.argv[1]).replace(/^.*\/hooks\//, '');

/** The session every world starts from: its id, and a session.start the engine takes. */
export function session(on, sid) {
  on('session.id', () => ({ value: sid }));
  on('session.start', ($, e) => ({ cwd: e.cwd }));
}
export const start = ($, isInteractive = true) => $.session.start({ cwd: '/w', surface: null, isInteractive });
