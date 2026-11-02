// The room task lists no room of this home uses (lib/gc.ts staleTaskLists; issue #11): a folder under
// <config dir>/tasks/ goes only when it is named sh-CODE, no room here (open, closed or set aside) has that code, no
// live `claude --bg` job is claude.CODE, it and every entry in it are older than ROOM_GC_MS, and every entry is a
// plain .lock, .highwatermark or N.json: all stamped for CODE (the join's sweep, once a day), or, legacy, the
// lowest-numbered one the room task (`sub-human gc --tasks`, deleting only with --yes). doctor counts them.
// Every folder is in a temp CLAUDE_CONFIG_DIR: nothing here reaches ~/.claude.
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as h from './helpers.ts';
import * as identity from '../lib/identity.ts';
import * as store from '../lib/room/store.ts';
import * as gc from '../lib/gc.ts';
import * as config from '../lib/config.ts';
import * as doctor from '../lib/cli/doctor.ts';
import type { AgentJob } from '../lib/cc/bg.ts';
import type { RoomCode } from '../lib/brand.ts';
import { sn } from './support/brands.ts';

const DAY = 24 * 60 * 60_000;

/** p and everything under it (symlinks themselves, not what they name) last changed `days` ago. */
function age(p: string, days: number): void {
  const t = new Date(Date.now() - days * DAY);
  const walk = (q: string) => {
    const st = fs.lstatSync(q);
    if (st.isDirectory()) for (const n of fs.readdirSync(q)) walk(path.join(q, n));
    if (st.isSymbolicLink()) fs.lutimesSync(q, t, t); else fs.utimesSync(q, t, t);
  };
  walk(p);
}

/** A fresh home and Claude Code config dir; its tasks/ folder. */
function fresh(t: TestContext): string {
  h.freshHome(t);
  process.env.CLAUDE_CONFIG_DIR = h.tmpDir('sub-human-test-claude-', t);
  const tasks = path.join(process.env.CLAUDE_CONFIG_DIR, 'tasks');
  fs.mkdirSync(tasks);
  return tasks;
}

const stamped = (id: number, room: string) => ({ id: String(id), subject: `task ${id}`, description: '', status: 'pending', blocks: [], blockedBy: [], metadata: { room } });
/** The room task as the plugin wrote it before beta.18: no metadata. */
const roomTask = (code: string) => ({ id: '1', subject: `room ${code} open`, description: `Room ${code} is open.`, owner: 'room', status: 'completed', blocks: [], blockedBy: [] });

/** tasks/NAME with these files (name -> JSON value, or a string as it is), aged 40 days. */
function list(tasks: string, name: string, files: Record<string, unknown> = {}, days = 40): string {
  const dir = path.join(tasks, name);
  fs.mkdirSync(dir);
  for (const [f, v] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), typeof v === 'string' ? v : JSON.stringify(v));
  age(dir, days);
  return dir;
}

/** A room of this home whose one person joined; left: and left again. */
function room(left = true): RoomCode {
  const code = h.newRoom();
  assert.ok(identity.join({ code, name: sn('alice'), role: 'member', pid: process.pid, session_id: null, cwd: '/' }).ok);
  if (left) assert.ok(identity.leave(code, sn('alice'), { reason: 'done' }));
  return code;
}

const job = (name: string, state: string | null): AgentJob => ({ pid: null, id: 'abcd1234', sessionId: null, status: null, state, kind: 'background', name, cwd: '/', startedAt: null });

