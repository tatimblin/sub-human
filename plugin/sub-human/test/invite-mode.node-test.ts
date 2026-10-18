// lib/commands/invite.ts: which way a bare /sub-human invite goes (the tailnet when Tailscale is up here, else ssh;
// never Funnel), the pointer to --public under a tailnet-only invite, and the joiner's hint when a ts.net name does not
// answer (lib/remote/transports/ws.ts offline). The tailnet and the web invite are stubbed: no real tailscale runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { TestContext } from 'node:test';
import * as h from './helpers.ts';
import { World } from './hooks/helpers.ts';
import * as commands from '../lib/commands/index.ts';
import * as inviteMod from '../lib/commands/invite.ts';
import * as hosting from '../lib/remote/hosting.ts';
import * as seats from '../lib/seats.ts';
import * as identity from '../lib/identity.ts';
import * as seatKey from '../hooks/seat-key.ts';
import * as wsT from '../lib/remote/transports/ws.ts';
import type { Answer } from '../lib/commands/types.ts';
import type { WebInvite } from '../lib/remote/webhost.ts';
import type { RoomCode } from '../lib/brand.ts';

const PLUGIN = new URL('..', import.meta.url).pathname;
seats.seam.startDetached = () => {};
const REAL = { ...inviteMod.seam };

const run = (w: World, args: string): Answer => w.lib(() => {
  identity.writeModLease(w.sid.alice ?? '', { pid: process.pid });
  const cur = identity.resolveBySession(w.sid.alice ?? '');
  return commands.run(args.split(/\s+/).filter(Boolean), { sid: w.sid.alice ?? '', cwd: w.cwd, pid: process.pid, roomClaudeAgent: false, pubkey: seatKey.publicPem, pluginRoot: PLUGIN, seat: () => cur });
});
const text = (a: Answer) => (a.kind === 'joined' ? a.say : a.text);
const pinnedOf = (a: Answer) => (a.kind === 'secret' && a.pinned ? a.pinned : null);

/** Stub the tailnet (up or not) and the web invite (a pipe invite dressed as one of mode, or a throw); restored after t. */
function stub(t: TestContext, { up, mode = 'tailscale', fail = null, state = { running: false, served: false } }: { up: boolean; mode?: string; fail?: string | null; state?: { running: boolean; served: boolean } }) {
  const calls: { up: number; web: { funnel: boolean | undefined }[]; unhost: RoomCode[] } = { up: 0, web: [], unhost: [] };
  inviteMod.seam.tailnetUp = () => { calls.up++; return up; };
  inviteMod.seam.webState = () => state;
  inviteMod.seam.unhost = (code: RoomCode) => { calls.unhost.push(code); return { removed: false, text: '' }; };
  inviteMod.seam.hostWeb = (code: RoomCode, o = {}): WebInvite => {
    calls.web.push({ funnel: o.funnel });
    if (fail !== null) throw new Error(fail);
    const r = hosting.hostInvite(code, { pipe: true, by: o.by ?? null });
    return { ...r, text: `WEB ${mode}\n${r.text}`, hostKey: 'k', base: 'https://box.tail1a2b.ts.net/sub-human/x', mode, port: 1 };
  };
  t.after(() => Object.assign(inviteMod.seam, REAL));
  return calls;
}

test('invite: no way named and Tailscale up here: the tailnet (never Funnel), with the pointer to --public', t => {
  const w = new World({ alice: 'sleep' }, { t });
  const calls = stub(t, { up: true });
  const a = run(w, 'invite');
  assert.equal(a.kind, 'secret');
  assert.deepEqual(calls.web, [{ funnel: false }], 'Serve, not Funnel');
  assert.match(text(a), /^WEB tailscale\n/);
  assert.ok(text(a).endsWith(`\n${inviteMod.OFF_TAILNET}`), text(a));
  assert.equal(inviteMod.OFF_TAILNET, 'Off your tailnet? /sub-human invite --public');
  const p = pinnedOf(a);
  assert.ok(p, 'pinned for the module');
  assert.ok(p.text.endsWith(`\n${inviteMod.OFF_TAILNET}`), 'the pinned text says it too');
  if (p.cut !== undefined) assert.ok(p.cut.endsWith(`\n${inviteMod.OFF_TAILNET}`), 'and the cut one');
  assert.doesNotMatch(p.text, /PIN \d{4}/, 'the pinned text still holds no PIN');
});

