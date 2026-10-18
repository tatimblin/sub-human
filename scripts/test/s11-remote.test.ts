// S11's check (scripts/checks/s11-remote.ts) over real evidence: two homes on this machine (the plugin's
// test/support/two-homes.ts), the real join, @room, card and session-end hooks, carol's link daemon over the pipe
// transport. What scripts/demo.sh S11 saves (state/S11/*) is made here the same way; the pane captures are stand-ins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as paths from '../lib/paths.ts';
import { runChecks, SCENES } from '../checks.ts';
import { context, DEMO } from '../checks/context.ts';
import { joinLineIn, pinIn, admitCardState } from '../lib/panes.ts';
import type { Proposal } from '../../plugin/sub-human/lib/types-app.ts';
import { must } from './must.ts';
import { parseJson } from '../lib/io.ts';

const { Machine } = paths.pluginTest('support/two-homes.ts');
const store = paths.pluginLib('room/store.ts');
const proposal = paths.pluginLib('proposal.ts');
const link = paths.pluginLib('remote/link-socket.ts');

const childOf = (pid: number): number | null => Number(spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).stdout.trim().split('\n')[0]) || null;
const kill = (pid: number | null | undefined): void => { try { if (pid != null) process.kill(pid, 'SIGKILL'); } catch { /* gone */ } };
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(fn: () => boolean, ms: number): Promise<boolean> { for (const end = Date.now() + ms; !fn() && Date.now() < end;) await new Promise(r => setTimeout(r, 50)); return fn(); }

test('panes: the line /sub-human invite showed and its PIN apart, also when the pane wrapped them; the host\'s join-request card', () => {
  const home = '/tmp/sh-demo/home';
  const S = '0v58jfh0vxfz8ggy5wbrnm40w1gzgtr5ene21zv';
  // without the hooks module (and `sub-human invite` in a terminal): the line and the PIN in the text
  const shown = `⏺ sub-human: invite to room vole-1234 for one machine, from another sub-human folder on this machine. It works once\n\n    /sub-human join pipe:${home.slice(0, 9)}\n    ${home.slice(9)} vole-1234 ${S.slice(0, 20)}\n    ${S.slice(20)}\n\n  and tell them its PIN apart from the line (say it, or send it another way):\n  4829\n  Their machine asks them for the PIN`;
  assert.equal(joinLineIn(shown), `join pipe:${home} vole-1234 ${S}`);
  assert.equal(pinIn(shown), '4829');
  // through the hooks module: both on the status line, whole, or cut (the line in the notice with SECRET in its place)
  const status = `⏺ sub-human: invite to room vole-1234 for one machine. Its PIN and the line to send them are pinned under the prompt\n\n  ⚠ sub-human: PIN 8238 · /sub-human join pipe:${home} vole-1234 ${S}`;
  assert.equal(joinLineIn(status), `join pipe:${home} vole-1234 ${S}`);
  assert.equal(pinIn(status), '8238');
  // (the module logs each notice line as its own row)
  const cut = `⏺ sub-human: invite to room vole-1234 for one machine. Send them this line with SECRET replaced by the word under the prompt:\n⏺   /sub-human join devbox vole-1234 SECRET --home ${home.slice(0, 7)}\n    ${home.slice(7)}\n⏺ and tell them the PIN apart from it\n\n  ⚠ sub-human: PIN 0412 · SECRET ${S}`;
  assert.equal(joinLineIn(cut), `join devbox vole-1234 ${S} --home ${home}`);
  assert.equal(pinIn(cut), '0412');
  assert.equal(joinLineIn(cut.replace(/⚠.*/, '')), null, 'the cut line without its word is no line');
  assert.equal(joinLineIn(`  /sub-human join dev@box vole-1234 ${S} --home /srv/sh\n`), `join dev@box vole-1234 ${S} --home /srv/sh`);
  assert.equal(joinLineIn(`  /sub-human join https://box.ts.net/sub-human/vole-1234 ${S}\n`), `join https://box.ts.net/sub-human/vole-1234 ${S}`);
  assert.equal(joinLineIn(`  /sub-human join https://box.ts.net/sub-human/vole-1234#${S}\n`), `join https://box.ts.net/sub-human/vole-1234#${S}`, 'the SECRET as the URL\'s fragment');
  assert.equal(joinLineIn(`⏺   /sub-human join https://box.ts.net/sub-human/vole-1234#SECRET\n\n  ⚠ sub-human: PIN 0412 · SECRET ${S}`), `join https://box.ts.net/sub-human/vole-1234#${S}`, 'and cut');
  assert.equal(joinLineIn('no line here'), null);
  assert.equal(joinLineIn('/sub-human join dev vole-1234 4829'), null, 'a 0.5.0-beta.15 line is no invite line now');
  assert.equal(pinIn('no PIN here 4829'), null);
  const card = 'Let carol (check 3f9c-2a71) on carols-mbp join room vole-1234? (admit 3f9c2a0b1c2d)\n❯ 1. Let in\n  2. Refuse\n  3. Type something';
  assert.deepEqual(admitCardState(card)?.opts.map(o => [o.n, o.label, o.cur]), [[1, 'Let in', true], [2, 'Refuse', false], [3, 'Type something', false]]);
  assert.equal(admitCardState('Agree to proposal abcdefabcdef?\n❯ 1. Agree'), null);
});

