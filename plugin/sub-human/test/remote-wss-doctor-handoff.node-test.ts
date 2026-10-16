// 1.1 with the rest of 1.0: `sub-human doctor` sees the host's web listener (pid, port, rooms), each room's Tailscale
// path (present or gone, against a fake `tailscale`), Funnel's certificate-transparency warning, and a joiner's wss
// link through its real transport. And a planned handoff to a new host reached over the web: the locator is a ws
// URL, every invite the new host mints pins its listener's X25519 key, and the old host follows it over ws.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net, { type AddressInfo } from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { TestContext } from 'node:test';
import * as h from './helpers.ts';
import * as store from '../lib/room/store.ts';
import * as linkSocket from '../lib/remote/link-socket.ts';
import * as links from '../lib/room/links.ts';
import * as listener from '../lib/remote/listener.ts';
import * as invites from '../lib/remote/invites.ts';
import * as hostLinks from '../lib/remote/host-links.ts';
import * as handoff from '../lib/handoff.ts';
import * as doctor from '../lib/cli/doctor.ts';
import { Machine } from './support/two-homes.ts';
import * as noiseLib from '../lib/remote/noise.ts';
import type { WsSpec } from '../lib/remote/types-rest.ts';
import type { HandoffAskDoc } from '../lib/types-app.ts';
import type { RoomCode } from '../lib/brand.ts';

/** The card the consent hook's Pre rewrites AskUserQuestion's input to. */
interface Card { questions: { question: string }[] }

const LINK_ENV = { SUB_HUMAN_LINK_RETRY_MS: '200', SUB_HUMAN_LINK_RETRY_MAX_MS: '600', SUB_HUMAN_LINK_IDLE_MS: '20000' };
const childOf = (pid: number | undefined) => Number(spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).stdout.trim().split('\n')[0]) || null;
const kill = (pid: number | null | undefined) => { try { process.kill(pid as number, 'SIGKILL'); } catch { /* gone */ } };
const freePort = () => new Promise<number>(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => r(p)); }); });

function cleanup(t: TestContext, machines: Machine[], code: () => RoomCode) {
  t.after(() => {
    for (const m of machines) {
      m.lib(() => listener.stop());
      const d = m.lib(() => linkSocket.status(code()));
      if (d.pid) { kill(childOf(d.pid)); kill(d.pid); }
      fs.rmSync(path.dirname(linkSocket.socketPath(path.join(m.home, 'rooms', code()))), { recursive: true, force: true });
    }
  });
}

/** A fake tailscale that remembers the paths serve/funnel turned on and lists them in `serve status --json`. */
function fakeTailscale(t: TestContext) {
  const bin = h.tmpDir('sh-fake-ts-', t);
  const served = path.join(bin, 'served');
  fs.writeFileSync(served, '');
  fs.writeFileSync(path.join(bin, 'tailscale'), `#!${process.execPath}
const fs = require('fs'); const a = process.argv.slice(2); const f = ${JSON.stringify(served)};
const p = (a.find(x => x.startsWith('--set-path=')) || '').slice(11);
const cur = fs.readFileSync(f, 'utf8').split('\\n').filter(Boolean);
if (a[0] === 'status') console.log(JSON.stringify({ Self: { DNSName: 'box.tail1a2b.ts.net.' } }));
else if (a[1] === 'status') console.log(JSON.stringify({ Web: { 'box.tail1a2b.ts.net:443': { Handlers: Object.fromEntries(cur.map(x => [x, {}])) } } }));
else if (a.includes('off')) fs.writeFileSync(f, cur.filter(x => x !== p).join('\\n'));
else fs.writeFileSync(f, [...cur, p].join('\\n'));
`, { mode: 0o755 });
  return { bin, served };
}

