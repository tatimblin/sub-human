'use strict';
// lib/io.js, lib/lock.js, lib/config.js, lib/text.js: the shared helpers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const h = require('./helpers.js');
const io = require(path.join(h.LIB, 'io.js'));
const lock = require(path.join(h.LIB, 'lock.js'));
const config = require(path.join(h.LIB, 'config.js'));
const text = require(path.join(h.LIB, 'text.js'));

test('text.clip counts code points and never splits a surrogate pair; oneLine', () => {
  assert.equal(text.clip('abcdef', 6), 'abcdef');
  assert.equal(text.clip('abcdefg', 6), 'abcde…');
  assert.equal(text.clip('😀😀😀', 3), '😀😀😀', 'three code points fit in 3');
  assert.equal(text.clip('😀😀😀😀', 3), '😀😀…');
  assert.equal(text.oneLine('  a \n\t b  '), 'a b');
  assert.equal(text.oneLine(null), '');
  assert.ok(text.CODE_RE.test('otter-4821') && !text.CODE_RE.test('otter-48'));
  assert.ok(text.NAME_RE.test('bob.x_1-2') && !text.NAME_RE.test('a b'));
  assert.ok(!text.SID_SAFE.test('../x'));
});

test('config.envMs: unset, empty, junk, negative and 0 give the fallback; allowZero takes 0', () => {
  const k = 'SUB_HUMAN_TEST_ENVMS';
  const at = v => { if (v === undefined) delete process.env[k]; else process.env[k] = v; return config.envMs(k, 7); };
  try {
    assert.equal(at(undefined), 7);
    assert.equal(at(''), 7);
    assert.equal(at('abc'), 7);
    assert.equal(at('-5'), 7);
    assert.equal(at('0'), 7);
    assert.equal(at('250'), 250);
    process.env[k] = '0';
    assert.equal(config.envMs(k, 7, { allowZero: true }), 0);
  } finally { delete process.env[k]; }
});

test('io.writeJsonAtomic: new files are 0600, an existing file keeps its mode, an explicit mode wins', () => {
  const dir = h.tmpDir('sh-io-');
  const f = path.join(dir, 'a', 'x.json');
  io.writeJsonAtomic(f, { a: 1 });
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(f, 'utf8'), '{\n  "a": 1\n}\n');
  fs.chmodSync(f, 0o640);
  io.writeJsonAtomic(f, { a: 2 }, { compact: true, fsync: true });
  assert.equal(fs.statSync(f).mode & 0o777, 0o640);
  assert.equal(fs.readFileSync(f, 'utf8'), '{"a":2}');
  io.writeFileAtomic(f, 'x', { mode: 0o755 });
  assert.equal(fs.statSync(f).mode & 0o777, 0o755);
  assert.deepEqual(fs.readdirSync(path.dirname(f)), ['x.json'], 'no temp file left');
  assert.equal(io.readJson(path.join(dir, 'missing.json'), 'fb'), 'fb');
  assert.equal(io.isAlive(process.pid), true);
  assert.equal(io.isAlive(0), false);
});

test('lock: owner body, stale dead-pid and reused-pid locks are broken, a live owner is not', async () => {
  const dir = h.tmpDir('sh-lock-');
  const L = path.join(dir, 'x.lock');
  const body = lock.withLock(L, () => fs.readFileSync(L, 'utf8'));
  const o = lock.parseOwner(body);
  assert.equal(o.pid, process.pid);
  assert.equal(o.host, os.hostname());
  assert.ok(Math.abs(o.start - lock.pidStart(process.pid)) <= config.LOCK_START_SLACK_S, 'start matches ps');
  assert.equal(fs.existsSync(L), false, 'released');

  const dead = await h.deadPid();
  fs.writeFileSync(L, `${dead} ${os.hostname()} 0`);
  assert.equal(lock.withLock(L, () => 'ran'), 'ran', 'a dead owner is broken at once');

  fs.writeFileSync(L, `${process.ppid} ${os.hostname()} 12345`); // live pid, wrong start: reused
  assert.equal(lock.withLock(L, () => 'ran'), 'ran', 'a reused pid is broken');

  const sleeper = h.spawnSleeper(30);
  await h.sleep(100);
  fs.writeFileSync(L, `${sleeper.pid} ${os.hostname()} ${lock.pidStart(sleeper.pid)}`);
  const t0 = Date.now();
  assert.throws(() => lock.withLock(L, () => 'ran', { timeoutMs: 200 }), e => e.code === 'LOCK');
  assert.ok(Date.now() - t0 >= 200);
  assert.ok(fs.existsSync(L), 'a live owner keeps its lock');
  fs.unlinkSync(L);
  sleeper.kill();

  fs.mkdirSync(L); // a legacy directory lock, old: broken by age
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(L, old, old);
  assert.equal(lock.withLock(L, () => 'ran', { staleMs: 5000 }), 'ran');
  assert.deepEqual(fs.readdirSync(dir), [], 'no .break or .stale files left');
});

test('lock: processes racing a planted stale lock never assign the same log id', async () => {
  const dir = h.tmpDir('sh-lockrace-');
  const dead = await h.deadPid();
  fs.writeFileSync(path.join(dir, 'log.jsonl.lock'), `${dead} ${os.hostname()} 0`);
  const script = `process.env.ROOM_DIR=${JSON.stringify(dir)};const r=require(${JSON.stringify(path.join(h.LIB, 'room.js'))});`
    + `const t=Number(process.argv[1]);while(Date.now()<t){}for(let i=0;i<15;i++)r.append({kind:'say',text:'x'+i},{via:'human',from:'alice'});`;
  const start = Date.now() + 500;
  await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ['-e', script, String(start)], { env: h.childEnv(), stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    c.stderr.on('data', d => { err += d; });
    c.on('exit', code => (code === 0 ? resolve() : reject(new Error(err))));
  })));
  const ids = fs.readFileSync(path.join(dir, 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l).id);
  assert.equal(ids.length, 90);
  assert.equal(new Set(ids).size, 90, 'no duplicate ids');
  assert.deepEqual(ids, ids.slice().sort((a, b) => a - b));
});
