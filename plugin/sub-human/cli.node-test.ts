// The node entry: parseArgs cases, the terminal verbs, and the command hooks as Claude Code runs them (`sh
// hooks/node.sh HOOK` with a recorded payload on stdin, in a temp home): stdout, the exit code, and nothing on stderr on
// success.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homeLost, hook, parse, terminal, USAGE } from './cli.js';
import { HELP } from './commands/help.js';
import { call } from './net/daemon/client.js';
import { fakeHome } from './test/support/fake-daemon.js';
import { tempHome, testCtx } from './test/support/command-ctx.js';
import { hookFixture } from './test/support/fixtures.js';

test('parse: doctor and help, --home, -h; anything else is an error', () => {
  assert.deepEqual(parse([]), { verb: 'help' });
  assert.deepEqual(parse(['doctor']), { verb: 'doctor' });
  assert.deepEqual(parse(['doctor', '--home', '/h']), { verb: 'doctor', home: '/h' });
  assert.deepEqual(parse(['--home=/h', 'help']), { verb: 'help', home: '/h' });
  assert.deepEqual(parse(['doctor', '-h']), { verb: 'help' });
  assert.deepEqual(parse(['leave']), { error: 'leave: not a terminal command' });
  assert.deepEqual(parse(['doctor', 'now']), { error: 'doctor now: not a terminal command' });
  const unknown = parse(['--force']);
  assert.ok('error' in unknown && unknown.error.includes('--force'));
  assert.ok('error' in parse(['--home']));
});

test('terminal runs doctor or help in the home named, and answers usage with exit 2', async () => {
  const homes: string[] = [];
  const ctx = (home: string) => { homes.push(home); return testCtx(fakeHome()); };
  assert.deepEqual(await terminal(['help'], '/default', ctx), { out: HELP, exit: 0 });
  const d = await terminal(['doctor', '--home', '/elsewhere'], '/default', ctx);
  assert.equal(d.exit, 0);
  assert.match(d.out, /^ok {4}node /);
  assert.deepEqual(homes, ['/default', '/elsewhere']);
  assert.deepEqual(await terminal(['who'], '/default', ctx), { out: `who: not a terminal command\n${USAGE}`, exit: 2 });
});

// an unknown hook's line is node.sh's test below
test('hook: stdin that is not JSON answers nothing', async () => {
  const never = () => { throw new Error('built a context'); };
  assert.deepEqual(await hook('start', 'not json', never), { exit: 0 });
});

const SHIM = fileURLToPath(new URL('./hooks/node.sh', import.meta.url));
const SID = '00000000-0000-4000-8000-000000000001';
const homes: string[] = [];

function run(name: string, stdin: unknown, home: string, env: NodeJS.ProcessEnv = {}) {
  const r = spawnSync('sh', [SHIM, name], {
    input: typeof stdin === 'string' ? stdin : JSON.stringify(stdin), encoding: 'utf8',
    env: { ...process.env, SUB_HUMAN_HOME: home, SUB_HUMAN_NAME: 'alice', ...env }, timeout: 15_000,
  });
  return { out: r.stdout, err: r.stderr, exit: r.status };
}
const expansion = (args: string) => ({ ...hookFixture('hook-user-prompt-expansion-steps', 'UserPromptExpansion'), command_name: 'room', command_args: args });
const start = hookFixture('hook-session-start-steps', 'SessionStart');

