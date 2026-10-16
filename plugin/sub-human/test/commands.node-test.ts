// lib/commands: the /sub-human command table, verb by verb, in process (the hook's payload-level tests are
// test/hooks/join.node-test.ts). Each case runs in a temp home with a lease for this process as the claude process.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { World } from './hooks/helpers.ts';
import * as commands from '../lib/commands/index.ts';
import * as seats from '../lib/seats.ts';
import * as identity from '../lib/identity.ts';
import * as seatKey from '../hooks/seat-key.ts';
import { HELP } from '../lib/commands/help.ts';
import type { Answer } from '../lib/commands/types.ts';
import type { Identity } from '../lib/identity.ts';
import { sn } from './support/brands.ts';

const PLUGIN = new URL('..', import.meta.url).pathname;
// never start a room's Claude from a test
seats.seam.startDetached = () => {};

/** run(args) as a session of w: the lease written unless lease is false; seat: who this session is (or null). */
function run(w: World, args: string, { seat = null as string | null, lease = true, pid = process.pid as number | null, roomClaudeAgent = false } = {}): Answer {
  const sid = seat ? w.sid[seat] : crypto.randomUUID();
  return w.lib(() => {
    if (lease) identity.writeModLease(sid, { pid: process.pid });
    const cur: Identity | null = seat ? identity.resolveBySession(sid) : null;
    return commands.run(args.split(/\s+/).filter(Boolean), { sid, cwd: w.cwd, pid, roomClaudeAgent, pubkey: seatKey.publicPem, pluginRoot: PLUGIN, seat: () => cur });
  });
}
const text = (a: Answer) => (a.kind === 'joined' ? a.say : a.text);

test('commands: the table names every verb; help and doctor are the open ones', () => {
  assert.deepEqual(Object.keys(commands.TABLE).sort(), ['', 'admit', 'handoff', 'invite', 'join', 'kick', 'leave']);
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
  assert.deepEqual(run(w, 'leave'), { kind: 'refused', text: 'this session is not in a room; /sub-human joins one.' });
  assert.deepEqual(run(w, 'leave 4829'), { kind: 'secret', text: `usage: /sub-human leave. All commands: /sub-human help`, refused: true });
  for (const args of ['join', 'invite', 'admit', 'admit 4829', 'kick 123456']) assert.equal(run(w, args).kind, 'secret', args);
  const admit = run(w, 'admit', { seat: 'alice' });
  assert.deepEqual(admit, { kind: 'secret', text: `nobody is waiting to join room ${w.code}.`, refused: false }, 'not a refusal, still hidden');
  // hide() on its own: a seat a prompt with a PIN-shaped word took is not handed to the model in that step
  const me = { code: w.code, name: sn('alice'), role: 'member' } as Identity;
  const joined: Answer = { kind: 'joined', me, lead: 'joined', say: `joined ${w.code} as alice` };
  assert.equal(commands.hide(['join', 'dev', w.code], joined), joined, 'a login join has no PIN: the seat goes to the model');
  assert.deepEqual(commands.hide(['join', 'dev', w.code, '--via', '2222'], joined), { kind: 'secret', text: `joined ${w.code} as alice · type /sub-human to bring the room to your Claude`, refused: false });
  assert.deepEqual(commands.hide(['help'], { kind: 'say', text: 'x' }), { kind: 'say', text: 'x' });
});

test('commands: leave, kick, admit, invite and handoff', t => {
  const w = new World({ alice: 'sleep', bob: 'sleep' }, { t });
  for (const v of ['kick bob', 'invite --pipe', 'admit']) assert.match(text(run(w, v)), /join a room first/, v);
  assert.match(text(run(w, 'kick alice', { seat: 'alice' })), /that is you; \/sub-human leave leaves the room/);
  assert.match(text(run(w, 'kick', { seat: 'alice' })), /usage: \/sub-human kick NAME/);
  assert.match(text(run(w, 'kick carol', { seat: 'alice' })), /nobody called "carol" joined room/);
  const inv = run(w, 'invite --pipe', { seat: 'alice' });
  assert.equal(inv.kind, 'secret');
  assert.equal((inv as { refused?: boolean }).refused, false, 'an invite is no refusal');
  assert.match(text(inv), new RegExp(`/sub-human join pipe:\\S+ ${w.code} [0-9a-z]{39}\n`));
  assert.match(text(inv), /its PIN apart from the line \(say it, or send it another way\): \d{4}\n/);
  assert.match(text(run(w, 'invite --pipe --web', { seat: 'alice' })), /pick one way at a time/);
  assert.match(text(run(w, 'admit zz', { seat: 'alice' })), /usage: \/sub-human admit/);
  assert.match(text(run(w, 'handoff')), /join a room first/);
  assert.match(text(run(w, 'handoff', { seat: 'alice' })), /usage: \/sub-human handoff NAME/);
  assert.match(text(run(w, 'handoff bob --via j', { seat: 'alice' })), /--via goes with the ssh address/);
  assert.match(text(run(w, 'leave now', { seat: 'alice' })), /usage: \/sub-human leave/);
  assert.deepEqual(run(w, 'leave', { seat: 'bob' }), { kind: 'say', text: `left ${w.code} · /sub-human joins again` });
  assert.ok(w.members().bob.left_at);
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
  assert.match(text(j), new RegExp(`^joined ${w.code} as bob, with alice`));
  const again = as('');
  assert.equal(again.kind, 'say', 'seated: the bare command is the status');
  assert.match(text(again), new RegExp(`^you're bob in room ${w.code}, with alice · another machine: /sub-human invite · leave: /sub-human leave`));
  assert.equal(as(`bob ${w.code}`).kind, 'joined', 'the same seat again: already joined');
});

test('commands: the room\'s Claude agent session binds its seat and takes no other command; a room Claude seat is refused', t => {
  const w = new World({ alice: 'sleep', claude: 'sleep' }, { t });
  assert.match(text(run(w, 'bob', { roomClaudeAgent: true })), /this session runs the room's Claude agent/);
  assert.match(text(run(w, 'leave', { seat: 'claude' })), new RegExp(`this session is the room's Claude of room ${w.code}; join from another session`));
});
