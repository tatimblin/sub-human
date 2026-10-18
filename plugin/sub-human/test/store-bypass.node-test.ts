// The RoomStore seam holds, structurally first: the log's bytes (lib/room/log-io.ts) are imported by
// lib/room/fs-store.ts alone, and FsRoomStore itself only by the store's own files (registry.ts opens it, store-mirror.ts
// composes it, store.ts is the seam's one import). Every other module reads and writes a room through a RoomStore.
// What an import graph cannot say is checked lexically, and only there: no module outside the store's files names a
// room file or builds a path into a room. The hooks module (mod/*.ts) is walked too: it knows no store path
// (mod-hello tells it the home), save the reads in ALLOWED below.
// Exceptions, by design: lib/home.ts (the location: home, rooms/, roomDir) and lib/identity.ts, which keeps
// this machine's session indexes (<home>/sessions/: which seat a local pid or session id holds; not room state)
// and re-exports roomDir. A bare `identity.roomDir(code);` statement only validates a code and is allowed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { must } from './support/must.ts';

const PLUGIN = path.join(import.meta.dirname, '..');

function files(): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const x of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, x.name);
      if (x.isDirectory()) { if (x.name !== 'test' && x.name !== 'node_modules') walk(p); }
      else if (/\.(m?js|ts)$/.test(x.name)) out.push(p);
    }
  };
  walk(PLUGIN);
  out.push(path.join(PLUGIN, 'scripts', 'sub-human'));
  return out;
}
const sources = (): { rel: string; code: string }[] => files().map(f => ({ rel: path.relative(PLUGIN, f), code: stripComments(fs.readFileSync(f, 'utf8')) }));

/** The source without comments (block and line), keeping line numbers. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .split('\n').map(l => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n');
}

// ---------- structure: who imports what ----------
/** The plugin files rel imports (import ... from, export ... from, import(), require(), lib/io.ts lazy), as
 * plugin-relative paths. */
