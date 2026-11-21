// mod/core/walk.ts in node (PLAN-SMOOTH 0.6.1 item 1): the question after a bare /sub-human opened a room, what this
// machine can offer (the labels, the one marked detected, one that cannot work dropped), what each answer does, and
// hooks/handlers/walk.ts reporting what it found (a stub tailscale; Remote Login forced). The wiring (the module's own
// dialog after the join's turn, the invite through the shim, the line kept off the transcript) is in
// mod/test/walk.test.ts (npm run test:mods).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  walkFacts, walkOptions, walkAction, walkQuestion, NO_FACTS, HERE_LINE, WALK_HEADER, THIS_MACHINE, SSH, TAILSCALE, DETECTED,
} from '../mod/core/walk.ts';
import { World } from './hooks/helpers.ts';
import { must } from './support/must.ts';

test('walk: the question and its header, as the plan words them', () => {
  assert.equal(walkQuestion('orca-6418'), 'Bring someone into orca-6418?');
  assert.ok(WALK_HEADER.length <= 12);
  assert.equal(HERE_LINE, 'In another session here, type /sub-human');
});

test('walk: the labels: This machine · SSH · Tailscale, the likely one marked, one that cannot work dropped', () => {
  const det = (l: string) => `${l}${DETECTED}`;
  assert.deepEqual(walkOptions(NO_FACTS), [THIS_MACHINE, SSH, TAILSCALE], 'nothing known: all three, none marked');
  assert.deepEqual(walkOptions({ tailnet: 'up', ssh: 'on', sshAddr: false }), [THIS_MACHINE, SSH, det(TAILSCALE)], 'the tailnet up: a bare invite would use it');
  assert.deepEqual(walkOptions({ tailnet: 'up', ssh: 'on', sshAddr: true }), [THIS_MACHINE, det(SSH), TAILSCALE], 'an ssh address set up keeps a bare invite on ssh');
  assert.deepEqual(walkOptions({ tailnet: 'down', ssh: 'on', sshAddr: false }), [THIS_MACHINE, det(SSH), TAILSCALE]);
  assert.deepEqual(walkOptions({ tailnet: 'none', ssh: 'on', sshAddr: false }), [THIS_MACHINE, det(SSH)], 'no tailscale CLI: Tailscale cannot work');
  assert.deepEqual(walkOptions({ tailnet: 'up', ssh: 'off', sshAddr: false }), [THIS_MACHINE, det(TAILSCALE)], 'Remote Login off: their ssh here would fail');
  assert.deepEqual(walkOptions({ tailnet: 'none', ssh: 'off', sshAddr: false }), [THIS_MACHINE, SSH], 'always two: ssh stays (its invite says how to turn Remote Login on)');
  assert.deepEqual(walkOptions({ tailnet: 'down', ssh: 'off', sshAddr: true }), [THIS_MACHINE, det(SSH), TAILSCALE], 'an address may reach another sshd');
  for (const f of [NO_FACTS, { tailnet: 'none', ssh: 'off', sshAddr: false } as const]) {
    const n = walkOptions(f).length;
    assert.ok(n >= 2 && n <= 4, '$.ui.ask takes 2-4 labels');
  }
});

test('walk: node walk\'s report read as it may be', () => {
  assert.deepEqual(walkFacts({ tailnet: 'up', ssh: 'off', sshAddr: true }), { tailnet: 'up', ssh: 'off', sshAddr: true });
  assert.deepEqual(walkFacts({ tailnet: 'sure', ssh: 1 }), NO_FACTS);
  assert.deepEqual(walkFacts(null), NO_FACTS);
  assert.deepEqual(walkFacts('up'), NO_FACTS);
});

test('walk: each answer: dismissed nothing, This machine the line, SSH and Tailscale the typed command\'s invite, an address typed ssh to it', () => {
  assert.deepEqual(walkAction(null), { kind: 'none' });
  assert.deepEqual(walkAction(''), { kind: 'none' });
  assert.deepEqual(walkAction(THIS_MACHINE), { kind: 'here' });
  assert.deepEqual(walkAction(SSH), { kind: 'invite', args: 'invite --ssh', via: 'ssh' });
  assert.deepEqual(walkAction(`${SSH}${DETECTED}`), { kind: 'invite', args: 'invite --ssh', via: 'ssh' });
  assert.deepEqual(walkAction(`${TAILSCALE}${DETECTED}`), { kind: 'invite', args: 'invite --web', via: 'tailscale' });
  assert.deepEqual(walkAction('tailscale'), { kind: 'invite', args: 'invite --web', via: 'tailscale' }, 'a label typed is that label');
  assert.deepEqual(walkAction(' jess@devbox.local '), { kind: 'invite', args: 'invite --ssh jess@devbox.local', via: 'ssh' });
  assert.deepEqual(walkAction('devbox'), { kind: 'invite', args: 'invite --ssh devbox', via: 'ssh' }, 'a bare host (an ssh alias works too)');
  for (const t of ['not now', 'no', 'Later', 'bring jess in', 'jess@', '@host', '4821', 'a;rm -rf', '--web', 'x y']) {
    assert.deepEqual(walkAction(t), { kind: 'none' }, t);
  }
});

/** A stub tailscale CLI answering `status --json` with this machine online or not. */
function fakeTailscale(online: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-walk-ts-'));
  const bin = path.join(dir, 'tailscale');
  const status = JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'box.tail1a2b.ts.net.', Online: online } });
  fs.writeFileSync(bin, `#!/bin/sh\necho '${status}'\n`, { mode: 0o755 });
  return bin;
}

test('hooks/handlers/walk.ts: what this machine can offer (the tailnet as a bare invite checks it, Remote Login, an ssh address set up)', () => {
  const w = new World({}, { room: false });
  const run = (env: Record<string, string | undefined>) => {
    const r = w.hook('walk', {}, { env: { SUB_HUMAN_SSH_ADDR: undefined, ...env } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, '', 'nothing on stderr on success');
    return must(must(r.json).subHuman).walk;
  };
  assert.deepEqual(run({ SUB_HUMAN_TAILSCALE: fakeTailscale(true), SUB_HUMAN_REMOTE_LOGIN: 'on' }), { tailnet: 'up', ssh: 'on', sshAddr: false });
  assert.deepEqual(run({ SUB_HUMAN_TAILSCALE: fakeTailscale(false), SUB_HUMAN_REMOTE_LOGIN: 'off', SUB_HUMAN_SSH_ADDR: 'devbox' }), { tailnet: 'down', ssh: 'off', sshAddr: true });
});
