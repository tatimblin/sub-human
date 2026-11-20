// hooks/handlers/row-hold.ts (SubagentStop) for the one room row, and hooks/launcher.ts (the launcher a person's
// opt-in subagentStatusLine runs, written by a join or a restore). Payload shapes are the ones logged in P0 (Claude
// Code 2.1.281).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import * as identity from '../../lib/identity.ts';
import * as launcher from '../../hooks/launcher.ts';
import { pathToFileURL } from 'node:url';
import type { HookLine } from './helpers.ts';
import { sn } from '../support/brands.ts';
import { must } from '../support/must.ts';

type Env = Record<string, string | undefined>;
/** One group of hooks.json, as far as the tests read it. */
interface HookGroup { matcher?: string; hooks: { command: string; asyncRewake?: boolean }[] }

const PLUGIN = path.join(import.meta.dirname, '..', '..');
for (const k of Object.keys(process.env)) if (k.startsWith('CLAUDE')) delete process.env[k];

const sleepers: ChildProcess[] = [];
process.on('exit', () => { for (const p of sleepers) { try { p.kill('SIGKILL'); } catch { /* gone */ } } });
const sleeper = () => { const p = spawn('sleep', ['600'], { stdio: 'ignore' }); p.unref(); sleepers.push(p); return p.pid; };

function world(names: string[]) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-rowhooks-'));
  process.env.SUB_HUMAN_HOME = home;
  const code = identity.newCode();
  for (const name of names) {
    const r = identity.join({ code, name: sn(name), role: name === 'claude' ? 'claude' : 'member', pid: sleeper(), session_id: `sid-${name}`, cwd: os.tmpdir() });
    assert.ok(r.ok, r.error);
  }
  return { home, code };
}
function env(extra: Env = {}) {
  const e: Env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('CLAUDE') && k !== 'NODE_TEST_CONTEXT') e[k] = v;
  return { ...e, CLAUDE_PLUGIN_ROOT: PLUGIN, ...extra };
}
function hook(name: string, input: Record<string, unknown>, extra?: Env): { code: number | null; stdout: string; stderr: string; json: HookLine | null } {
  const r = spawnSync(process.execPath, [path.join(PLUGIN, 'hooks', 'run.ts'), name], { input: JSON.stringify(input), env: env(extra), encoding: 'utf8', timeout: 20_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json: r.stdout.trim() ? JSON.parse(r.stdout) as HookLine : null };
}
/** hooks/launcher.ts refresh() in a child of its own, as a join or a restore runs it, with env extra. */
function launch(extra?: Env): { code: number | null; stderr: string } {
  const url = pathToFileURL(path.join(PLUGIN, 'hooks', 'launcher.ts')).href;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `(await import(${JSON.stringify(url)})).refresh()`], { env: env(extra), encoding: 'utf8', timeout: 20_000 });
  return { code: r.status, stderr: r.stderr };
}
test('row-hold: blocks the room row when it stops while this seat is in the room (capped); lets STOP/left through; nothing for any other agent or seat', () => {
  const { code } = world(['claude', 'alice', 'bob']);
  const stop = (id: string, last: string, type = 'sub-human:room', sid = 'sid-alice') => hook('row-hold', {
    session_id: sid, hook_event_name: 'SubagentStop', agent_id: id, agent_type: type, stop_hook_active: false, last_assistant_message: last,
  });
  const r = stop('r1', 'error');
  assert.equal(must(r.json).decision, 'block');
  assert.match(must(must(r.json).reason), new RegExp(`Call hold with \\{"room": "${code}"\\} again now`));
  for (let i = 0; i < 4; i++) assert.equal(must(stop('r1', 'error').json).decision, 'block');
  assert.equal(stop('r1', 'error').json, null, 'capped');
  assert.equal(stop('r2', 'left').json, null, 'a row that ended for good');
  assert.equal(stop('r3', 'STOP: duplicate row').json, null);
  assert.equal(stop('a1', 'error', 'sub-human:participant').json, null, "an older version's participant row: let go");
  assert.equal(stop('a1', 'error', '').json, null, 'AgentSummary forks have no agent_type');
  assert.equal(stop('r4', 'error', 'sub-human:room', 'sid-claude').json, null, 'the room session keeps no row');
  assert.equal(stop('r5', 'error', 'sub-human:room', 'sid-nobody').json, null, 'not in a room');
  // the viewer left: no block
  identity.leave(code, sn('alice'));
  assert.equal(stop('r6', 'hmm').json, null);
});