/** The table: every folder that must stay, and the ones each rule deletes. */
function table(tasks: string) {
  const open = room(false), aside = room();
  store.setAsideRoom(aside);
  const keep = {
    name: list(tasks, 'sh-Otter-12'),
    noPrefix: list(tasks, 'otter-0001'),
    foreignFile: list(tasks, 'sh-otter-0002', { '1.json': stamped(1, 'otter-0002'), 'notes.txt': 'mine' }),
    lockDir: list(tasks, 'sh-otter-0003', { '1.json': stamped(1, 'otter-0003') }),
    open: list(tasks, `sh-${open}`, { '1.json': stamped(1, open) }),
    aside: list(tasks, `sh-${aside}`, { '1.json': stamped(1, aside) }),
    young: list(tasks, 'sh-otter-0004', { '1.json': stamped(1, 'otter-0004') }, 3),
    youngFile: list(tasks, 'sh-otter-0005', { '1.json': stamped(1, 'otter-0005'), '2.json': stamped(2, 'otter-0005') }),
    symlink: path.join(tasks, 'sh-otter-0006'),
    symlinkInside: list(tasks, 'sh-otter-0007', { '1.json': stamped(1, 'otter-0007') }),
    otherStamp: list(tasks, 'sh-otter-0008', { '1.json': stamped(1, 'newt-9999') }),
    legacyNotRoom: list(tasks, 'sh-otter-0009', { '1.json': { id: '1', subject: 'write the docs', owner: 'bob', status: 'pending' }, '2.json': roomTask('otter-0009') }),
    legacyOtherRoom: list(tasks, 'sh-otter-0010', { '1.json': roomTask('otter-0010'), '2.json': stamped(2, 'newt-9999') }),
    inUse: list(tasks, 'sh-otter-0011', { '1.json': stamped(1, 'otter-0011'), '.lock': '' }),
  };
  fs.mkdirSync(path.join(keep.lockDir, '1.json.lock'));
  age(keep.lockDir, 40);
  fs.utimesSync(path.join(keep.youngFile, '2.json'), new Date(), new Date());
  const target = list(tasks, 'elsewhere', { '1.json': stamped(1, 'otter-0006') });
  fs.symlinkSync(target, keep.symlink);
  fs.symlinkSync(path.join(target, '1.json'), path.join(keep.symlinkInside, '2.json'));
  age(keep.symlinkInside, 40);
  age(keep.symlink, 40);
  const auto = {
    empty: list(tasks, 'sh-badger-0001'),
    lockOnly: list(tasks, 'sh-badger-0002', { '.lock': '', '.highwatermark': '3' }),
    allStamped: list(tasks, 'sh-badger-0003', { '.lock': '', '.highwatermark': '2', '1.json': stamped(1, 'badger-0003'), '2.json': stamped(2, 'badger-0003') }),
    endedJob: list(tasks, 'sh-badger-0004', { '1.json': stamped(1, 'badger-0004') }),
  };
  const legacy = {
    legacy: list(tasks, 'sh-badger-0005', { '.lock': '', '1.json': roomTask('badger-0005'), '2.json': { id: '2', subject: 'ship it', status: 'completed' } }),
  };
  const jobs = () => [job('claude.otter-0011', 'blocked'), job('claude.badger-0004', 'done'), job('something else', null)];
  return { keep, auto, legacy, jobs };
}

const exists = (p: string) => { try { fs.lstatSync(p); return true; } catch { return false; } };

test('gc tasks: the join\'s sweep deletes the stamped, empty and lock-only lists no room here uses; every other folder stays', t => {
  const tasks = fresh(t);
  const { keep, auto, legacy, jobs } = table(tasks);
  const scan = gc.staleTaskLists({ jobs, legacy: true });
  assert.deepEqual(scan.lists.map(l => `${path.basename(l.dir)} ${l.kind}`).sort(),
    [...Object.values(auto).map(d => `${path.basename(d)} stamped`), ...Object.values(legacy).map(d => `${path.basename(d)} legacy`)].sort());
  const r = gc.sweep({ force: true, jobs });
  assert.ok(r);
  assert.deepEqual(r.tasks.sort(), Object.values(auto).sort());
  for (const [why, d] of Object.entries(auto)) assert.ok(!exists(d), `${why}: deleted`);
  for (const [why, d] of Object.entries(keep)) assert.ok(exists(d), `${why}: kept`);
  assert.ok(exists(legacy.legacy), 'legacy: only `gc --tasks` deletes it');
  assert.ok(exists(path.join(tasks, 'elsewhere', '1.json')), 'a symlink\'s target is never touched');
});

test('gc tasks: no job list, no deletion; the sweep looks at tasks/ at most once a day and never throws', t => {
  const tasks = fresh(t);
  const dir = list(tasks, 'sh-badger-0001');
  const none = gc.staleTaskLists({ jobs: () => null });
  assert.equal(none.jobsUnknown, true);
  assert.deepEqual(none.lists, []);
  assert.deepEqual(gc.staleTaskLists({ jobs: () => { throw new Error('no claude'); } }).lists, []);
  let asked = 0;
  const jobs = () => { asked++; return []; };
  const now = Date.now();
  assert.deepEqual(gc.sweep({ now, jobs: () => null })?.tasks, [], 'the job list unread: it stays');
  assert.ok(exists(dir));
  assert.deepEqual(gc.sweep({ now: now + config.GC_EVERY_MS + 1000, jobs })?.tasks, [], 'the home is swept again, tasks/ not yet');
  assert.equal(asked, 0);
  assert.deepEqual(gc.sweep({ now: now + config.TASKS_GC_EVERY_MS + 1000, jobs })?.tasks, [dir], 'a day on: it goes');
  assert.equal(asked, 1);
  // the list is read only when there is something to delete
  assert.deepEqual(gc.sweep({ force: true, jobs })?.tasks, []);
  assert.equal(asked, 1);
  // tasks/ unreadable or a file: nothing, no throw
  fs.rmSync(tasks, { recursive: true });
  fs.writeFileSync(tasks, '');
  assert.deepEqual(gc.sweep({ force: true, jobs })?.tasks, []);
});

