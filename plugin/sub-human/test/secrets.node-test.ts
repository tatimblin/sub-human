// The secrets (lib/brand.ts Secret: an invite line's PIN and SECRET, a link's token) stay where they must and nowhere
// else. A whole invite join over pipe between two homes (test/support/two-homes.ts: the line, the PIN, the host's admit,
// the seat), some talk, the tails, and a second invite nobody used; then every file under both homes is read, each
// JSON document and log line parsed, and every string in it checked against this run's secrets: the word and the
// token anywhere in it, the PIN as a whole value or after `join ` (a 4-digit number alone could be anything). What
// legitimately holds one: the joiner's link record (its token; the line's word and the PIN only until the host
// answered, and a seated join is past that). The host keeps sha256s only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as links from '../lib/room/links.ts';
import { isInviteSecret } from '../lib/remote/invite-secret.ts';
import { isLinkToken } from '../lib/remote/host-links.ts';
import { isPin } from '../lib/remote/invites.ts';
import { redact } from '../lib/cli/doctor/redact.ts';
import { Machine, shownInvite, stopDaemon } from './support/two-homes.ts';

const LINK_ENV: Record<string, string> = { SUB_HUMAN_LINK_RETRY_MS: '200', SUB_HUMAN_LINK_RETRY_MAX_MS: '400', SUB_HUMAN_LINK_IDLE_MS: '1500' };

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** Every string in a parsed value (keys too). */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); strings(x, out); }
  return out;
}

/** The strings a file holds: a JSON document's or each JSON line's, else its text. */
function contents(file: string): string[] {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  try { return strings(JSON.parse(text)); } catch { /* not one document */ }
  return text.split('\n').flatMap(l => { try { return strings(JSON.parse(l)); } catch { return [l]; } });
}

test('secrets: after an invite join, only the joiner\'s link record holds one; the host keeps digests, logs and documents none', async t => {
  const host = new Machine(t, 'host'), remote = new Machine(t, 'remote', LINK_ENV);
  const alice = host.seat('alice'), bob = remote.seat('bob');
  assert.equal(host.join(alice, 'alice').json?.decision, undefined);
  const j = await remote.joinVia(host, alice, bob);
  stopDaemon(t, remote, j.code);
  const used = shownInvite(String(j.shown?.json?.reason));
  assert.ok(used, 'the line alice was shown');
  assert.equal(j.seated.json?.decision, undefined, j.seated.stdout);
  remote.say(bob, 'hello from the other home');
  host.say(alice, 'welcome');
  await remote.tail(bob, 1);
  await host.tail(alice, 1);
  // a second invite, open: its word and PIN were shown to alice, and must be kept nowhere
  const open = shownInvite(String(host.join(alice, 'invite --pipe').json?.reason));
  assert.ok(open, 'a second line');
  const token = remote.lib(() => links.get(j.code))?.token;
  assert.ok(isLinkToken(token), 'the link has its token');
  assert.ok(isInviteSecret(used.word) && isInviteSecret(open.word) && isPin(used.pin) && isPin(open.pin), 'each secret is one its constructor makes');
  const words = [used.word, open.word, token];
  const pins = [used.pin, open.pin];

  const holders: Record<string, string[]> = {};
  for (const [who, m] of [['host', host], ['remote', remote]] as const) {
    for (const f of filesUnder(m.home)) {
      const found = new Set<string>();
      for (const s of contents(f)) {
        for (const w of words) if (s.includes(w)) found.add(w === token ? 'token' : 'word');
        for (const p of pins) if (s === p || s.includes(`join ${p}`)) found.add('pin');
      }
      if (found.size) holders[`${who}:${path.relative(m.home, f)}`] = [...found].sort();
    }
  }
  assert.deepEqual(holders, { [`remote:links/${j.code}.json`]: ['token'] }, 'only the joiner\'s link record holds a secret: its token');
  assert.equal(redact(token), '####', 'and a line shows one only as redact() does');
});