test('doctor: the listener, a room\'s Tailscale path present or gone, Funnel\'s CT warning, a redacted bundle; a wss link\'s hello over the pinned channel', async t => {
  const ts = fakeTailscale(t);
  const port = await freePort();
  const host = new Machine(t, 'host', { SUB_HUMAN_LISTEN_PORT: String(port), PATH: `${ts.bin}:${process.env.PATH}` });
  const remote = new Machine(t, 'remote', LINK_ENV);
  const alice = host.seat('alice'), bob = remote.seat('bob');
  assert.equal(host.join(alice, 'alice').json!.decision, undefined);
  const code = host.lib(() => store.listRooms()[0]);
  cleanup(t, [host, remote], () => code);
  const checks = () => host.lib(() => doctor.checkListener({}));
  assert.match(checks()[0].detail, /no room is served over the web/);

  host.join(alice, 'invite --web');
  let c = checks();
  assert.equal(c[0].status, 'pass');
  assert.match(c[0].detail, new RegExp(`running \\(pid \\d+\\) on 127\\.0\\.0\\.1:${port} · serves ${code}`));
  assert.deepEqual([c[1].id, c[1].status], [`web:${code}`, 'pass'], JSON.stringify(c[1]));
  assert.match(c[1].detail, /Tailscale Serve \(tailnet only\) https:\/\/box\.tail1a2b\.ts\.net\/sub-human\/\S+ \(path present\)/);
  // the path gone behind our back (a serve reset): a failure, with the fix
  fs.writeFileSync(ts.served, '');
  c = checks();
  assert.deepEqual([c[1].status, c[1].fix], ['fail', '/sub-human invite --web in the room (it puts the path back)']);
  // Funnel: a warning that the name is public
  host.join(alice, 'invite --public');
  c = checks();
  assert.equal(c[1].status, 'warn');
  assert.match(c[1].detail, /Tailscale Funnel .*\(path present\)\. .*certificate-transparency/);
  // the bundle hashes the ts.net name and the room code
  const report = await host.lib(() => doctor.diagnose({ quick: true }));
  assert.ok(report.checks.some(x => x.id === 'listener'));
  const b = JSON.stringify(host.lib(() => doctor.bundle(report)));
  assert.ok(!b.includes('tail1a2b') && !b.includes(code), 'redacted');
  // the listener gone while a room is served: a failure
  host.lib(() => listener.stop());
  c = checks();
  assert.equal(c[0].status, 'fail');
  assert.match(c[0].fix!, /sub-human listen --start/);

  // a joiner's wss link: doctor's hello goes over the WebSocket and the pinned Noise channel
  host.lib(() => listener.start({ port }));
  await remote.joinVia(host, alice, bob, { invite: `invite --url http://127.0.0.1:${port}` });
  const lf = remote.lib(() => links.get(code))!;
  const probe = await remote.lib(() => doctor.helloProbe(lf.transport, code, { timeoutMs: 5000 }));
  assert.equal(probe.ok, true, probe.error);
  assert.ok(probe.reply && probe.reply.v! >= 1);
  const wrongKey = await remote.lib(() => doctor.helloProbe({ ...lf.transport as WsSpec, hostKey: noiseLib.generateKeyPair().pub.toString('base64url') }, code, { timeoutMs: 5000 }));
  assert.equal(wrongKey.ok, false, 'another pinned key gets no answer');
});

test('handoff to a new host reached over the web: a ws locator, invites pinning the new host\'s listener key, the old host following over ws', async t => {
  const bport = await freePort();
  const A = new Machine(t, 'a', LINK_ENV), B = new Machine(t, 'b', { ...LINK_ENV, SUB_HUMAN_LISTEN_PORT: String(bport) });
  const alice = A.seat('alice'), bob = B.seat('bob');
  assert.equal(A.join(alice, 'alice').json!.decision, undefined);
  const code = A.lib(() => store.listRooms()[0]);
  cleanup(t, [A, B], () => code);
  // bob joins over the pipe (any transport); alice asks him to host the room behind his web front
  assert.equal((await B.joinVia(A, alice, bob)).seated.json!.decision, undefined);
  const asked = A.join(alice, `handoff bob http://127.0.0.1:${bport}`).json!;
  assert.match(asked.reason!, /asked bob to host room/, JSON.stringify(asked));
  const loc = `ws://127.0.0.1:${bport}/sub-human/${code}`;
  assert.equal(A.lib(() => handoff.hostDoc(store.open(code)))!.locator, loc);
  assert.ok(await h.until(() => B.lib(() => store.open(code).kv.get(handoff.ASK_DOC)), 5000, 50));
  const id = B.lib(() => store.open(code).kv.get<HandoffAskDoc>(handoff.ASK_DOC))!.id;
  // bob's own answer on the card
  const pre = B.hook('consent', { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: `handoff ${id}`, options: [] }] } }, bob);
  const card = pre.json!.hookSpecificOutput!.updatedInput as Card;
  const q = card.questions[0].question;
  const post = B.hook('consent', { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_input: card, tool_response: { questions: card.questions, answers: { [q]: 'Host it here' } } }, bob);
  assert.match(post.json!.systemMessage!, /is hosted on this machine now, and its Claude runs on your Claude account/, post.stderr);

  // B serves the room on its listener; the invite B minted for A pins B's listener key; A follows over ws
  const bkey = B.lib(() => listener.hostKey());
  assert.ok(B.lib(() => listener.status()).rooms[code], 'B serves the room over the web');
  const minted = A.lib(() => handoff.hostDoc(store.open(code)));
  const forA = minted && minted.invites && Object.values(minted.invites)[0];
  if (forA) assert.equal(invites.parseInvite(forA)!.hostKey, bkey, 'the handoff invite pins the new host\'s key');
  assert.ok(await h.until(() => A.lib(() => linkSocket.status(code)).state === 'online', 10_000, 50), JSON.stringify(A.lib(() => linkSocket.status(code))));
  const lf = A.lib(() => links.get(code))!;
  const { clientKey, ...pinned } = lf.transport as WsSpec;
  assert.deepEqual(pinned, { kind: 'ws', host: '127.0.0.1', port: bport, path: `/sub-human/${code}`, hostKey: bkey });
  assert.match(String(clientKey), /^[A-Za-z0-9_-]{43}$/, 'a key of the link\'s own (XK)');
  assert.ok(Object.values(B.lib(() => hostLinks.links(store.open(code)))).some(l => l.key === clientKey), 'the new host bound A\'s link to that key');
  assert.equal(B.lib(() => store.open(code).readAll()).find(e => e.kind === 'host_changed')!.locator, loc);
  // alice posts through the new host, over ws
  assert.equal(A.say(alice, 'over ws to the new host').json!.continue, false);
  assert.equal(B.lib(() => store.open(code).readAll()).at(-1)!.text, 'over ws to the new host');
  assert.ok(await h.until(() => A.log(code) === B.log(code), 5000, 50));
});