after(async () => {
  for (const home of homes) {
    const s = await call(home, { op: 'status' }, 500);
    if (s.ok) process.kill(s.value.pid);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('node.sh start in no room: nothing on stdout or stderr, exit 0, from any directory, bare beside it, or with a CDPATH that makes cd print', () => {
  assert.deepEqual(run('start', start, tempHome()), { out: '', err: '', exit: 0 });
  const plugin = path.dirname(path.dirname(SHIM));
  for (const [cwd, shim, env] of [[path.dirname(SHIM), 'node.sh', {}], [plugin, 'hooks/node.sh', { CDPATH: plugin }]] as const) {
    const r = spawnSync('sh', [shim, 'start'], { cwd, input: JSON.stringify(start), encoding: 'utf8', env: { ...process.env, SUB_HUMAN_HOME: tempHome(), ...env } });
    assert.deepEqual([r.stdout, r.stderr, r.status], ['', '', 0], shim);
  }
});

test('node.sh, through the real daemon: no join before the module pings (C1); then a join, its title at the next SessionStart, and SessionEnd removing its pointer', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-')); // short: a socket path holds at most 103 bytes
  homes.push(home);
  const off = run('expand', expansion(''), home);
  assert.equal(Reflect.get(JSON.parse(off.out), 'reason'), "sub-human: Nobody joined: sharing needs Claude Code's hooks modules, which are off here.");
  assert.ok(!fs.existsSync(path.join(home, 'rooms')), 'no room, so no presence');
  assert.ok((await call(home, { op: 'ping', session: SID })).ok); // the module's first ping, in no room
  const joined = run('expand', expansion(''), home);
  assert.equal(joined.err, '');
  const reason = String(Reflect.get(JSON.parse(joined.out), 'reason'));
  const code = /room ([a-z]+-\d{4}) as alice/.exec(reason)?.[1];
  assert.ok(code, reason);
  const log = () => fs.readFileSync(path.join(home, 'rooms', code, 'log.jsonl'), 'utf8');
  assert.ok(log().includes('"kind":"joined"'));
  assert.deepEqual(JSON.parse(run('start', start, home).out), { hookSpecificOutput: { hookEventName: 'SessionStart', sessionTitle: `alice.${code}` } });
  assert.deepEqual(run('end', hookFixture('hook-session-end-steps', 'SessionEnd'), home), { out: '', err: '', exit: 0 });
  assert.ok(!log().includes('"kind":"left"'), 'ending the session is no leave');
  assert.deepEqual(fs.readdirSync(path.join(home, 'sessions')).filter(f => f.startsWith(SID)), []);
});

test('node.sh: an unknown hook is one stderr line and exit 1', () => {
  assert.deepEqual(run('bogus', '{}', tempHome()), { out: '', err: 'sub-human: no hook bogus\n', exit: 1 });
});

/** A fake node at `bin` that answers -v with `version` and marks that it ran; it runs the real one when `real`. */
function fakeNode(bin: string, version: string, real: boolean): string {
  fs.mkdirSync(bin, { recursive: true });
  const marker = path.join(bin, 'ran');
  fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\n[ "$1" = -v ] && { echo ${version}; exit 0; }\ntouch "${marker}"\n${real ? `exec "${process.execPath}" "$@"\n` : ''}`, { mode: 0o755 });
  return marker;
}

test('node.sh finds a node where fnm, XDG nvm, nodenv and n keep it, with no node on PATH', () => {
  for (const [where, env] of [
    ['.fnm/node-versions/v99.0.0/installation/bin', {}],
    ['.local/share/nvm/versions/node/v99.0.0/bin', {}],
    ['.nodenv/versions/99.0.0/bin', {}],
    ['n/versions/node/99.0.0/bin', { N_PREFIX: 'HOME' }],
  ] as const) {
    const home = tempHome();
    const marker = fakeNode(path.join(home, where), 'v99.0.0', true);
    const extra = 'N_PREFIX' in env ? { N_PREFIX: home } : {};
    const r = run('start', start, tempHome(), { PATH: '/usr/bin:/bin', HOME: home, XDG_DATA_HOME: '', ...extra });
    assert.deepEqual([r.out, r.err, r.exit], ['', '', 0], where);
    assert.ok(fs.existsSync(marker), `${where}: ran the node found there`);
  }
});

test('each hook loads only what it needs: SessionStart and Notification never load the verbs or the store', () => {
  const traced = (name: string, stdin: unknown): string => {
    const file = path.join(tempHome(), 'trace');
    const r = spawnSync(process.execPath, [
      '--import', fileURLToPath(new URL('./resolve-ts.ts', import.meta.url)),
      '--import', fileURLToPath(new URL('./test/support/trace-imports.ts', import.meta.url)),
      fileURLToPath(new URL('./cli.ts', import.meta.url)), 'hook', name,
    ], { input: JSON.stringify(stdin), encoding: 'utf8', env: { ...process.env, SUB_HUMAN_HOME: tempHome(), SH_TEST_TRACE: file } });
    assert.equal(r.status, 0, r.stderr);
    return fs.readFileSync(file, 'utf8');
  };
  const heavy = ['/commands/index.ts', '/commands/bare.ts', '/commands/doctor.ts', '/store/fs-store.ts', '/core/fold.ts', '/net/daemon/client.ts'];
  const notification = hookFixture('notification-permission-prompt', 'Notification',
    n => fs.readFileSync(new URL(`./test/fixtures/hooks/${n}.json`, import.meta.url), 'utf8'));
  for (const [name, stdin] of [['start', start], ['notify', notification]] as const) {
    const loaded = traced(name, stdin);
    for (const h of heavy) assert.ok(!loaded.includes(h), `${name} loaded ${h}`);
  }
  const help = traced('expand', expansion('help'));
  assert.ok(help.includes('/commands/help.ts'));
  for (const h of ['/commands/bare.ts', '/commands/doctor.ts', '/store/fs-store.ts', '/net/daemon/client.ts']) assert.ok(!help.includes(h), `help loaded ${h}`);
});

test('node.sh never runs a node too old to strip types', () => {
  const bin = tempHome();
  const marker = fakeNode(bin, 'v20.1.0', false);
  const r = run('start', start, tempHome(), { PATH: `${bin}:/usr/bin:/bin` });
  assert.equal(fs.existsSync(marker), false);
  assert.ok(r.exit === 0 || r.err.includes('needs Node 22.18+ or 24.3+'), r.err);
});

test('a run the module started that lost its home is refused in one line, never run on the default home', () => {
  const home = ['SUB', 'HUMAN', 'HOME'].join('_');
  assert.match(JSON.stringify(homeLost({ SUB_HUMAN_FROM_MODULE: '1' })), /nothing ran: the command didn't get this session's home/);
  assert.equal(homeLost({ SUB_HUMAN_FROM_MODULE: '1', [home]: '/tmp/h' }), null);
  assert.equal(homeLost({}), null); // the classic hook, run by Claude Code itself
});
