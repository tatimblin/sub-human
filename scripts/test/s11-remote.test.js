'use strict';
// S11's check (scripts/checks/s11-remote.js) over real evidence: two homes on this machine (the plugin's
// test/support/two-homes.ts), the real join, @room, card and session-end hooks, carol's link daemon over the pipe
// transport. What scripts/demo.sh S11 saves (state/S11/*) is made here the same way; the pane captures are stand-ins.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const paths = require('../lib/paths.js');
const { runChecks, SCENES } = require('../checks.js');
const { context, DEMO } = require('../checks/context.js');
const { joinLineIn, admitCardState } = require('../lib/panes.js');

const { Machine } = paths.pluginTest('support/two-homes.ts');
const store = paths.pluginLib('room/store.ts');
const proposal = paths.pluginLib('proposal.ts');
const link = paths.pluginLib('remote/link.ts');

const childOf = pid => Number(spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).stdout.trim().split('\n')[0]) || null;
const kill = pid => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(fn, ms) { for (const end = Date.now() + ms; !fn() && Date.now() < end;) await new Promise(r => setTimeout(r, 50)); return fn(); }

test('panes: the line /sub-human invite showed, also when the pane wrapped it; the host\'s join-request card', () => {
  const home = '/tmp/sh-demo/home';
  const shown = `⏺ sub-human: invite to room vole-1234, for one machine, (a second home on this machine). Shown once\n\n    /sub-human join pipe:${home.slice(0, 9)}\n    ${home.slice(9)} vole-1234 4829\n\n  The 4-digit PIN is the whole secret`;
  assert.equal(joinLineIn(shown), `join pipe:${home} vole-1234 4829`);
  assert.equal(joinLineIn('  /sub-human join dev@box vole-1234 0042 --via jump\n'), 'join dev@box vole-1234 0042 --via jump');
  assert.equal(joinLineIn('  /sub-human join https://box.ts.net/sub-human/vole-1234 1234\n'), 'join https://box.ts.net/sub-human/vole-1234 1234');
  assert.equal(joinLineIn('no line here'), null);
  assert.equal(joinLineIn('/sub-human join dev vole-1234 48291'), null, 'four digits only');
  const card = 'Let carol (request 3f9c2a) on carols-mbp join room vole-1234? (admit 3f9c2a0b1c2d)\n❯ 1. Let in\n  2. Refuse\n  3. Type something';
  assert.deepEqual(admitCardState(card).opts.map(o => [o.n, o.label, o.cur]), [[1, 'Let in', true], [2, 'Refuse', false], [3, 'Type something', false]]);
  assert.equal(admitCardState('Agree to proposal abcdefabcdef?\n❯ 1. Agree'), null);
});

