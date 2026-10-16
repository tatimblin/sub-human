import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { context } from '../checks/context.ts';

// the API the scene modules read (checks/context.ts composes it from captures, transcripts, log and cost)
const API = [
  'DEMO', 'A', 'B', 'remote', 'rowsDir', 'sessionOf', 'screens', 'home', 'home2', 'code', 'roomDir', 'log', 'members', 'roomClaudeSid', 'job', 'index', 'props', 'runStart',
  'caps', 'cap', 'capName', 'span', 'stateDir', 'st', 'stText', 'nativeTasks', 'stateFile', 'holdsAt',
  'seatFiles', 'entries', 'inSpan', 'toolUses', 'assistantIds', 'peerIn', 'wakeIn', 'chatIn', 'pullIn', 'chatTurn', 'roomClaudeTurns', 'textOf',
  'byKind', 'fmt', 'logIn', 'replyAfter', 'shownLog', 'shownVia', 'noModelTurn', 'rowUserText', 'rowReply', 'chainOk', 'cost',
];

function fixture() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-ctx-'));
  const screens = path.join(d, 'screens'), home = path.join(d, 'home'), room = path.join(home, 'rooms', 'otter-0001');
  fs.mkdirSync(path.join(screens, 'state', 'S1', '2', 'native-tasks'), { recursive: true });
  fs.mkdirSync(path.join(room, 'rows'), { recursive: true });
  const t = (s: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
  fs.writeFileSync(path.join(screens, 'index.json'), JSON.stringify([
    { scene: 'S1', session: 'sh-alice', step: 1, time: t(10), txt: 'S1-sh-alice.txt', room: 'otter-0001' },
    { scene: 'S2', session: 'sh-alice', step: 1, time: t(40), txt: 'S2-sh-alice.txt', room: 'otter-0001' },
  ]));
  fs.writeFileSync(path.join(screens, 'S1-sh-alice.txt'), 'alice pane\n');
  fs.writeFileSync(path.join(screens, 'state', 'S1', '2', 'members.json'), '{"alice":{"pid":1}}');
  fs.writeFileSync(path.join(screens, 'state', 'S1', '2', 'native-tasks', '1.json'), '{"id":"1"}');
  fs.writeFileSync(path.join(room, 'members.json'), JSON.stringify({ claude: { session_id: 'sid', job: 'job-1' } }));
  fs.writeFileSync(path.join(room, 'log.jsonl'), [
    { id: 1, at: t(5), from: 'alice', via: 'human', kind: 'member_joined', text: 'joined' },
    { id: 2, at: t(30), from: 'claude', via: 'system', kind: 'proposal', hash: 'abcdef123456', text: 'plan' },
  ].map(e => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(room, 'rows', 'notices-bob.json'), JSON.stringify({ log: [{ id: 1, via: 'mod' }] }));
  return { screens, home, t };
}

test('context: the composed API is the one the scene modules read', () => {
  const { screens, home } = fixture();
  assert.deepEqual(Object.keys(context({ screens, home })).sort(), [...API].sort());
});

test('context: captures, state, log and transcripts helpers over a small run', () => {
  const { screens, home, t } = fixture();
  const x = context({ screens, home });
  assert.equal(x.code, 'otter-0001');
  assert.equal(x.job, 'job-1');
  assert.equal(x.cap('S1', 'alice'), 'alice pane\n');
  assert.match(x.capName('S1', 'bob'), /no S1 step 1 capture of sh-bob/);
  assert.deepEqual(x.span('S2'), { from: t(10), to: t(40) });
  assert.equal(x.runStart, new Date(Date.parse(t(10)) - 180_000).toISOString());
  assert.deepEqual(x.st<unknown>('S1', 'last', 'members.json', null), { alice: { pid: 1 } });
  assert.deepEqual(x.nativeTasks('S1', 'last'), [{ id: '1' }]);
  assert.deepEqual(x.logIn(x.span('S2')).map(e => e.id), [2]);
  assert.deepEqual(x.props.map(e => e.id), [2]);
  assert.equal(x.fmt(x.byKind('proposal')[0]), '#2 claude system proposal abcdef: plan');
  assert.equal(x.shownVia('bob', 1), 'mod', 'a run before the session document: rows/notices-NAME.json');
  assert.equal(x.shownVia('alice', 1), null);
  // the seat's session document (members/NAME/session.json) is read first
  fs.mkdirSync(path.join(home, 'rooms', 'otter-0001', 'members', 'alice'), { recursive: true });
  fs.writeFileSync(path.join(home, 'rooms', 'otter-0001', 'members', 'alice', 'session.json'), JSON.stringify({ v: 1, cursor: 2, shown: { ids: [1], log: [{ id: 1, via: 'mod', at: t(6) }] } }));
  assert.equal(x.shownVia('alice', 1), 'mod');
  assert.equal(x.sessionOf('alice')?.cursor, 2);
  fs.writeFileSync(path.join(screens, 'state', 'S1', '2', 'session-claude.json'), JSON.stringify({ v: 1, holds: { members: ['alice'] } }));
  assert.deepEqual(x.holdsAt('S1', 'last', 'claude').members, ['alice']);
  assert.deepEqual(x.holdsAt('S1', 'last', 'bob'), {}, 'none saved');
  assert.deepEqual(x.inSpan([{ timestamp: t(20) }, { timestamp: t(50) }], x.span('S2')), [{ timestamp: t(20) }]);
  assert.match(x.cost(), /^≈ \$0\.00 /);
});
