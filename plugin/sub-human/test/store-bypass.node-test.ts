// The RoomStore seam holds: no plugin module outside lib/room/store*.ts knows where a room's state lives or what
// its files are called.
// The hooks module (mod/*.ts) is walked too: it knows no store path (mod-hello tells it the home), save the reads
// in ALLOWED below.
// Exceptions, by design: lib/home.ts (the location: home, rooms/, roomDir) and lib/identity.ts, which keeps
// this machine's session indexes (<home>/sessions/: which seat a local pid or session id holds; not room state)
// and re-exports roomDir. A bare `identity.roomDir(code);` statement only validates a code and is allowed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const PLUGIN = path.join(import.meta.dirname, '..');

function sources(): { rel: string; code: string }[] {
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
  return out.map(f => ({ rel: path.relative(PLUGIN, f), code: stripComments(fs.readFileSync(f, 'utf8')) }));
}

/** The source without comments (block and line), keeping line numbers. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .split('\n').map(l => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n');
}

const STORE = /^lib\/room\/store[^/]*\.ts$/;
/**
 * Direct reads kept on purpose, each matched by file and line. Only reads: every write still goes through the store.
 * mod/send.ts: the hooks module runs in Claude Code's module runtime, where lib/room/store.ts (node:fs) cannot load,
 * so it reads the members document with $.fs.read to tell whether a SendMessage's target seat is on another machine.
 * The alternatives cost every send to a room address a node child or a room-server round trip. The read is the
 * FsRoomStore layout (a mirror keeps the host's members document in the same file); remotePeer (mod/core/send.ts)
 * checks each field it reads, and a read that fails passes the send on to the engine unchanged.
 */
const ALLOWED = [
  { rel: 'mod/send.ts', line: /^\s*\$\.fs\.read\(`\$\{hello\.home\}\/rooms\/\$\{seat\.code\}\/members\.json`\)\.then\(parse, \(\) => null\),$/ },
];
const allowed = (rel: string, l: string): boolean => ALLOWED.some(a => a.rel === rel && a.line.test(l));
const FILE_NAMES = /['"`/][^'"`\n]*\b(log\.jsonl|log\.idx|members\.json|tasks\.json|review\.json|holds-[^'"`]*\.json|\.cursor)\b/;
const SEGMENTS = /path\.join\([^\n]*?['"`](rows|presence|plans|members|keys)['"`]/;

test('store seam: no module outside lib/room/store*.ts names a room file or builds a path into a room', () => {
  const bad: string[] = [];
  for (const { rel, code } of sources()) {
    if (STORE.test(rel)) continue;
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

test('store seam: the checks above do catch a bypass', () => {
  assert.ok(FILE_NAMES.test("fs.readFileSync(path.join(dir, 'log.jsonl'))"));
  assert.ok(FILE_NAMES.test('`${code}/members.json`'));
  assert.ok(SEGMENTS.test("path.join(identity.roomDir(code), 'rows', x)"));
  assert.ok(!FILE_NAMES.test("kv.get('tasks')"));
  assert.equal(stripComments('a // log.jsonl\nb'), 'a \nb');
});

test('store seam: each allowed read is still in its file, and the allowance covers that line only', () => {
  const src = new Map(sources().map(s => [s.rel, s.code]));
  for (const a of ALLOWED) {
    assert.equal((src.get(a.rel) || '').split('\n').filter(l => a.line.test(l)).length, 1, `${a.rel}: the allowed read is gone or moved; drop or update its ALLOWED entry`);
  }
  assert.ok(!allowed('mod/send.ts', "  $.fs.read(`${hello.home}/rooms/${seat.code}/tasks.json`).then(parse, () => null),"));
  assert.ok(!allowed('mod/deliver.ts', "  $.fs.read(`${hello.home}/rooms/${seat.code}/members.json`).then(parse, () => null),"));
});
