// lib/commands: the /sub-human command table, verb by verb, in process (the hook's payload-level tests are
// test/hooks/join.node-test.ts). Each case runs in a temp home with a lease for this process as the claude process.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { World } from './hooks/helpers.ts';
import * as commands from '../lib/commands/index.ts';
import * as joinMod from '../lib/commands/join.ts';
import * as seats from '../lib/seats.ts';
import * as identity from '../lib/identity.ts';
import * as seatKey from '../hooks/seat-key.ts';
import { HELP } from '../lib/commands/help.ts';
import { failure } from '../lib/commands/answer.ts';
import type { Answer } from '../lib/commands/types.ts';
import type { Identity } from '../lib/identity.ts';
import { sn } from './support/brands.ts';
import { must } from './support/must.ts';

const PLUGIN = new URL('..', import.meta.url).pathname;
// never start a room's Claude from a test
seats.seam.startDetached = () => {};

/** run(args) as a session of w: the lease written unless lease is false; seat: who this session is (or null). */
function run(w: World, args: string, { seat = null, lease = true, pid = process.pid, roomClaudeAgent = false }: { seat?: string | null; lease?: boolean; pid?: number | null; roomClaudeAgent?: boolean } = {}): Answer {
  const sid = seat ? w.sid[seat] : crypto.randomUUID();
  return w.lib(() => {
    if (lease) identity.writeModLease(sid, { pid: process.pid });
    const cur: Identity | null = seat ? identity.resolveBySession(sid) : null;
    return commands.run(args.split(/\s+/).filter(Boolean), { sid, cwd: w.cwd, pid, roomClaudeAgent, pubkey: seatKey.publicPem, pluginRoot: PLUGIN, seat: () => cur });
  });
}
const text = (a: Answer) => (a.kind === 'joined' ? a.say : a.text);

test('commands (quiet): a lock that did not hold is one plain line, its path the debug log\'s; the hidden rule keeps the detail', () => {
  const lock = new Error('could not acquire /Users/me/.sub-human/rooms/vole-1234/invites.lock');
  assert.deepEqual(failure(lock, lock.message), { kind: 'refused', text: 'Room busy. Try again.', debug: lock.message });
  assert.deepEqual(failure(new Error('x'), 'room vole-1234 is hosted elsewhere'), { kind: 'refused', text: 'room vole-1234 is hosted elsewhere' });
  assert.deepEqual(commands.hide(['invite'], failure(lock, lock.message)), { kind: 'secret', text: 'Room busy. Try again.', refused: true, debug: lock.message });
  assert.equal(HELP.split('\n').length, 6, 'help is six lines');
});

test('commands: the table names every verb; help and doctor are the open ones', () => {
  assert.deepEqual(Object.keys(commands.TABLE).sort(), ['', 'admit', 'invite', 'join', 'kick', 'leave']);
  assert.deepEqual(Object.keys(commands.OPEN).sort(), ['doctor', 'help']);
  for (const v of [...Object.keys(commands.TABLE), ...Object.keys(commands.OPEN)].filter(Boolean)) assert.ok(identity.RESERVED.includes(v), `${v} is no name`);
});

test('commands: help (any words after it) and doctor run without the lease; every other verb needs it', t => {
  const w = new World({}, { t, room: false });
  assert.deepEqual(run(w, 'help', { lease: false }), { kind: 'say', text: HELP });
  assert.deepEqual(run(w, 'help join please', { lease: false }), { kind: 'say', text: HELP });
  const fix = run(w, 'doctor --fix', { lease: false });
  assert.equal(fix.kind, 'refused');
  assert.match(text(fix), /--fix changes or writes files, so it runs in a terminal outside Claude Code: SUB_HUMAN_HOME=\S+ node \S+\/scripts\/sub-human doctor --fix/);
  assert.match(text(run(w, 'doctor now', { lease: false })), /usage: \/sub-human doctor/);
  for (const args of ['', 'leave', 'kick bob', 'alice']) {
    const a = run(w, args, { lease: false });
    assert.equal(a.kind, 'refused', args);
    assert.match(text(a), /hooks module|Claude Code \d/, args);
  }
  assert.match(text(run(w, 'leave', { pid: null })), /could not tell which Claude Code session this is/);
});