test('launcher: writes an executable launcher under SUB_HUMAN_HOME/bin that runs this plugin\'s agent-statusline', () => {
  const { home, code } = world(['claude', 'alice']);
  const r = launch();
  assert.equal(r.code, 0, r.stderr);
  const f = path.join(home, 'bin', 'row-status');
  const body = fs.readFileSync(f, 'utf8');
  assert.match(body, /^#!\/bin\/sh\n/);
  assert.ok(body.includes(`exec node '${path.join(PLUGIN, 'scripts', 'sub-human')}' agent-statusline`));
  assert.ok(fs.statSync(f).mode & 0o100, 'executable');
  const mtime = fs.statSync(f).mtimeMs;
  launch();
  assert.equal(fs.statSync(f).mtimeMs, mtime, 'unchanged content is not rewritten');
  // and the SSH serve shim with its pointer at this plugin (lib/remote/shim.ts)
  assert.equal(fs.statSync(path.join(home, 'bin', 'serve')).mode & 0o777, 0o700);
  assert.ok(fs.readFileSync(path.join(home, 'bin', 'current'), 'utf8').startsWith(path.resolve(PLUGIN) + '\n'));
  // The plugin sets no subagentStatusLine (no settings.json); the README's opt-in line for the person's own settings
  // points at the launcher, through the shell's env default.
  assert.ok(!fs.existsSync(path.join(PLUGIN, 'settings.json')), 'the plugin ships no settings.json');
  const readme = fs.readFileSync(path.join(PLUGIN, 'README.md'), 'utf8');
  const line = must(/```json\n("subagentStatusLine": .*)\n```/.exec(readme), 'the README\'s opt-in line')[1];
  const settings = JSON.parse(`{${must(line, 'the line')}}`) as { subagentStatusLine: { type: string; command: string } };
  assert.equal(settings.subagentStatusLine.type, 'command');
  const cmd = settings.subagentStatusLine.command;
  const resolved = spawnSync('/bin/sh', ['-c', `printf %s ${cmd}`], { env: env({ SUB_HUMAN_HOME: home }), encoding: 'utf8' }).stdout;
  assert.equal(resolved, f);
  const dflt = spawnSync('/bin/sh', ['-c', `printf %s ${cmd}`], { env: { HOME: '/Users/x', PATH: process.env.PATH }, encoding: 'utf8' }).stdout;
  assert.equal(dflt, '/Users/x/.sub-human/bin/row-status');
  // End to end through the shell command, as Claude Code runs it (needs scripts/sub-human's dispatch, owner C).
  const out = spawnSync('/bin/sh', ['-c', cmd], {
    env: env({ SUB_HUMAN_HOME: home, NO_COLOR: '1' }), encoding: 'utf8',
    input: JSON.stringify({ session_id: 'sid-alice', tasks: [{ id: 'r1', type: 'local_agent', status: 'running', description: code }] }),
  });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout.trim(), JSON.stringify({ id: 'r1', content: `${code}  only you` }));
});