test('invite: --web is tailnet-only too (the pointer); --public is Funnel (none)', t => {
  const w = new World({ alice: 'sleep' }, { t });
  stub(t, { up: false });
  assert.ok(text(run(w, 'invite --web')).endsWith(inviteMod.OFF_TAILNET));
  const calls = stub(t, { up: false, mode: 'funnel' });
  const pub = run(w, 'invite --public');
  assert.deepEqual(calls.web, [{ funnel: true }]);
  assert.doesNotMatch(text(pub), /Off your tailnet/);
  assert.equal(calls.up, 0, 'a way named: the tailnet is not looked at');
});

test('invite: Tailscale not up here, --ssh, or SUB_HUMAN_SSH_ADDR set: ssh as before', t => {
  const w = new World({ alice: 'sleep' }, { t });
  const down = stub(t, { up: false });
  const a = run(w, 'invite');
  assert.equal(down.web.length, 0);
  assert.match(text(a), new RegExp(`/sub-human join \\S+ ${w.code} [0-9a-z]{39}`), 'an ssh line');
  assert.doesNotMatch(text(a), /Off your tailnet/);
  const up = stub(t, { up: true });
  assert.doesNotMatch(text(run(w, 'invite --ssh')), /^WEB/, '--ssh is ssh');
  assert.deepEqual([up.up, up.web.length], [0, 0]);
  const was = process.env.SUB_HUMAN_SSH_ADDR;
  process.env.SUB_HUMAN_SSH_ADDR = 'dev@box.example';
  t.after(() => { if (was === undefined) delete process.env.SUB_HUMAN_SSH_ADDR; else process.env.SUB_HUMAN_SSH_ADDR = was; });
  assert.match(text(run(w, 'invite')), new RegExp(`/sub-human join dev@box\\.example ${w.code} `), 'an ssh address set up: ssh');
  assert.deepEqual([up.up, up.web.length], [0, 0]);
});

