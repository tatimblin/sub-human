'use strict';
// The RoomStore contract (lib/room/store.js), run against FsRoomStore (the room directory) and MemoryRoomStore
// (test/support/memory-store.js): append, ids and the prev chain, signed human entries, readView parity, watch and
// tailer, chain checks, cursors, members compare-and-set (across processes for the file store), blobs and the
// small documents. Both passing is what lets a room move off this machine behind the same interface.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const h = require('./helpers.js');
const store = require(path.join(h.LIB, 'room', 'store.js'));
const room = require(path.join(h.LIB, 'room.js'));
const config = require(path.join(h.LIB, 'config.js'));
const { MemoryRoomStore } = require('./support/memory-store.js');

const CODE = 'otter-1234';
const BACKENDS = {
  fs: {
    make: t => store.open(CODE, { dir: h.tmpDir('sh-store-', t) }),
    // replace line i (0-based) of the log
    tamper: (s, i, fn) => {
      const lines = fs.readFileSync(path.join(s.dir, 'log.jsonl'), 'utf8').split('\n').filter(Boolean);
      lines[i] = fn(lines[i]);
      fs.writeFileSync(path.join(s.dir, 'log.jsonl'), lines.join('\n') + '\n');
    },
  },
  memory: {
    make: () => new MemoryRoomStore(CODE),
    tamper: (s, i, fn) => { s._lines[i] = fn(s._lines[i]); },
  },
};

const say = (s, from, text, via = 'human') => s.append({ kind: 'say', text }, { via, from });
const sys = (s, kind, from, extra = {}) => s.append({ kind, text: `${from} ${kind}`, ...extra }, { via: 'system', from, system: true });

