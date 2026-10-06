'use strict';
// Per-file test runner. `node --test plugin/sub-human/test` resolves the directory to this file (Node 24
// does not expand a directory argument), and node:test refuses a nested run() inside a test file. So this
// file starts its own `node --test` over every *.test.js under test/ (fixtures/ excluded): each file runs
// in its own process, files run in parallel, and helpers.js is preloaded into each one (temp-dir cleanup
// and CLAUDE* stripping apply even to files that never require it). Also runnable directly:
// `node plugin/sub-human/test`, or with files: `node plugin/sub-human/test test/rows.test.js`.
//
// Forwarded from the outer run: --test-name-pattern, --test-skip-pattern, --test-only,
// --test-concurrency, --test-reporter. Set SUB_HUMAN_TEST_CONCURRENCY to cap parallel files.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function find(dir) {
  const out = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory() && d.name !== 'fixtures' && d.name !== 'node_modules') out.push(...find(p));
    else if (d.isFile() && d.name.endsWith('.test.js')) out.push(p);
  }
  return out.sort();
}

const FORWARD = /^--test-(name-pattern|skip-pattern|only|concurrency|reporter)\b/;
const args = [];
const av = process.execArgv;
for (let i = 0; i < av.length; i++) {
  if (!FORWARD.test(av[i])) continue;
  args.push(av[i]);
  if (!av[i].includes('=') && av[i] !== '--test-only' && av[i + 1] && !av[i + 1].startsWith('-')) args.push(av[++i]);
}
if (process.env.SUB_HUMAN_TEST_CONCURRENCY && !args.some(a => a.startsWith('--test-concurrency'))) {
  args.push(`--test-concurrency=${process.env.SUB_HUMAN_TEST_CONCURRENCY}`);
}

const picked = process.argv.slice(2).map(f => path.resolve(f));
const files = picked.length ? picked : find(__dirname);

const env = { ...process.env };
delete env.NODE_TEST_CONTEXT; // otherwise the inner runner sees itself as a test file and runs nothing

const r = spawnSync(process.execPath, ['--test', '--require', path.join(__dirname, 'helpers.js'), ...args, ...files],
  { stdio: 'inherit', env });
if (r.error) throw r.error;
process.exitCode = r.status === null ? 1 : r.status;