test('invite: a tailnet invite that fails falls back to ssh and says why', t => {
  const w = new World({ alice: 'sleep' }, { t });
  const calls = stub(t, { up: true, fail: 'Tailscale Serve isn\'t enabled on your tailnet yet.' });
  const a = run(w, 'invite');
  assert.deepEqual(calls.unhost, [w.code], 'the listener the failed invite started is stopped (it serves no room)');
  assert.equal(a.kind, 'secret');
  assert.equal(a.kind === 'secret' && a.refused, false);
  assert.match(text(a), /^Not over your tailnet: Tailscale Serve isn't enabled on your tailnet yet\. This invite is over ssh instead\.\n\n/);
  assert.match(text(a), new RegExp(`/sub-human join \\S+ ${w.code} [0-9a-z]{39}`));
  assert.match(pinnedOf(a)?.text ?? '', /^Not over your tailnet/);
  // asked for by name, the same failure is the answer
  assert.match(text(run(w, 'invite --web')), /Tailscale Serve isn't enabled/);
  assert.equal(calls.unhost.length, 1, '--web that fails stops nothing');
  // a listener that ran before, or served this room already, is left alone
  for (const state of [{ running: true, served: false }, { running: false, served: true }]) {
    const again = stub(t, { up: true, fail: 'no.', state });
    assert.match(text(run(w, 'invite')), /^Not over your tailnet/);
    assert.deepEqual(again.unhost, [], JSON.stringify(state));
  }
});

test('invite: tailnetUp is the CLI and its status (a fake tailscale; none at that path: down)', t => {
  const real = REAL.tailnetUp;
  const dir = h.tmpDir('sh-fake-ts-', t);
  const bin = path.join(dir, 'tailscale');
  const was = process.env.SUB_HUMAN_TAILSCALE;
  t.after(() => { if (was === undefined) delete process.env.SUB_HUMAN_TAILSCALE; else process.env.SUB_HUMAN_TAILSCALE = was; });
  process.env.SUB_HUMAN_TAILSCALE = bin;
  assert.equal(real(), false, 'no binary there');
  fs.writeFileSync(bin, '#!/bin/sh\n[ "$1" = status ] || exit 9\nprintf \'%s\\n\' \'{"BackendState":"Running","Self":{"DNSName":"box.tail1a2b.ts.net.","Online":true}}\'\n', { mode: 0o755 });
  assert.equal(real(), true, 'up');
  fs.writeFileSync(bin, '#!/bin/sh\n[ "$1" = status ] || exit 9\nprintf \'%s\\n\' \'{"BackendState":"Running","Self":{"DNSName":"box.tail1a2b.ts.net.","Online":false}}\'\n', { mode: 0o755 });
  assert.equal(real(), false, 'this machine offline on its tailnet');
  fs.writeFileSync(bin, '#!/bin/sh\nprintf \'%s\\n\' \'{"BackendState":"NeedsLogin"}\'\n', { mode: 0o755 });
  assert.equal(real(), false, 'logged out');
  fs.writeFileSync(bin, '#!/bin/sh\necho "failed to connect to local Tailscale daemon" >&2; exit 1\n', { mode: 0o755 });
  assert.equal(real(), false, 'not running');
});

test('ws offline: a ts.net name that never answers (or does not resolve) says the host may need --public', () => {
  const timeout = new Error('no WebSocket to box.tail1a2b.ts.net within 45000 ms');
  const hint = wsT.OFF_TAILNET_HINT;
  assert.match(hint, /\/sub-human invite --public/);
  const e = wsT.offline('box.tail1a2b.ts.net', timeout);
  assert.equal(e.code, 'OFFLINE');
  assert.equal(e.message, `${timeout.message} (${hint})`);
  assert.ok(wsT.offline('box.tail1a2b.ts.net', new Error('TLS to box.tail1a2b.ts.net:443: getaddrinfo ENOTFOUND box.tail1a2b.ts.net')).message.endsWith(`(${hint})`));
  assert.equal(wsT.offline('box.tail1a2b.ts.net', new Error('wss://box.tail1a2b.ts.net/x answered 404 Not Found instead of a WebSocket upgrade')).message.includes(hint), false, 'it answered: not a reach problem');
  assert.equal(wsT.offline('front.example', new Error('no WebSocket to front.example within 45000 ms')).message.includes(hint), false, 'not a ts.net name');
});

// PLAN-JOIN step 5: the line alone rides beside the pinned status for the module's copy card, never the PIN; --no-card
// and SUB_HUMAN_INVITE_CARD=0 leave it out (no card, nothing the module could copy)
test('invite: the pinned form carries the line alone for the copy card (no PIN in it); --no-card or SUB_HUMAN_INVITE_CARD=0 leaves it out', t => {
  const w = new World({ alice: 'sleep' }, { t });
  stub(t, { up: false });
  const p = pinnedOf(run(w, 'invite'));
  assert.ok(p && p.line, 'the line for the card');
  const [, pin = ''] = /^PIN (\d+) · /.exec(p.status) ?? [];
  assert.match(pin, /^\d{4}$/);
  assert.equal(p.status, `PIN ${pin} · ${p.line}`, 'the status line is the PIN and this line');
  assert.ok(!p.line.split(/\s+/).includes(pin), 'the line holds no PIN');
  assert.match(p.line, /^\/sub-human join /);
  assert.equal(pinnedOf(run(w, 'invite --no-card'))?.line, undefined);
  const was = process.env.SUB_HUMAN_INVITE_CARD;
  t.after(() => { if (was === undefined) delete process.env.SUB_HUMAN_INVITE_CARD; else process.env.SUB_HUMAN_INVITE_CARD = was; });
  process.env.SUB_HUMAN_INVITE_CARD = '0';
  const off = pinnedOf(run(w, 'invite'));
  assert.ok(off, 'still pinned');
  assert.equal(off.line, undefined);
});