test('commands: the hidden rule is the router\'s: join, invite, admit or a word of digits makes every say and refusal a secret', t => {
  const w = new World({ alice: 'sleep' }, { t });
  assert.deepEqual(run(w, 'leave'), { kind: 'refused', text: 'Not in a room. Run /sub-human to join.' });
  assert.deepEqual(run(w, 'leave 4829'), { kind: 'secret', text: 'Usage: /sub-human leave', refused: true });
  for (const args of ['join', 'invite', 'admit', 'admit 4829', 'kick 123456']) assert.equal(run(w, args).kind, 'secret', args);
  const admit = run(w, 'admit', { seat: 'alice' });
  assert.deepEqual(admit, { kind: 'secret', text: `nobody is waiting to join room ${w.code}.`, refused: false }, 'not a refusal, still hidden');
  // hide() on its own: a seat a prompt with a PIN-shaped word took is not handed to the model in that step
  const me: Identity = { code: w.code, name: sn('alice'), role: 'member', session_id: null, pid: null, address: `alice.${w.code}` };
  const joined: Answer = { kind: 'joined', me, lead: 'joined', say: `joined ${w.code} as alice` };
  assert.equal(commands.hide(['join', 'dev', w.code], joined), joined, 'a login join has no PIN: the seat goes to the model');
  assert.deepEqual(commands.hide(['join', 'dev', w.code, '--home', '2222'], joined), { kind: 'secret', text: `joined ${w.code} as alice · type /sub-human to bring the room to your Claude`, refused: false });
  // a web line with its SECRET as the URL's fragment and the PIN after it: whatever it answers, hidden
  const line = ['join', `https://box.ts.net/sub-human/${w.code}#${'k'.repeat(39)}`, '4829'];
  assert.equal(commands.hide(line, joined).kind, 'secret');
  assert.equal(commands.hide(line.slice(0, 2), joined).kind, 'secret', 'the line alone too');
  assert.deepEqual(commands.hide(line, { kind: 'say', text: 'x' }), { kind: 'secret', text: 'x', refused: false });
  // the one line shape over ssh (0.6.1): hidden the same, whatever it answers, typed with join or without
  for (const ssh of [`ssh://me@devbox/${w.code}#${'k'.repeat(39)}`, `ssh://devbox/${w.code}?forward=7420#${'k'.repeat(39)}`]) {
    assert.equal(commands.hide(['join', ssh, '4829'], joined).kind, 'secret', ssh);
    assert.equal(commands.hide([ssh], joined).kind, 'secret', `${ssh} alone`);
    assert.deepEqual(commands.hide([ssh], { kind: 'refused', text: 'x' }), { kind: 'secret', text: 'x', refused: true });
  }
  assert.deepEqual(commands.hide(['help'], { kind: 'say', text: 'x' }), { kind: 'say', text: 'x' });
});

test('commands: leave, kick, admit and invite; handoff is no verb (a reserved name)', t => {
  const w = new World({ alice: 'sleep', bob: 'sleep' }, { t });
  for (const v of ['kick bob', 'invite --pipe', 'admit']) assert.match(text(run(w, v)), /join a room first/, v);
  assert.match(text(run(w, 'kick alice', { seat: 'alice' })), /that is you; \/sub-human leave leaves the room/);
  assert.match(text(run(w, 'kick', { seat: 'alice' })), /usage: \/sub-human kick NAME/);
  assert.match(text(run(w, 'kick carol', { seat: 'alice' })), /nobody called "carol" joined room/);
  const inv = run(w, 'invite --pipe', { seat: 'alice' });
  assert.ok(inv.kind === 'secret', inv.kind);
  assert.equal(inv.refused, false, 'an invite is no refusal');
  assert.match(text(inv), new RegExp(`/sub-human join pipe:\\S+/${w.code}#[0-9a-z]{39}\n`));
  assert.match(text(inv), /its PIN apart from the line \(say it, or send it another way\): \d{4}$/);
  assert.match(text(run(w, 'invite --pipe --web', { seat: 'alice' })), /pick one way at a time/);
  assert.match(text(run(w, 'admit zz', { seat: 'alice' })), /usage: \/sub-human admit/);
  assert.equal(run(w, 'handoff bob', { seat: 'alice' }).kind, 'refused', 'a reserved word, never a name');
  assert.match(text(run(w, 'leave now', { seat: 'alice' })), /^Usage: \/sub-human leave$/);
  assert.deepEqual(run(w, 'leave', { seat: 'bob' }), { kind: 'say', text: `Left ${w.code}` });
  assert.ok(must(w.members().bob).left_at);
});