test('gc tasks: the sweep stops at its budget and goes on from the folder after the one it stopped at', t => {
  const tasks = fresh(t);
  const dirs = [1, 2, 3].map(n => list(tasks, `sh-badger-000${n}`));
  const r = gc.staleTaskLists({ jobs: () => [], after: 'sh-badger-0001' });
  assert.deepEqual(r.lists.map(l => l.dir), [dirs[1], dirs[2], dirs[0]], 'past the cursor first, then round');
  const stopped = gc.staleTaskLists({ jobs: () => [], until: 0 });
  assert.equal(stopped.done, false);
  assert.deepEqual(stopped.lists, []);
});

/** `sub-human gc ARGS` in a child, with a stand-in claude printing `out` for `agents --json` (exit 1 when null). */
function cli(t: TestContext, args: string[], out: string | null) {
  const bin = path.join(h.tmpDir('sub-human-test-bin-', t), 'claude');
  fs.writeFileSync(bin, out === null ? '#!/bin/sh\nexit 1\n' : `#!/bin/sh\nprintf '%s' '${out}'\n`, { mode: 0o755 });
  return spawnSync(process.execPath, [h.BIN, 'gc', ...args], { encoding: 'utf8', env: h.childEnv({ CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, SUB_HUMAN_CLAUDE: bin }) });
}

test('sub-human gc --tasks lists the stamped and legacy lists and deletes nothing; --yes deletes them; no job list, nothing', t => {
  const tasks = fresh(t);
  const { keep, auto, legacy } = table(tasks);
  const jobsJson = JSON.stringify([{ id: 'abcd1234', kind: 'background', name: 'claude.otter-0011', state: 'blocked' }]);
  const gone = [...Object.values(auto), ...Object.values(legacy)];
  const dry = cli(t, ['--tasks'], jobsJson);
  assert.equal(dry.status, 0, dry.stderr);
  for (const d of gone) assert.ok(dry.stdout.includes(d), `listed: ${d}`);
  assert.match(dry.stdout, /sh-badger-0005 {2}\(from before the plugin stamped its tasks\)/);
  assert.match(dry.stdout, /5 old room task lists \(4 stamped, 1 legacy\): .*--yes deletes them/);
  for (const d of [...gone, ...Object.values(keep)]) assert.ok(exists(d), `without --yes nothing goes: ${d}`);
  assert.equal(cli(t, ['--tasks', '--yes'], null).status, 1, 'the job list unread: refused');
  for (const d of gone) assert.ok(exists(d), 'nothing deleted');
  const yes = cli(t, ['--tasks', '--yes'], jobsJson);
  assert.equal(yes.status, 0, yes.stderr);
  assert.match(yes.stdout, /deleted 5 old room task lists/);
  for (const d of gone) assert.ok(!exists(d), `deleted: ${d}`);
  for (const [why, d] of Object.entries(keep)) assert.ok(exists(d), `${why}: kept`);
  assert.match(cli(t, ['--tasks'], jobsJson).stdout, /^no old room task lists in /);
  assert.equal(cli(t, [], '[]').status, 2, 'no --tasks: the usage');
});

test('doctor: one info line while old room task lists are kept, none otherwise', t => {
  const tasks = fresh(t);
  assert.deepEqual(doctor.taskListChecks({ jobs: () => [] }), []);
  list(tasks, 'sh-badger-0001');
  list(tasks, 'sh-badger-0002', { '1.json': roomTask('badger-0002') });
  const [c, ...more] = doctor.taskListChecks({ jobs: () => [] });
  assert.ok(c);
  assert.equal(more.length, 0);
  assert.equal(c.status, 'info');
  assert.match(c.detail, /^2 old room task lists · (?:\S+=\S+ )?node \S+\/scripts\/sub-human gc --tasks$/, 'the CLI by its path (with this home named)');
  const text = doctor.format({ generated_at: '', versions: { plugin: '1', node: '1', claude: '1', protocol: { min: 5, max: 5 }, ssh: null, platform: 'p', arch: 'a', os: 'o' }, checks: [c], links: [], probe: null });
  assert.match(text, /^· task lists {2}2 old room task lists · /m);
  assert.deepEqual(doctor.taskListChecks({ jobs: () => null }), [], 'the job list unread: no count');
});