test('S11: carol from a second home passes every check over real evidence; a broken mirror, a leaked file or an invite left in the link file fail', async t => {
  const env = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, SUB_HUMAN_HOME: process.env.SUB_HUMAN_HOME };
  process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-s11-claude-')); // no real transcripts
  const host = new Machine(t, 'host'), remote = new Machine(t, 'remote', { SUB_HUMAN_LINK_IDLE_MS: '1000' });
  const alice = host.seat('alice'), bob = host.seat('bob'), carol = remote.seat('carol');
  host.join(alice, 'alice');
  const code = host.lib(() => store.listRooms()[0]);
  host.join(bob, `bob ${code}`);
  const via = await remote.joinVia(host, alice, carol);
  const shown = via.shown.json.reason;
  const joined = via.seated.json;
  assert.equal(joined.systemMessage, undefined, 'a join that works prints no line');
  const daemon = remote.lib(() => link.status(code));
  t.after(() => {
    kill(childOf(daemon.pid)); kill(daemon.pid);
    fs.rmSync(path.dirname(link.socketPath(path.join(remote.home, 'rooms', code))), { recursive: true, force: true });
    fs.rmSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true, force: true });
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  const said = remote.say(carol, DEMO.carol11);
  assert.equal(said.json.continue, false, `${JSON.stringify(said.json)} ${said.stderr}`);
  await remote.tail(carol, 1); // her delivery cursor (deliver-carol), as her session's tail child keeps
  const p = host.lib(() => proposal.create({ code, name: 'alice', role: 'member' }, { text: '# Carol reviews the parser tests\n', approvers: ['carol'] }));
  assert.ok(await until(() => fs.existsSync(path.join(remote.home, 'rooms', code, 'plans', `${p.hash}.md`)), 5000));
  const card = remote.lib(() => proposal.card({ hash: p.hash, approvers: ['carol'] }, code));
  remote.hook('consent', { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_input: {}, tool_response: { ...card, answers: { [`Agree to proposal ${p.hash}?`]: 'Agree' } } }, carol);

  // what demo.sh saves at the end of S11, and the captures it snaps
  const screens = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-s11-screens-'));
  t.after(() => fs.rmSync(screens, { recursive: true, force: true }));
  const st = path.join(screens, 'state', 'S11');
  fs.mkdirSync(st, { recursive: true });
  fs.copyFileSync(path.join(remote.home, 'rooms', code, 'log.jsonl'), path.join(st, 'mirror-log.jsonl'));
  fs.copyFileSync(path.join(remote.home, 'machine.json'), path.join(st, 'machine-carol.json'));
  fs.copyFileSync(path.join(host.home, 'machine.json'), path.join(st, 'machine-host.json'));
  const linkFile = path.join(remote.home, 'links', `${code}.json`);
  const shape = l => ({ mode: (fs.statSync(linkFile).mode & 0o777).toString(8), token: typeof l.token === 'string', invite: 'invite' in l, transport: l.transport });
  fs.writeFileSync(path.join(st, 'link-file.json'), JSON.stringify(shape(JSON.parse(fs.readFileSync(linkFile, 'utf8')))));
  const at = new Date().toISOString();
  const caps = [['alice', 1, shown], ['alice', 2, `⏺ carol: ${DEMO.carol11}`], ['carol', 1, `❯ /sub-human\n  ⎿ joined ${code} as carol`]];
  fs.writeFileSync(path.join(screens, 'index.json'), JSON.stringify(caps.map(([seat, step]) => ({ scene: 'S11', session: `sh-${seat}`, step, time: at, txt: `S11-${step}-${seat}.txt`, room: code }))));
  for (const [seat, step, text] of caps) fs.writeFileSync(path.join(screens, `S11-${step}-${seat}.txt`), text);

  // carol's session ends; her daemon stops on its own (no seat of her home is left)
  remote.hook('session-end', { hook_event_name: 'SessionEnd', reason: 'logout' }, carol);
  assert.ok(await until(() => !alive(daemon.pid), 8000), 'the daemon exits');

  const mod = SCENES.find(m => m.scene === 'S11');
  const run = () => runChecks(context({ screens, home: host.home, room: code, home2: remote.home }), { scenes: [mod] }).S11;
  const res = run();
  assert.deepEqual(res.filter(c => !c.pass).map(c => `${c.check}: ${c.evidence}`), []);
  assert.equal(res.length, 12);
  assert.ok(res.every(c => c.kind === 'deterministic'));

  const fails = () => run().filter(c => !c.pass).map(c => c.check.split(':')[0]);
  fs.appendFileSync(path.join(st, 'mirror-log.jsonl'), '{"id":999}\n');
  assert.deepEqual(fails(), ['carol\'s mirror is the host\'s log byte for byte, through the decision (her copy at the end of the scene)']);
  fs.copyFileSync(path.join(remote.home, 'rooms', code, 'log.jsonl'), path.join(st, 'mirror-log.jsonl'));
  fs.writeFileSync(path.join(host.home, 'rooms', code, 'carol.cursor'), '1');
  fs.writeFileSync(path.join(st, 'link-file.json'), JSON.stringify({ ...shape({ token: 't', transport: { kind: 'pipe' } }), invite: true }));
  assert.deepEqual(fails(), ['carol\'s link file is private (0600) and holds a token, no longer the invite', 'Nothing session-local of carol\'s on the host (rows, cursors, review state stay in her home)']);
});