for (const [name, B] of Object.entries(BACKENDS)) {
  test(`store contract (${name}): append assigns rising ids and chains prev; reads agree`, t => {
    h.freshHome(t);
    const s = B.make(t);
    assert.deepEqual(s.readAll(), []);
    assert.equal(s.lastId(), 0);
    const a = say(s, 'alice', 'one');
    const b = s.append({ kind: 'status', text: 'two' }, { via: 'agent', from: 'bob' });
    const c = s.append({ kind: 'task_req', text: 'task add: x', op: 'add', subject: 'x' }, { via: 'agent', from: 'bob' });
    assert.deepEqual([a.id, b.id, c.id], [1, 2, 3]);
    assert.equal(a.prev, store.hash12(''));
    assert.equal(c.by, 'bob', 'task_req gets by = from');
    for (const [k, v] of Object.entries({ from: 'alice', via: 'human', kind: 'say', to: 'room', text: 'one' })) assert.equal(a[k], v);
    assert.ok(Date.parse(a.at) <= Date.now());
    const all = s.readAll();
    assert.deepEqual(all.map(e => e.id), [1, 2, 3]);
    assert.equal(all[1].prev, store.hash12(JSON.stringify(all[0])), 'prev = hash12 of the previous stored line');
    assert.equal(s.lastId(), 3);
    assert.deepEqual(s.readById([3, 1, 9]).map(e => e.id), [3, 1]);
    assert.deepEqual(s.since(1).map(e => e.id), [2, 3]);
    assert.deepEqual(s.readAfter(0, e => e.via === 'agent').map(e => e.id), [2, 3]);
  });

  test(`store contract (${name}): human entries are signed with the seat key; agents are rate limited; bad entries refused`, t => {
    h.freshHome(t);
    const s = B.make(t);
    const e = say(s, 'alice', 'mine');
    assert.equal(e.room, CODE);
    assert.equal(typeof e.sig, 'string');
    assert.equal(store.humanTrust(s.readAll()[0]), 'verified');
    assert.equal(store.unverifiedHuman(s.readAll()[0]), false);
    assert.throws(() => s.append({ kind: 'nope' }, { via: 'agent', from: 'bob' }), e2 => e2.code === 'INVALID');
    for (let i = 0; i < config.RATE_MAX; i++) say(s, 'bob', `p${i}`, 'agent');
    assert.throws(() => say(s, 'bob', 'one too many', 'agent'), e2 => e2.code === 'RATE');
    assert.throws(() => s.append({ kind: 'say', text: 'x'.repeat(config.LOG_LINE_MAX_BYTES) }, { via: 'system', from: 'room', system: true }), e2 => e2.code === 'INVALID');
    assert.equal(s.lastId(), 1 + config.RATE_MAX, 'nothing refused was written');
  });

  test(`store contract (${name}): readView({after}) holds every non-chat entry, every entry after, and retract targets`, t => {
    h.freshHome(t);
    const s = B.make(t);
    sys(s, 'member_joined', 'alice');           // 1
    say(s, 'alice', 'early chat');              // 2
    say(s, 'bob', 'forged');                    // 3
    s.append({ kind: 'proposal', text: 'p', hash: 'abcdef012345', approvers: ['alice'] }, { via: 'agent', from: 'bob' }); // 4
    say(s, 'alice', 'later chat');              // 5
    sys(s, 'retract', 'bob', { refs: [3] });    // 6
    say(s, 'bob', 'latest');                    // 7
    const all = s.readAll();
    for (const after of [0, 2, 4, 6, 7, Infinity]) {
      const want = all.filter(e => !(after > 0) || !store.CHAT_KINDS.has(e.kind) || e.id > after || e.id === 3).map(e => e.id);
      assert.deepEqual(s.readView({ after }).map(e => e.id), want, `after ${after}`);
    }
    assert.deepEqual(s.readView({ after: 4 }).filter(e => e.id > 4), all.filter(e => e.id > 4), 'the same entries as readAll after `after`');
  });

  test(`store contract (${name}): watch delivers ids after \`after\` then new ones; a tailer only what is appended later`, async t => {
    h.freshHome(t);
    const s = B.make(t);
    say(s, 'alice', 'a'); say(s, 'alice', 'b');
    const tl = s.tailer();
    const got = [];
    const stop = s.watch(e => got.push(e.id), { after: 1, intervalMs: 10 });
    say(s, 'alice', 'c');
    await h.until(() => got.length === 2, 2000, 10);
    stop();
    assert.deepEqual(got, [2, 3]);
    const p = tl.poll();
    assert.deepEqual(p.entries.map(e => e.id), [3]);
    assert.equal(p.reset, false);
    assert.deepEqual(tl.poll().entries, []);
  });

  test(`store contract (${name}): validateChain and verifyChain find a changed line; verifyChain is incremental`, t => {
    h.freshHome(t);
    const s = B.make(t);
    for (let i = 0; i < 4; i++) say(s, 'alice', `m${i}`);
    assert.deepEqual(s.validateChain(), { ok: true, count: 4 });
    const v1 = s.verifyChain();
    assert.equal(v1.ok, true);
    assert.equal(v1.checked, 4);
    say(s, 'alice', 'm4');
    const v2 = s.verifyChain();
    assert.equal(v2.ok, true);
    assert.equal(v2.checked, 1, 'only the new line');
    B.tamper(s, 2, l => l.replace('"m2"', '"M2"'));
    const bad = s.validateChain();
    assert.equal(bad.ok, false);
    assert.equal(bad.badAt, 4, 'the entry after the changed one no longer chains');
    assert.equal(s.verifyChain().ok, true, 'lines before the checkpoint are trusted (validateChain re-checks them all)');
    B.tamper(s, 4, l => l.replace(/"prev":"[0-9a-f]+"/, '"prev":"000000000000"'));
    const v3 = s.verifyChain();
    assert.equal(v3.ok, false, 'the checkpoint line changed: re-checked from the start');
    assert.equal(v3.badAt, 4);
  });

  test(`store contract (${name}): cursors default to 0, persist, and refuse unsafe names`, t => {
    h.freshHome(t);
    const s = B.make(t);
    assert.equal(s.getCursor('tail-alice'), 0);
    s.setCursor('tail-alice', 7);
    assert.equal(s.getCursor('tail-alice'), 7);
    assert.equal(s.getCursor('tail-bob'), 0);
    assert.throws(() => s.setCursor('../x', 1), e => e.code === 'INVALID');
  });

  test(`store contract (${name}): members read/update: atomic, null writes nothing, reads are copies`, t => {
    h.freshHome(t);
    const s = B.make(t);
    assert.deepEqual(s.members.read(), {});
    assert.deepEqual(s.members.update(ms => ({ ...ms, alice: { name: 'alice', role: 'member' } })), { alice: { name: 'alice', role: 'member' } });
    assert.equal(s.members.update(() => null), null);
    const r = s.members.read();
    r.alice.role = 'changed';
    assert.equal(s.members.read().alice.role, 'member', 'mutating a read changes nothing stored');
    s.members.update(ms => { ms.bob = { name: 'bob' }; return ms; });
    assert.deepEqual(Object.keys(s.members.read()).sort(), ['alice', 'bob']);
  });

  test(`store contract (${name}): blobs: room-relative refs, bytes back exactly, legacy absolute paths read by name`, t => {
    h.freshHome(t);
    const s = B.make(t);
    const bytes = Buffer.from('# plan\né\n', 'utf8');
    const ref = s.blobs.put('plans/abcdef012345.md', bytes);
    assert.equal(ref, 'plans/abcdef012345.md');
    assert.ok(s.blobs.has(ref));
    assert.ok(s.blobs.get(ref).equals(bytes));
    assert.equal(s.blobs.ref('/old/home/rooms/otter-1234/plans/abcdef012345.md'), ref, 'an older entry\'s absolute path');
    assert.ok(s.blobs.get('/old/home/rooms/otter-1234/plans/abcdef012345.md').equals(bytes));
    assert.equal(s.blobs.get('plans/missing.md'), null);
    assert.equal(s.blobs.ref('../etc/passwd'), null);
    assert.throws(() => s.blobs.put('../x', bytes), e => e.code === 'INVALID');
  });

  test(`store contract (${name}): kv: get/set/update/delete/list, update undefined keeps and null deletes`, t => {
    h.freshHome(t);
    const s = B.make(t);
    assert.equal(s.kv.get('tasks'), null);
    assert.deepEqual(s.kv.get('tasks', []), []);
    s.kv.set('tasks', [{ id: '1' }]);
    assert.deepEqual(s.kv.get('tasks'), [{ id: '1' }]);
    assert.equal(s.kv.update('presence/alice', cur => { assert.equal(cur, null); return undefined; }), undefined);
    assert.equal(s.kv.get('presence/alice'), null, 'undefined: nothing written');
    s.kv.update('presence/alice', () => ({ state: 'idle' }));
    s.kv.set('presence/bob', { state: 'working' });
    s.kv.set('members/alice/review', { phase: 'shown' });
    assert.deepEqual(s.kv.list('presence/'), ['presence/alice', 'presence/bob']);
    assert.deepEqual(s.kv.update('presence/alice', cur => ({ ...cur, at: 1 })), { state: 'idle', at: 1 });
    assert.equal(s.kv.update('presence/bob', () => null), null);
    assert.deepEqual(s.kv.list('presence/'), ['presence/alice']);
    s.kv.delete('presence/alice');
    assert.deepEqual(s.kv.list('presence/'), []);
    assert.equal(s.kv.lock('tasks', () => 'ran'), 'ran');
    assert.equal(s.lock('proposal', () => 'ran'), 'ran');
    assert.throws(() => s.kv.get('../x'), e => e.code === 'INVALID');
    assert.throws(() => s.kv.list('presence'), e => e.code === 'INVALID');
  });

  test(`store contract (${name}): a Room over the store renders and queries this room only`, t => {
    h.freshHome(t);
    const s = B.make(t);
    s.members.update(() => ({ alice: { name: 'alice', role: 'member' }, bob: { name: 'bob', role: 'member', left_at: new Date().toISOString() } }));
    const r = room.open(CODE, { store: s });
    r.append({ kind: 'proposal', text: 'proposal abcdef012345: x', hash: 'abcdef012345', approvers: ['alice'] }, { via: 'agent', from: 'bob' });
    assert.equal(r.proposals().length, 1);
    assert.match(r.stateLine({ name: 'alice' }), /^room now: proposal abcdef .* · you: answer needed .* · away: bob$/);
    assert.match(r.digest(), new RegExp(`## members of ${CODE}`));
    assert.equal(r.lane({ name: 'alice', role: 'member' }, r.readAll()[0], r.readAll()), 'push');
  });
}

