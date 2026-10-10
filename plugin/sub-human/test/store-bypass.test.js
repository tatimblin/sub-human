'use strict';
// The RoomStore seam holds: no plugin module outside lib/room/store*.js knows where a room's state lives or what
// its files are called.
// The hooks module (mod/*.mjs) is walked too: it knows no store path (mod-hello tells it the home).
// Exceptions, by design: lib/home.ts (the location: home, rooms/, roomDir) and lib/identity.ts, which keeps
// this machine's session indexes (<home>/sessions/: which seat a local pid or session id holds; not room state)
// and re-exports roomDir. A bare `identity.roomDir(code);` statement only validates a code and is allowed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN = path.join(__dirname, '..');

function sources() {
  const out = [];
  const walk = d => {
    for (const x of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, x.name);
      if (x.isDirectory()) { if (x.name !== 'test' && x.name !== 'node_modules') walk(p); }
      else if (x.name.endsWith('.js') || x.name.endsWith('.mjs')) out.push(p);
    }
  };
  walk(PLUGIN);
  out.push(path.join(PLUGIN, 'scripts', 'sub-human'));
  return out.map(f => ({ rel: path.relative(PLUGIN, f), code: stripComments(fs.readFileSync(f, 'utf8')) }));
}

/** The source without comments (block and line), keeping line numbers. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .split('\n').map(l => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n');
}

const STORE = /^lib\/room\/store[^/]*\.js$/;
const FILE_NAMES = /['"`/][^'"`\n]*\b(log\.jsonl|log\.idx|members\.json|tasks\.json|review\.json|holds-[^'"`]*\.json|\.cursor)\b/;
const SEGMENTS = /path\.join\([^\n]*?['"`](rows|presence|plans|members|keys)['"`]/;

test('store seam: no module outside lib/room/store*.js names a room file or builds a path into a room', () => {
  const bad = [];
  for (const { rel, code } of sources()) {
    if (STORE.test(rel)) continue;
    code.split('\n').forEach((l, i) => {
      const at = `${rel}:${i + 1}: ${l.trim()}`;
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