test('launcher: a temp-dir plugin root is refused unless allowed; stable roots run first, newest first, a deleted root is skipped', () => {
  const { home } = world(['claude']);
  const f = path.join(home, 'bin', 'row-status');
  const mkRoot = (base: string) => { fs.mkdirSync(path.join(base, 'scripts'), { recursive: true }); fs.writeFileSync(path.join(base, 'scripts', 'sub-human'), ''); return base; };
  const tmpRoot = mkRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'sh-root-')));
  // refused: nothing is written
  let r = launch({ CLAUDE_PLUGIN_ROOT: tmpRoot, SUB_HUMAN_ALLOW_TMP_ROOT: undefined });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stderr, '', 'refusing a temp root is no failure: hooks write nothing to stderr on success (0.6.0)');
  assert.ok(!fs.existsSync(f));
  assert.equal(launcher.isTempRoot(tmpRoot), true);
  assert.equal(launcher.isTempRoot(PLUGIN), false);
  // allowed (tests, the demo): it is recorded, but after any stable root
  r = launch({ CLAUDE_PLUGIN_ROOT: tmpRoot, SUB_HUMAN_ALLOW_TMP_ROOT: '1' });
  assert.equal(r.code, 0, r.stderr);
  launch({ CLAUDE_PLUGIN_ROOT: PLUGIN, SUB_HUMAN_ALLOW_TMP_ROOT: '1' });
  const body = fs.readFileSync(f, 'utf8');
  const at = (s: string) => body.indexOf(`exec node '${path.join(s, 'scripts', 'sub-human')}'`);
  assert.ok(at(PLUGIN) >= 0 && at(tmpRoot) > at(PLUGIN), body);
  // a session that does not allow temp roots drops them
  launch({ CLAUDE_PLUGIN_ROOT: PLUGIN, SUB_HUMAN_ALLOW_TMP_ROOT: undefined });
  assert.equal(fs.readFileSync(f, 'utf8').indexOf(tmpRoot), -1);
  // the launcher itself skips a root whose CLI is gone and prints nothing
  assert.equal(spawnSync('/bin/sh', [f], { encoding: 'utf8', env: { PATH: process.env.PATH } }).status, 0);
  const gone = launcher.launcherBody(['/nonexistent/root']);
  assert.equal(spawnSync('/bin/sh', ['-c', gone], { encoding: 'utf8' }).stdout, '');
  assert.equal(fs.statSync(path.join(home, 'bin')).mode & 0o777, 0o700);
});

test('the row hooks are the module\'s: hooks.json has no row PreToolUse, and no PostToolUse, SubagentStop or SessionStart entry', async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'hooks', 'hooks.json'), 'utf8')) as { hooks: Record<string, HookGroup[]> };
  for (const ev of ['PostToolUse', 'SubagentStop', 'SessionStart']) assert.equal(cfg.hooks[ev], undefined, ev);
  // the one PreToolUse command hook is the EnterPlanMode mode note (item 7), no row hook
  assert.deepEqual((cfg.hooks.PreToolUse || []).map(g => g.matcher), ['EnterPlanMode']);
  const { HOOKS: MOD } = await import(path.join(PLUGIN, 'mod', 'register.ts')) as { HOOKS: { event: string; matcher: string; file: string; does: string }[] };
  // the row is the module's: hidden from the model, spawned at a turn's start, its stop re-held; no Agent call hooks
  assert.ok(MOD.some(h => h.event === 'agent.offer' && h.file === 'mod/rows.ts'));
  assert.ok(MOD.some(h => h.event === 'classic.SubagentStop' && h.file === 'mod/rows.ts'));
  assert.ok(MOD.some(h => h.event === 'turn.start' && h.file === 'mod/deliver.ts' && /\$\.agent\.spawn/.test(h.does)));
  for (const ev of ['classic.PreToolUse', 'classic.PostToolUse']) assert.ok(!MOD.some(h => h.event === ev && h.file === 'mod/rows.ts'), ev);
  assert.ok(!fs.existsSync(path.join(PLUGIN, 'agents', 'participant.md')), 'no participant rows');
});

test('the room row agent: a stray typed message gets the one-line read-only reply, then hold again', () => {
  for (const f of ['room.md']) {
    const s = fs.readFileSync(path.join(PLUGIN, 'agents', f), 'utf8');
    assert.ok(s.includes('`read-only row — type in main with @room`'), f);
    assert.match(s, /SAME message you call `hold` again/, f);
  }
});

test('the room row agent: its description is at most 125 chars; no model key (it inherits the session model), background, the hold its only tool', () => {
  for (const f of ['room.md']) {
    const s = fs.readFileSync(path.join(PLUGIN, 'agents', f), 'utf8');
    const d = must(must(/^description: (.*)$/m.exec(s))[1]);
    assert.ok(Array.from(d).length <= 125, `${f}: ${d.length}`);
    assert.doesNotMatch(s, /^model:/m, `${f} prescribes no model`);
    assert.match(s, /^background: true$/m);
    assert.match(s, /^tools: mcp__plugin_sub-human_room__hold$/m);
  }
});