test('store contract (fs): members.update is atomic across processes (no lost update)', async t => {
  h.freshHome(t);
  const dir = h.tmpDir('sh-store-cas-', t);
  const N = 6, K = 15;
  const script = `const s=require(${JSON.stringify(path.join(h.LIB, 'room', 'store.js'))}).open(${JSON.stringify(CODE)},{dir:${JSON.stringify(dir)}});`
    + `const t=Number(process.argv[1]);while(Date.now()<t){}for(let i=0;i<${K};i++)s.members.update(m=>{m.n=(m.n||0)+1;m['p'+process.pid]=(m['p'+process.pid]||0)+1;return m;});`;
  const start = Date.now() + 400;
  await Promise.all(Array.from({ length: N }, () => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ['-e', script, String(start)], { env: h.childEnv(), stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    c.stderr.on('data', d => { err += d; });
    c.on('exit', code => (code === 0 ? resolve() : reject(new Error(err))));
  })));
  const m = store.open(CODE, { dir }).members.read();
  assert.equal(m.n, N * K);
  assert.equal(Object.keys(m).filter(k => k.startsWith('p')).length, N);
});

test('store contract (memory): members.update retries when another writer got in first (compare-and-set)', () => {
  const s = new MemoryRoomStore(CODE);
  let calls = 0;
  s.members.update(ms => {
    calls++;
    if (calls === 1) s.members.update(x => ({ ...x, other: 1 })); // a concurrent writer between read and write
    return { ...ms, mine: 1 };
  });
  assert.equal(calls, 2, 'fn ran again on the newer version');
  assert.deepEqual(s.members.read(), { other: 1, mine: 1 });
});

test('store: setBackend routes every open() (identity included) to another store', t => {
  h.freshHome(t);
  const mem = new MemoryRoomStore(CODE);
  store.setBackend(() => mem);
  try {
    const identity = require(path.join(h.LIB, 'identity.js'));
    mem.members.update(() => ({ alice: { name: 'alice', role: 'member', seen_at: new Date().toISOString() } }));
    assert.deepEqual(Object.keys(identity.readMembers(CODE)), ['alice']);
    assert.equal(identity.seatAlive(identity.readMembers(CODE).alice), true, 'no pid: the lease decides');
    identity.writePresence(CODE, 'alice', 'idle');
    assert.equal(identity.readPresence(CODE).alice.state, 'idle');
    assert.equal(room.open(CODE).store, mem);
  } finally { store.setBackend(null); }
});