// The invite as the plugin draws it now, read back by the demo's parsers: the host's /sub-human invite through the
// hooks module (mod/core/command.ts readReply + answerOf: the notices and the status line, whole in a wide terminal,
// cut in a narrow one) and without it (the text). The cut pane's line and PIN then get a second home in.
test('panes: the invite the plugin renders (status line whole and cut, and the text) reads back to a line and PIN that join', async t => {
  const command = paths.pluginFile('mod/core/command.ts');
  const env = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-s11-claude-'));
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  const host = new Machine(t, 'host'), remote = new Machine(t, 'remote', { SUB_HUMAN_LINK_IDLE_MS: '3000' });
  const alice = host.seat('alice'), carol = remote.seat('carol');
  host.join(alice, 'alice');
  const code = must(host.lib(() => store.listRooms()[0]), 'the room');
  t.after(() => {
    const d = remote.lib(() => link.status(code));
    if (d && typeof d.pid === 'number') { kill(childOf(d.pid)); kill(d.pid); }
    fs.rmSync(path.dirname(link.socketPath(path.join(remote.home, 'rooms', code))), { recursive: true, force: true });
    fs.rmSync(claudeDir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  // the module's command.run: the lease's nonce attests it, and the reply is the module's (lines + pinned)
  host.lease(alice);
  const run = host.hook('join', { hook_event_name: 'UserPromptExpansion', command_name: 'sub-human', command_args: 'invite --pipe', sub_human_via: 'command.run', sub_human_nonce: alice.nonce }, alice);
  const reply = command.readReply({ exitCode: run.status ?? 1, stdout: run.stdout, stderr: run.stderr });
  const paneAt = (columns: number): string => {
    const a = command.answerOf(reply, { columns });
    assert.ok(a.status, `the invite is pinned on the status line: ${run.stdout} ${run.stderr}`);
    return `❯ /sub-human invite --pipe\n${a.logs.map(l => `⏺ ${l}`).join('\n')}\n\n────\n❯ \n────\n  ⚠ sub-human: ${a.status.status}\n`;
  };
  const wide = paneAt(400), narrow = paneAt(40);
  assert.ok(wide.includes('PIN ') && narrow.includes('· SECRET '), 'the whole line in a wide terminal, PIN and SECRET in a narrow one');
  const line = joinLineIn(wide), pin = pinIn(wide);
  assert.match(line ?? '', new RegExp(`^join pipe:\\S+ ${code} [0-9a-z]{39}$`), wide);
  assert.match(pin ?? '', /^\d{4}$/, wide);
  assert.equal(joinLineIn(narrow), line, `the cut form reads back to the same line: ${narrow}`);
  assert.equal(pinIn(narrow), pin);
  assert.equal(pinIn(wide.replace(/⚠.*/, '')), null, 'the notices alone hold no PIN');
  // the classic text (no module, and `sub-human invite` in a terminal) of a second invite reads the same way
  const classic = host.join(alice, 'invite --pipe').json?.reason;
  assert.ok(typeof classic === 'string');
  assert.match(joinLineIn(classic) ?? '', new RegExp(`^join pipe:\\S+ ${code} [0-9a-z]{39}$`));
  assert.match(pinIn(classic) ?? '', /^\d{4}$/);
  // what the demo's driver reads off the narrow pane gets carol in
  const via = await remote.joinVia(host, alice, carol, { line: must(joinLineIn(narrow), 'the line'), pin: must(pinIn(narrow), 'the PIN') });
  assert.equal(via.seated.json?.decision, undefined, JSON.stringify(via.seated.json));
});

test('S11: carol from a second home passes every check over real evidence; a broken mirror, a leaked file or an invite left in the link file fail', async t => {
  const env = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, SUB_HUMAN_HOME: process.env.SUB_HUMAN_HOME };
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-s11-claude-'));
  process.env.CLAUDE_CONFIG_DIR = claudeDir; // no real transcripts
  const host = new Machine(t, 'host'), remote = new Machine(t, 'remote', { SUB_HUMAN_LINK_IDLE_MS: '3000' }); // short, so the daemon exits once carol leaves; not so short that a loaded run's daemon idles out between the host's Let in and her /sub-human
  const alice = host.seat('alice'), bob = host.seat('bob'), carol = remote.seat('carol');
  host.join(alice, 'alice');
  const code = must(host.lib(() => store.listRooms()[0]), 'the room');
  host.join(bob, `bob ${code}`);
  const via = await remote.joinVia(host, alice, carol, { knock: true }); // as S11: the line alone, alice's card lets her in
  const shown = via.shown?.json?.reason;
  assert.ok(typeof shown === 'string', 'the invite showed');
  const joined = via.seated.json;
  assert.ok(joined, 'the join answered');
  assert.equal(joined.decision, undefined, JSON.stringify(joined));
  assert.equal(joined.systemMessage, undefined, 'a join that works prints no line');
  const daemon = remote.lib(() => link.status(code));
  assert.ok(daemon && typeof daemon.pid === 'number', 'the link daemon runs');
  const pid = daemon.pid;
  t.after(() => {
    kill(childOf(pid)); kill(pid);
    fs.rmSync(path.dirname(link.socketPath(path.join(remote.home, 'rooms', code))), { recursive: true, force: true });
    fs.rmSync(claudeDir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  const said = remote.say(carol, DEMO.carol11);
  assert.equal(said.json?.continue, false, `${JSON.stringify(said.json)} ${said.stderr}`);
  await remote.tail(carol, 1); // her delivery cursor (deliver-carol), as her session's tail child keeps
  const p = host.lib(() => paths.pluginTest('support/plan.ts').propose({ code, name: paths.seatName('alice') }, { text: '# Carol reviews the parser tests\n', approvers: ['carol'], plan: 'review' }));
  assert.ok(await until(() => fs.existsSync(path.join(remote.home, 'rooms', code, 'plans', `${p.hash}.md`)), 5000));
  const card = remote.lib(() => proposal.card({ hash: p.hash, approvers: ['carol'] } as Proposal, code) /* the card reads only these */);
  remote.hook('consent', { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_input: {}, tool_response: { ...card, answers: { [`Agree to proposal ${p.hash}?`]: 'Agree' } } }, carol);

  // what demo.sh saves at the end of S11, and the captures it snaps
  const screens = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-s11-screens-'));
  t.after(() => fs.rmSync(screens, { recursive: true, force: true }));
  const st = path.join(screens, 'state', 'S11');
  fs.mkdirSync(st, { recursive: true });
  fs.copyFileSync(path.join(remote.home, 'rooms', code, 'log.jsonl'), path.join(st, 'mirror-log.jsonl'));
  fs.copyFileSync(path.join(remote.home, 'machine.json'), path.join(st, 'machine-carol.json'));
  fs.copyFileSync(path.join(remote.home, 'machines.json'), path.join(st, 'machines-carol.json'));
  fs.copyFileSync(path.join(host.home, 'machine.json'), path.join(st, 'machine-host.json'));
  const linkFile = path.join(remote.home, 'links', `${code}.json`);
  const shape = (l: { token?: unknown, transport?: unknown }) => ({ mode: (fs.statSync(linkFile).mode & 0o777).toString(8), token: typeof l.token === 'string', invite: 'invite' in l, transport: l.transport });
  fs.writeFileSync(path.join(st, 'link-file.json'), JSON.stringify(shape(parseJson<{ token?: unknown, transport?: unknown }>(fs.readFileSync(linkFile, 'utf8')))));
  const at = new Date().toISOString();
  // her pane once the module took the seat (a stand-in)
  fs.writeFileSync(path.join(st, 'take-carol.txt'), `⏺ sub-human: joined ${code} as carol\n❯ You're in room ${code} as carol (check 3f9c-2a71, as the host's room line shows)\n`);
  const caps: [string, number, string][] = [['alice', 1, shown], ['alice', 2, `⏺ carol: ${DEMO.carol11}`], ['carol', 1, `❯ /sub-human\n  ⎿ joined ${code} as carol`]];
  fs.writeFileSync(path.join(screens, 'index.json'), JSON.stringify(caps.map(([seat, step]) => ({ scene: 'S11', session: `sh-${seat}`, step, time: at, txt: `S11-${step}-${seat}.txt`, room: code }))));
  for (const [seat, step, text] of caps) fs.writeFileSync(path.join(screens, `S11-${step}-${seat}.txt`), text);

  // carol's session ends; her daemon stops on its own (no seat of her home is left)
  remote.hook('session-end', { hook_event_name: 'SessionEnd', reason: 'logout' }, carol);
  assert.ok(await until(() => !alive(pid), 8000), 'the daemon exits');

  const mod = SCENES.find(m => m.scene === 'S11');
  assert.ok(mod);
  const run = () => must(runChecks(context({ screens, home: host.home, room: code, home2: remote.home }), { scenes: [mod] }).S11, 'the S11 results');
  const res = run();
  assert.deepEqual(res.filter(c => !c.pass).map(c => `${c.check}: ${c.evidence}`), []);
  assert.equal(res.length, 14);
  assert.ok(res.every(c => c.kind === 'deterministic'));

  const fails = () => run().filter(c => !c.pass).map(c => c.check.split(':')[0]);
  fs.appendFileSync(path.join(st, 'mirror-log.jsonl'), '{"id":999}\n');
  assert.deepEqual(fails(), ['carol\'s mirror is the host\'s log byte for byte, through the decision (her copy at the end of the scene)']);
  fs.copyFileSync(path.join(remote.home, 'rooms', code, 'log.jsonl'), path.join(st, 'mirror-log.jsonl'));
  fs.writeFileSync(path.join(host.home, 'rooms', code, 'carol.cursor'), '1');
  fs.writeFileSync(path.join(st, 'link-file.json'), JSON.stringify({ ...shape({ token: 't', transport: { kind: 'pipe' } }), invite: true }));
  assert.deepEqual(fails(), ['carol\'s link file is private (0600) and holds a token, no longer the invite', 'Nothing session-local of carol\'s on the host (rows, cursors, review state stay in her home)']);
});
