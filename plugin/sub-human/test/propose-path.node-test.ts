// propose({path}): where a proposal's file may come from (lib/proposal.ts create). The bytes are stored, streamed to
// every mirror and shown to the whole room, so a steered model must not propose ~/.ssh/id_ed25519: the root is the
// seat's working directory (never ~, / or above ~) or Claude Code's plans, and the plugin's home, ~/.sub-human,
// ~/.ssh and ~/.claude (its plans aside) are refused whatever the root.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as h from './helpers.ts';
import * as identity from '../lib/identity.ts';
import * as proposal from '../lib/proposal.ts';
import type { RoomCode } from '../lib/brand.ts';
import { sn } from './support/brands.ts';

/** A fake user home with ~/.ssh, ~/.claude/plans and a project, HOME and CLAUDE_CONFIG_DIR pointed at it. */
function userHome(t: import('node:test').TestContext) {
  const u = fs.realpathSync(h.tmpDir('sh-user-', t));
  const was = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  process.env.HOME = u;
  delete process.env.CLAUDE_CONFIG_DIR;
  t.after(() => { for (const [k, v] of Object.entries(was)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const put = (rel: string, body = '# a plan\nbody\n') => { const f = path.join(u, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); return f; };
  return { u, put };
}

const tryCreate = (code: RoomCode, file: string, cwd: string) => {
  try { proposal.create({ code, name: sn('alice') }, { path: file }, { cwd }); return 'ok'; } catch (e) {
    if (e instanceof proposal.ProposalError) return e.message;
    throw e;
  }
};

test('propose path: a session started in ~ (or /) has no working-directory root; its plans still propose', t => {
  h.freshHome(t);
  const { u, put } = userHome(t);
  const { code } = h.register('alice');
  const key = put('.ssh/id_ed25519', '-----BEGIN OPENSSH PRIVATE KEY-----\nx\n');
  const notes = put('notes.md');
  assert.match(tryCreate(code, key, u), /under the working directory/, 'the reviewer\'s probe: ~/.ssh from a session in ~');
  assert.match(tryCreate(code, notes, u), /under the working directory/, '~ is no root');
  assert.match(tryCreate(code, notes, '/'), /under the working directory/, '/ is no root');
  assert.match(tryCreate(code, notes, path.dirname(u)), /under the working directory/, 'above ~ is no root');
  assert.equal(tryCreate(code, put('.claude/plans/p.md'), u), 'ok', 'Claude Code\'s plans');
});

test('propose path: under a project root it proposes; ~/.ssh, ~/.claude and the plugin home never, through a link either', t => {
  h.freshHome(t);
  const { u, put } = userHome(t);
  const proj = path.join(u, 'proj');
  process.env.SUB_HUMAN_HOME = path.join(proj, '.home'); // the plugin's home inside the project
  const { code } = h.register('alice', 'member', process.pid, identity.newCode());
  assert.equal(tryCreate(code, put('proj/plan.md'), proj), 'ok');
  const key = put('.ssh/id_ed25519', 'secret\n');
  fs.symlinkSync(key, path.join(proj, 'innocent.md'));
  assert.match(tryCreate(code, path.join(proj, 'innocent.md'), proj), /under the working directory/, 'a link into ~/.ssh');
  put('.claude/settings.json', '{}\n');
  fs.symlinkSync(path.join(u, '.claude', 'settings.json'), path.join(proj, 'settings.md'));
  assert.match(tryCreate(code, path.join(proj, 'settings.md'), proj), /under the working directory/, '~/.claude outside its plans');
  // a project whose root holds the plugin's home: the home stays out
  const members = path.join(identity.home(), 'rooms', code, 'members.json');
  assert.ok(fs.existsSync(members) && members.startsWith(proj + path.sep));
  assert.match(tryCreate(code, members, proj), /under the working directory/);
});
