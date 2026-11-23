// What only the disk backend has: its files and modes, fsync, writers in other processes, crashes and torn lines.
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import type { FsStore } from './fs-store.js';
import { openFsStore } from './fs-store.js';
import { writeAtomic } from './atomic.js';
import { parseTail } from './store.js';
import { post } from '../test/support/store-contract.js';
import { must } from '../test/support/must.js';
import { docFile, fileKey, lockFile, logFile, roomDir, snapshotFile, tailFile } from '../home.js';

const RESOLVE = path.join(import.meta.dirname, '..', 'resolve-ts.ts');
const FS_STORE = new URL('./fs-store.ts', import.meta.url).href;

async function home(): Promise<string> {
  return fs.mkdtemp(path.join(process.env.SUB_HUMAN_HOME ?? '', 'h-'));
}
async function store(h: string, o: { every?: number; now?: () => number } = {}): Promise<FsStore> {
  const r = await openFsStore({ home: h, code: 'room', ...o });
  return must(r.ok ? r.value : null, 'a store');
}
const room = (h: string): string => roomDir(h, 'room');

/** A node child running `body` with an FsStore on (home, 'room') as `s` and its argv after the home as `args`. */
function child(h: string, body: string, ...args: string[]) {
  const code = `import { openFsStore } from ${JSON.stringify(FS_STORE)};
const [home, ...args] = process.argv.slice(1);
const { value: s } = await openFsStore({ home, code: 'room' });
${body}`;
  return spawn(process.execPath, ['--import', RESOLVE, '--input-type=module', '-e', code, h, ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
}

/** Records each file handle fsynced, by path, through the fs.open every module here shares. */
function spySync(t: TestContext): string[] {
  const synced: string[] = [];
  const open = fs.open.bind(fs);
  t.mock.method(fs, 'open', async (...a: Parameters<typeof fs.open>) => {
    const fh = await open(...a);
    const sync = fh.sync.bind(fh);
    fh.sync = () => { synced.push(String(a[0])); return sync(); };
    return fh;
  });
  return synced;
}

test('the layout under rooms/CODE, private: folders 0700, files 0600', async () => {
  const h = await home();
  const s = await store(h, { every: 2, now: () => 1234 });
  await s.append(post('ann', 'a'));
  const b = await s.append(post('ann', 'b'));
  assert.ok(b.ok);
  await s.putDoc('presence', 'ann', { name: 'ann', state: 'idle', at: 1 });
  const hash = await s.putBlob('plan');
  const r = room(h);
  assert.equal((await fs.readFile(logFile(r), 'utf8')).split('\n').length, 3);
  assert.deepEqual(parseTail(await fs.readFile(tailFile(r), 'utf8')), { ok: true, value: { seq: 2, hash: b.value.hash, at: 1234 } });
  const blob = path.join(r, 'plans', `${hash}.md`);
  assert.equal(await fs.readFile(blob, 'utf8'), 'plan');
  for (const d of [path.join(h, 'rooms'), r, path.join(r, 'docs', 'presence'), path.join(r, 'plans')]) {
    assert.equal((await fs.stat(d)).mode & 0o777, 0o700, d);
  }
  for (const f of [logFile(r), tailFile(r), snapshotFile(r), docFile(r, 'presence', 'ann'), blob]) {
    assert.equal((await fs.stat(f)).mode & 0o777, 0o600, f);
  }
});

test('an empty room code opens nothing; a code in capitals has its own folder', async () => {
  const h = await home();
  assert.equal((await openFsStore({ home: h, code: '' })).ok, false);
  const big = await openFsStore({ home: h, code: 'Room' });
  assert.ok(big.ok);
  await big.value.append(post('ann', 'a'));
  await (await store(h)).append(post('bob', 'b'));
  assert.equal((await fs.readdir(path.join(h, 'rooms'))).length, 2);
  await fs.access(logFile(roomDir(h, await fileKey('Room'))));
});

test('names that differ only in case are two documents', async () => {
  const s = await store(await home());
  await s.putDoc('focus', 'Ann', { name: 'Ann', text: 'upper', at: 1 });
  await s.putDoc('focus', 'ann', { name: 'ann', text: 'lower', at: 2 });
  assert.equal((await s.getDoc('focus', 'Ann'))?.text, 'upper');
  assert.equal((await s.getDoc('focus', 'ann'))?.text, 'lower');
});

test('an append fsyncs the log line before it answers; a document its temp file', async t => {
  const h = await home();
  const s = await store(h);
  const synced = spySync(t);
  assert.ok((await s.append(post('ann', 'a'))).ok);
  assert.ok(synced.includes(logFile(room(h))), 'the log');
  assert.ok(synced.some(p => p.startsWith(`${tailFile(room(h))}.`)), 'the tail');
  synced.length = 0;
  await s.putDoc('presence', 'ann', { name: 'ann', state: 'idle', at: 1 });
  assert.ok(synced.some(p => p.startsWith(`${docFile(room(h), 'presence', 'ann')}.`)));
});

test('writeAtomic never opens its target, and syncs the temp file before the rename', async t => {
  const dir = await home();
  const file = path.join(dir, 'doc.json');
  await fs.writeFile(file, 'old');
  const ops: string[] = [];
  const { open, rename, writeFile } = { open: fs.open.bind(fs), rename: fs.rename.bind(fs), writeFile: fs.writeFile.bind(fs) };
  t.mock.method(fs, 'open', async (...a: Parameters<typeof fs.open>) => {
    const fh = await open(...a);
    ops.push(`open ${String(a[0])}`);
    const sync = fh.sync.bind(fh);
    fh.sync = () => { ops.push(`sync ${String(a[0])}`); return sync(); };
    return fh;
  });
  t.mock.method(fs, 'writeFile', (...a: Parameters<typeof fs.writeFile>) => { ops.push(`writeFile ${String(a[0])}`); return writeFile(...a); });
  t.mock.method(fs, 'rename', (from: string, to: string) => { ops.push(`rename ${from} ${to}`); return rename(from, to); });
  await writeAtomic(file, 'new');
  assert.equal(await fs.readFile(file, 'utf8'), 'new');
  const tmp = ops[0]?.slice('open '.length) ?? '';
  assert.notEqual(tmp, file);
  assert.deepEqual(ops.slice(0, 3), [`open ${tmp}`, `sync ${tmp}`, `rename ${tmp} ${file}`]);
  assert.ok(!ops.some(o => o === `open ${file}` || o === `writeFile ${file}`));
});

test('writeAtomic syncs the folder after the rename, so the rename survives a power loss', async t => {
  const dir = await home();
  const file = path.join(dir, 'doc.json');
  const ops: string[] = [];
  const { open, rename } = { open: fs.open.bind(fs), rename: fs.rename.bind(fs) };
  t.mock.method(fs, 'open', async (...a: Parameters<typeof fs.open>) => {
    const fh = await open(...a);
    if (a[0] === dir) {
      const sync = fh.sync.bind(fh);
      fh.sync = () => { ops.push('sync folder'); return sync(); };
    }
    return fh;
  });
  t.mock.method(fs, 'rename', (from: string, to: string) => { ops.push('rename'); return rename(from, to); });
  await writeAtomic(file, 'new');
  assert.deepEqual(ops, ['rename', 'sync folder']);
});

test('a write that fails before its rename leaves the old text and no temp file', async t => {
  const dir = await home();
  const file = path.join(dir, 'doc.json');
  await fs.writeFile(file, 'old');
  t.mock.method(fs, 'rename', () => Promise.reject(new Error('crash')));
  await assert.rejects(writeAtomic(file, 'new'), /crash/);
  assert.equal(await fs.readFile(file, 'utf8'), 'old');
  assert.deepEqual(await fs.readdir(dir), ['doc.json']);
});

test('an append does not read the log when another handle already took the snapshot', async t => {
  const h = await home();
  const a = await store(h, { every: 5 });
  const b = await store(h, { every: 5 });
  for (let i = 0; i < 5; i++) assert.ok((await a.append(post('ann', `${i}`))).ok);
  const reads: string[] = [];
  const readFile = fs.readFile.bind(fs);
  t.mock.method(fs, 'readFile', (...x: Parameters<typeof fs.readFile>) => { reads.push(String(x[0])); return readFile(...x); });
  assert.ok((await b.append(post('bob', 'x'))).ok); // b's guess: no snapshot yet, so one is due
  assert.deepEqual(reads.filter(p => p === logFile(room(h))), []);
});

test('writers in several processes share one chain under the lock', async () => {
  const h = await home();
  const kids = Array.from({ length: 4 }, (_, i) => child(h, `for (let j = 0; j < 25; j++) {
  const r = await s.append({ kind: 'post', id: args[0] + '-' + j, at: j, from: args[0], by: 'person', machine: 'm', text: String(j) });
  if (!r.ok) process.exit(1);
}`, `w${i}`));
  const codes = await Promise.all(kids.map(k => new Promise<number | null>(res => k.on('exit', res))));
  assert.deepEqual(codes, [0, 0, 0, 0]);
  const all = await (await store(h)).read(0);
  assert.ok(all.ok);
  assert.deepEqual(all.value.map(l => l.entry.seq), Array.from({ length: 100 }, (_, i) => i + 1));
  assert.equal(new Set(all.value.map(l => l.entry.id)).size, 100);
});

test('a writer killed mid-write leaves a whole document and a log that still chains', async () => {
  const h = await home();
  const s = await store(h);
  const file = docFile(room(h), 'activity', 'ann');
  for (let round = 0; round < 2; round++) {
    const k = child(h, `for (let i = 0; ; i++) {
  await s.putDoc('activity', 'ann', { name: 'ann', files: Array(800).fill(String(i).repeat(100)), at: i });
  if (i % 10 === 0) await s.append({ kind: 'post', id: 'p' + i, at: i, from: 'ann', by: 'person', machine: 'm', text: 'x'.repeat(4000) });
}`);
    const whole = async (when: string): Promise<void> => {
      const doc = await s.getDoc('activity', 'ann');
      assert.ok(doc, `round ${round}, ${when}: the document reads`);
      assert.deepEqual(doc.files, Array(800).fill(String(doc.at).repeat(100)));
    };
    try {
      while (!(await fs.access(file).then(() => true, () => false))) await sleep(5);
      for (let i = 0; i < 40; i++) { await whole('while written'); await sleep(Math.random() * 2); }
    } finally {
      k.kill('SIGKILL');
      await once(k, 'exit');
    }
    await whole('after the kill');
    assert.equal((await s.read(0)).ok, true, `round ${round}: the chain holds`);
    await fs.rm(lockFile(room(h)), { force: true }); // the killed child may have held it
  }
});

test('a torn last line is skipped by readers and dropped by the next append', async () => {
  const h = await home();
  const s = await store(h);
  await s.append(post('ann', 'a'));
  await fs.appendFile(logFile(room(h)), '{"seq":2,"prev":"');
  const r = await s.read(0);
  assert.ok(r.ok);
  assert.equal(r.value.length, 1);
  const b = await s.append(post('ann', 'b'));
  assert.ok(b.ok);
  assert.equal(b.value.entry.seq, 2);
  const again = await s.read(0);
  assert.ok(again.ok);
  assert.deepEqual(again.value.map(l => l.entry.seq), [1, 2]);
});