test('commands: NAME [ROOM], ROOM, join ROOM and the bare command take a seat; a word of digits is no name', t => {
  const w = new World({ alice: 'sleep' }, { t });
  w.sid.bob = crypto.randomUUID();
  const sid = w.sid.bob;
  const as = (args: string) => w.lib(() => {
    identity.writeModLease(sid, { pid: process.pid });
    return commands.run(args.split(' ').filter(Boolean), { sid, cwd: w.cwd, pid: process.pid, roomClaudeAgent: false, pubkey: seatKey.publicPem, pluginRoot: PLUGIN, seat: () => identity.resolveBySession(sid) });
  });
  assert.match(text(as('b@d')), /"b@d" isn't a command or a name/);
  assert.match(text(as('bob otter')), /"otter" isn't a room/);
  assert.match(text(as('a b c')), /^usage: \/sub-human \[NAME\]/);
  assert.deepEqual(as('4829'), { kind: 'secret', text: '"4829" looks like a PIN, not a name: a PIN goes in as /sub-human join PIN once an invite line asks for it', refused: true });
  const j = as(`join ${w.code} --as bob`);
  assert.equal(j.kind, 'joined', text(j));
  assert.equal(text(j), `Joined ${w.code} as bob with alice`, 'one line: no teaching suffix');
  const again = as('');
  assert.equal(again.kind, 'say', 'seated: the bare command is the status');
  assert.match(text(again), new RegExp(`^you're bob in room ${w.code}, with alice · another machine: /sub-human invite · leave: /sub-human leave`));
  assert.equal(as(`bob ${w.code}`).kind, 'joined', 'the same seat again: already joined');
});

test('commands: a CLI command (/sub-human tasks) says where it runs and takes no seat by that name; --as still can', t => {
  const w = new World({ alice: 'sleep', bob: 'sleep' }, { t });
  const before = w.entries().length;
  for (const args of ['tasks', 'Who', 'show abc123', `plan ${w.code}`]) {
    for (const seat of args === 'Who' ? [null] : [null, 'alice']) { // in a room, /sub-human who lists its people (below)
      const a = run(w, args, { seat });
      const verb = must(args.split(' ')[0]).toLowerCase();
      assert.equal(a.kind, 'say', `${args} as ${seat}`);
      assert.equal(text(a), `${verb} is a sub-human CLI command, not a /sub-human one: ask your Claude (it reads the room), or in a terminal: node ${PLUGIN.replace(/\/+$/, '')}/scripts/sub-human ${verb} · to sit as someone called ${verb}: /sub-human --as ${verb}`);
    }
  }
  assert.match(text(run(w, 'listen', { seat: 'alice' })), /^listen is a sub-human CLI command, not a \/sub-human one: in a terminal: node \S+\/scripts\/sub-human listen · /);
  assert.equal(must(w.lib(() => identity.resolveBySession(w.sid.alice))).name, 'alice', 'still alice');
  assert.equal(w.entries().length, before, 'nothing logged: no join, no leave');
  // not reserved: a seat already called tasks (an older version let it) can still join, and --as takes the name
  assert.ok(!identity.RESERVED.includes('tasks'));
  const as = run(w, '--as tasks', { seat: 'bob' });
  assert.equal(as.kind, 'joined', text(as));
  assert.match(text(as), new RegExp(`^Joined ${w.code} as tasks`));
});

test('commands: /sub-human who in a room lists its people, one line each, and takes no seat', t => {
  const w = new World({ alice: 'sleep', bob: 'sleep' }, { t });
  const before = w.entries().length;
  const a = run(w, 'who', { seat: 'alice' });
  assert.equal(a.kind, 'say', text(a));
  assert.deepEqual(text(a).split('\n').sort(), [`alice (member) in ${w.code}`, `bob (member) in ${w.code}`]);
  assert.match(text(run(w, 'Who', { seat: 'bob' })), new RegExp(`^alice \\(member\\) in ${w.code}`, 'm'));
  assert.equal(w.entries().length, before, 'nothing logged');
  assert.equal(must(w.lib(() => identity.resolveBySession(w.sid.alice))).name, 'alice', 'still alice');
});

test('commands: every CLI command is a /sub-human verb (reserved) or a CLI verb (/sub-human answers where it runs)', async () => {
  const { COMMANDS } = await import('../lib/cli/main.ts');
  const { CLI_VERBS } = await import('../lib/commands/join.ts');
  for (const c of COMMANDS) assert.ok(identity.VERBS.includes(c) !== CLI_VERBS.includes(c), `${c}: in exactly one list`);
  for (const c of CLI_VERBS) assert.ok(COMMANDS.includes(c), `${c} is no CLI command`);
});

test('commands: the room\'s Claude agent session binds its seat and takes no other command; a room Claude seat is refused', t => {
  const w = new World({ alice: 'sleep', claude: 'sleep' }, { t });
  assert.match(text(run(w, 'bob', { roomClaudeAgent: true })), /this session runs the room's Claude agent/);
  assert.match(text(run(w, 'leave', { seat: 'claude' })), new RegExp(`this session is the room's Claude of room ${w.code}; join from another session`));
});

test('join line: one shape for every transport (lineParts): the scheme, what is before the path, the room as its last segment, the query, the SECRET as the fragment', () => {
  const S = 'k'.repeat(39);
  const parts = (s: string) => { const l = joinMod.lineParts(s); return l && { ...l, query: Object.fromEntries(l.query) }; };
  assert.deepEqual(parts(`ssh://me@devbox/vole-1234#${S}`), { scheme: 'ssh', where: 'me@devbox', path: '/vole-1234', code: 'vole-1234', query: {}, word: S });
  assert.deepEqual(parts(`ssh://devbox:2222/vole-1234?home=/srv/sh#${S}`), { scheme: 'ssh', where: 'devbox:2222', path: '/vole-1234', code: 'vole-1234', query: { home: '/srv/sh' }, word: S });
  assert.deepEqual(parts(`ssh://devbox/vole-1234?forward=7420#${S}`)?.query, { forward: '7420' });
  assert.deepEqual(parts(`https://box.ts.net/sub-human/vole-1234#${S}`), { scheme: 'https', where: 'box.ts.net', path: '/sub-human/vole-1234', code: 'vole-1234', query: {}, word: S });
  assert.deepEqual(parts(`pipe:/tmp/h2/vole-1234#${S}`), { scheme: 'pipe', where: '', path: '/tmp/h2/vole-1234', code: 'vole-1234', query: {}, word: S });
  assert.equal(parts('ssh://me@devbox/vole-1234')?.word, null, 'no fragment: no SECRET (a login join over ssh)');
  assert.equal(parts(`ssh://devbox/vole-1234?forward=1&forward=2#${S}`), null, 'a key twice');
  for (const bad of ['devbox', 'ssh:/devbox/vole-1234', 'ftp://devbox/vole-1234', `ssh://devbox/vole-1234#${S} x`, 'pipe:relative/vole-1234']) assert.equal(parts(bad), null, bad);
});

test('join line: what is wrong with one is said hidden, never echoing its SECRET', t => {
  const w = new World({ alice: 'sleep' }, { t });
  const S = 'k'.repeat(39);
  const cases: [string, RegExp][] = [
    [`join ssh://devbox/x/${w.code}#${S}`, /isn't a whole join line/],
    [`join ssh://devbox/not-a-room#${S}`, /isn't a whole join line/],
    [`join ssh://devbox/${w.code}?via=x#${S}`, /"via" isn't part of a join line/],
    [`join ssh://devbox/${w.code}?home=/a#${S} --home /b`, /names the host's sub-human folder already/],
    [`join ssh://devbox/${w.code}?home=relative#${S}`, /isn't a plain absolute path/],
    [`join ssh://YOU@devbox/${w.code}#${S}`, /placeholder/],
    [`join ssh://devbox/${w.code}#${S.slice(4)}`, /did not come through whole/],
    [`join ssh://devbox/${w.code}#${S} 4829 extra`, /usage: \/sub-human join LINE PIN/],
    [`join ssh://devbox/${w.code} 4829`, /did not come through whole/],
    [`join pipe:/tmp/none/${w.code}`, new RegExp(`without its SECRET: /sub-human join pipe:/tmp/none/${w.code}#SECRET`)],
    [`join pipe:/tmp/none/${w.code}?x=1#${S}`, /isn't a whole join line/],
  ];
  for (const [args, re] of cases) {
    const a = run(w, args);
    assert.equal(a.kind, 'secret', args);
    assert.match(text(a), re, args);
    assert.ok(!text(a).includes(S), `${args}: no SECRET in the answer`);
  }
});