function importsOf(rel: string, code: string): string[] {
  const out = new Set<string>();
  const re = /(?:\b(?:from|import|require)\s*\(?|\blazy<[^>]*>\(import\.meta\.url,)\s*['"](\.{1,2}\/[^'"]+)['"]/g;
  for (let m; (m = re.exec(code));) out.add(path.normalize(path.join(path.dirname(rel), must(m[1]))));
  // a load by a joined path: loadAt(import.meta.url, path.join(import.meta.dirname, '…', 'x.ts'))
  const joined = /path\.join\(import\.meta\.dirname((?:\s*,\s*['"][^'"]+['"])+)\)/g;
  for (let m; (m = joined.exec(code));) out.add(path.normalize(path.join(path.dirname(rel), ...[...must(m[1]).matchAll(/['"]([^'"]+)['"]/g)].map(x => must(x[1])))));
  return [...out];
}
function importers(target: string): string[] {
  return sources().filter(s => importsOf(s.rel, s.code).includes(target)).map(s => s.rel).sort();
}

/** The store's own files: the only ones that may know a room's files (lib/room/store.ts lists them). */
const STORE_FILES = ['lib/room/fs-store.ts', 'lib/room/log-io.ts', 'lib/room/watch.ts', 'lib/room/snapshot.ts', 'lib/room/keys.ts', 'lib/room/registry.ts', 'lib/room/store-mirror.ts', 'lib/room/store.ts'];

test('store seam: only lib/room/fs-store.ts imports the log\'s bytes (lib/room/log-io.ts)', () => {
  assert.deepEqual(importers('lib/room/log-io.ts'), ['lib/room/fs-store.ts']);
});

test('store seam: FsRoomStore is opened by the registry, composed by the mirror and exported by the seam, nothing else', () => {
  assert.deepEqual(importers('lib/room/fs-store.ts'), ['lib/room/registry.ts', 'lib/room/store-mirror.ts', 'lib/room/store.ts']);
  // the mirror composes a store: it never extends one, and calls no private (_name) member of it
  const mirror = stripComments(fs.readFileSync(path.join(PLUGIN, 'lib/room/store-mirror.ts'), 'utf8'));
  assert.doesNotMatch(mirror, /\bextends\s+FsRoomStore\b/);
  assert.deepEqual(mirror.match(/\blocal\._\w+/g) || [], [], 'no private member of the composed store');
});

test('store seam: the import scan finds a bypass', () => {
  assert.deepEqual(importsOf('lib/x.ts', "import * as io from './room/log-io.ts';"), ['lib/room/log-io.ts']);
  assert.deepEqual(importsOf('lib/x.ts', "const io = lazy<typeof IoMod>(import.meta.url, './room/log-io.ts');"), ['lib/room/log-io.ts']);
  assert.deepEqual(importsOf('mcp/x.ts', "const io = require('../lib/room/log-io.ts');"), ['lib/room/log-io.ts']);
  assert.deepEqual(importsOf('lib/room/x.ts', "export { readAll } from './log-io.ts';"), ['lib/room/log-io.ts']);
  assert.deepEqual(importsOf('lib/room/x.ts', "const io = await import('./log-io.ts');"), ['lib/room/log-io.ts']);
});

// ---------- what imports cannot show: names of room files and paths into a room ----------
/**
 * Direct reads kept on purpose, each matched by file and line. Only reads: every write still goes through the store.
 * mod/core/send.ts sendFiles (read by mod/send.ts and the two-home tests): the hooks module runs in Claude Code's
 * module runtime, where the store (node:fs) cannot load, so it reads the members document with $.fs.read to tell whether a SendMessage's target seat is on another machine.
 * The alternatives cost every send to a room address a node child or a room-server round trip. The read is the
 * FsRoomStore layout (a mirror keeps the host's members document in the same file); remotePeer (mod/core/send.ts)
 * checks each field it reads, and a read that fails passes the send on to the engine unchanged.
 */
const ALLOWED = [
  { rel: 'mod/core/send.ts', line: /^\s*\(\{ members: `\$\{home\}\/rooms\/\$\{code\}\/members\.json`, machine: `\$\{home\}\/machine\.json`, machines: `\$\{home\}\/machines\.json` \}\);$/ },
];
const allowed = (rel: string, l: string): boolean => ALLOWED.some(a => a.rel === rel && a.line.test(l));
const FILE_NAMES = /['"`/][^'"`\n]*\b(log\.jsonl|log\.idx|log\.moved|log-(?:\d+|\$\{[^}]*\})\.jsonl|snapshot\.json|members\.json|tasks\.json|review\.json|session\.json|holds-[^'"`]*\.json|\.cursor)\b/;
const SEGMENTS = /path\.join\([^\n]*?['"`](rows|presence|plans|members|keys)['"`]/;

test('store seam: no module outside the store\'s files names a room file or builds a path into a room', () => {
  const bad: string[] = [];
  for (const { rel, code } of sources()) {
    if (STORE_FILES.includes(rel)) continue;
    code.split('\n').forEach((l, i) => {
      const at = `${rel}:${i + 1}: ${l.trim()}`;
      if (allowed(rel, l)) return;
      if (FILE_NAMES.test(l)) bad.push(`names a room file: ${at}`);
      if (SEGMENTS.test(l)) bad.push(`builds a room path: ${at}`);
      if (/\broomDir\(/.test(l) && !['lib/home.ts', 'lib/identity.ts'].includes(rel) && !/^\s*identity\.roomDir\(\w+\);/.test(l)) bad.push(`uses roomDir: ${at}`);
    });
  }
  assert.deepEqual(bad, []);
});

test('store seam: the lexical checks do catch a bypass', () => {
  assert.ok(FILE_NAMES.test("fs.readFileSync(path.join(dir, 'log.jsonl'))"));
  assert.ok(FILE_NAMES.test('`${code}/members.json`'));
  assert.ok(SEGMENTS.test("path.join(identity.roomDir(code), 'rows', x)"));
  assert.ok(!FILE_NAMES.test("kv.get('tasks')"));
  assert.ok(FILE_NAMES.test("path.join(dir, 'snapshot.json')") && FILE_NAMES.test('`log-0001.jsonl`'), 'a segment or the snapshot');
  assert.equal(stripComments('a // log.jsonl\nb'), 'a \nb');
});

test('store seam: each allowed read is still in its file, and the allowance covers that line only', () => {
  const src = new Map(sources().map(s => [s.rel, s.code]));
  for (const a of ALLOWED) {
    assert.equal((src.get(a.rel) || '').split('\n').filter(l => a.line.test(l)).length, 1, `${a.rel}: the allowed read is gone or moved; drop or update its ALLOWED entry`);
  }
  assert.ok(!allowed('mod/core/send.ts', "  ({ members: `${home}/rooms/${code}/tasks.json`, machine: `${home}/machine.json`, machines: `${home}/machines.json` });"));
  assert.ok(!allowed('mod/deliver.ts', "  $.fs.read(`${hello.home}/rooms/${seat.code}/members.json`).then(parse, () => null),"));
});
