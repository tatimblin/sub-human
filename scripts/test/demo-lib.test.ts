import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { COMMANDS, opts, listsRoomClaude, keyDelays, paneBelow, newMatches, taskFor } from '../demo-lib.ts';
import { panelRows, rowViewLine, hereNames, footerMode, subagentRows, roomStatus, oneRoomRow } from '../lib/panes.ts';
import { subagents, holdingRow, isRoomRow, isChatRow, isKeeper, rowHolds, rowHeld, rowStrays, rowKeepers, KEEPERS_MAX, drawnIn } from '../checks/transcripts.ts';
import { runInfo } from '../checks/context.ts';
import { parseJson } from '../lib/io.ts';

const LIB = path.join(import.meta.dirname, '..', 'demo-lib.ts');
const DEMO_SH = path.join(import.meta.dirname, '..', 'demo.sh');
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'sh-demolib-'));
const lib = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, [LIB, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
const readJson = <T = unknown>(f: string): T => parseJson<T>(fs.readFileSync(f, 'utf8'));

test('demo-lib: every subcommand demo.sh calls is a command', () => {
  const used = new Set([...fs.readFileSync(DEMO_SH, 'utf8').matchAll(/\$LIB ([a-z-]+)/g)].flatMap(m => m[1] ?? []));
  assert.ok(used.size > 20);
  for (const c of used) assert.ok(Object.hasOwn(COMMANDS, c), `demo.sh calls ${c}`);
});

test('demo-lib: film typing paces a long line to about 4.5 s, a short one key by key; wait-pane --below reads under a line', () => {
  const long = keyDelays('x'.repeat(300)).reduce((a, b) => a + b, 0);
  assert.ok(long > 3500 && long < 5500, `${long} ms`);
  const short = keyDelays('@room hi, bob');
  assert.equal(short.length, 13);
  assert.ok(short.every(d => d >= 7 && d <= 140), short.join(' '));
  assert.equal(paneBelow('a\n! npm test --silent\n# fail 1\n! npm test --silent\n# fail 0', 'npm test --silent'), '# fail 0');
  assert.equal(paneBelow('no run here', 'npm test --silent'), '');
  assert.equal(paneBelow('all', undefined), 'all');
});

test('demo.sh --film: the story scenes only, S6b defined, every mark has a short caption', () => {
  const sh = fs.readFileSync(DEMO_SH, 'utf8');
  assert.match(sh, /\[ "\$FILM" = 1 \] && ALL=\(S1 S2 S3 S4 S5 S6b S10\)/);
  assert.match(sh, /^S6b\(\) \{/m);
  const marks = [...sh.matchAll(/^\s*mark ([a-z]+) "([^"]*)"/gm)];
  assert.ok(marks.length >= 15, `${marks.length} marks`);
  for (const [, beat, caption = ''] of marks) assert.ok(caption.length > 0 && caption.length <= 80, `caption for ${beat}: ${caption}`);
});

test('demo-lib: wait-pane --new takes only a summary the pane did not show before; demo.sh\'s PASS6b reads a real run', () => {
  const sh = fs.readFileSync(DEMO_SH, 'utf8');
  const src = (/^PASS6b='([^']+)'/m.exec(sh) ?? [])[1] ?? '';
  // the end of a ! git pull && npm test in a 36-row pane (Claude Code 2.1.292): the typed line has scrolled off
  const sum = (ms: string): string => `     ✔ GET /health (16.5ms)\n     ℹ tests 32\n     ℹ suites 0\n     ℹ pass 32\n     ℹ fail 0\n     ℹ cancelled 0\n     ℹ skipped 0\n     ℹ todo 0\n     ℹ duration_ms ${ms}\n`;
  const before = `⏺ Bash(npm test)\n${sum('90.2')}\n⏺ All pass.\n❯ \n`;
  assert.deepEqual(newMatches(src, before, before), []);
  const after = `${sum('90.2')}\n⏺ All pass.\n${sum('497.934875')}\n⏺ This pull added 24 more test files.\n❯ \n`;
  const got = newMatches(src, before, after);
  assert.equal(got.length, 1);
  assert.match(got[0] ?? '', /duration_ms 497\.934875$/);
  assert.deepEqual(newMatches(src, '', sum('1.2').replace('fail 0', 'fail 1')), []);
  assert.deepEqual(newMatches(src, '', 'ℹ pass 3\nℹ fail 0\n'), []); // cut off: not the whole summary yet
  assert.match(sh, /^RUN6b="git pull && npm test"$/m);
});

test('demo-lib taskFor: the task the room\'s Claude added for a person\'s add request, after an id', () => {
  const log = [
    { id: 3, kind: 'task_req', from: 'alice', op: 'add', subject: 'Paging handler', owner: 'alice' },
    { id: 4, kind: 'task_req', from: 'alice', op: 'add', subject: 'Paging tests', owner: 'bob' },
    { id: 5, kind: 'task', from: 'claude', op: 'add', task_id: '2', subject: 'Paging handler', req: 3 },
    { id: 7, kind: 'task_req', from: 'bob', op: 'claim', task_id: '2', owner: 'bob' },
  ];
  assert.equal(taskFor(log, 'alice', 2), '2');
  assert.equal(taskFor(log, 'bob', 2), null); // asked, not applied yet
  assert.equal(taskFor([...log, { id: 6, kind: 'task', op: 'add', task_id: '3', req: 4 }], 'bob', 2), '3');
  assert.equal(taskFor(log, 'alice', 3), null); // only requests after the id
});

test('panes: an opened room row\'s own line and who it names; a Claude\'s own subagent rows (Claude Code 2.1.296)', () => {
  // alice after ↓ Enter on the room row (0.6.0): the row's view, its hold's line leading with who else is here, wrapped
  const open = '❯ room: egret-7989\n\n⏺ room - hold (MCP)(room: "egret-7989")\n  ⎿  bob (working) here · bob: sure, once we\'ve agreed how paging works · read-only ·\n     talk in main (@room)\n\n─── egret-7989 ─\n❯ Message @sub-human:room…\n────\n  ◯ main\n❯ ⏺ egret-7989  +bob joined · bob here\n';
  assert.equal(rowViewLine(open, 'egret-7989'), 'bob (working) here · bob: sure, once we\'ve agreed how paging works · read-only · talk in main (@room)');
  assert.deepEqual(hereNames(rowViewLine(open, 'egret-7989')), ['bob']);
  assert.equal(rowViewLine(open, 'swan-6397'), null);
  assert.equal(rowViewLine('  ⏺ main\n  ◯ egret-7989  bob here\n', 'egret-7989'), null); // not opened
  // the status line's text: a join first, then who is here; more than three; nobody else
  assert.deepEqual(hereNames('+bob joined · bob here · tasks 1 open'), ['bob']);
  assert.deepEqual(hereNames('alice, bob (stalled: rate_limit), carol +2 here'), ['alice', 'bob', 'carol']);
  assert.deepEqual(hereNames('only you · paging v1 draft'), []);
  assert.equal(hereNames('2 here'), null);
  assert.equal(hereNames('proposal paging 1/2 agreed'), null);
  const rows = panelRows(open);
  assert.equal(rows.filter(r => r.label === 'egret-7989').length, 1);
  assert.ok(!rows.some(r => r.nested));
  assert.deepEqual(subagentRows(open, 'egret-7989'), []);
  const sub = '  ⏺ main\n  ◯ egret-7989  +alice joined · 2 here\n  ◯ Explore  Explain GET /tasks flow                     4s · ↓ 19.3k tokens\n';
  assert.deepEqual(subagentRows(sub, 'egret-7989').map(r => [r.label, r.text.split('  ')[0]]), [['Explore', 'Explain GET /tasks flow']]);
});

test('panes: the 0.8.0 chat row: main\'s status line, one row with only its keeper nested (Claude Code 2.1.296)', () => {
  const view = 'only you\nbob joined\nyou: row test one\n✻ Waiting for 1 background agent to finish\n────── @tapir-0763 ─\n❯ Message @tapir-0763…\n──────\n  ⚠ sub-human: tapir-0763 · bob here · 1 new\n  ↑/↓ to select · ctrl+x ctrl+k to stop all agents\n\n  ◯ main\n❯ ⏺ tapir-0763          type here                                    3s · ↓ 3.7k tokens\n  └ ◯ sub-human:keeper  Holding room row tapir-0763                  2m 9s · ↓ 8 tokens\n';
  assert.equal(roomStatus(view, 'tapir-0763'), 'bob here · 1 new');
  assert.deepEqual(hereNames(roomStatus(view, 'tapir-0763')), ['bob']);
  assert.equal(roomStatus(view, 'swan-6397'), null);
  assert.equal(roomStatus('  ⚠ sub-human: tapir-0763 · bob (working), carol here\n', 'tapir-0763'), 'bob (working), carol here');
  assert.deepEqual(oneRoomRow(panelRows(view), 'tapir-0763'), { ok: true, why: '1 tapir-0763 row(s)' });
  // collapsed: the keeper is the row's "(+1)"
  assert.equal(oneRoomRow(panelRows('  ⏺ main\n  ◯ tapir-0763 (+1)  type here\n'), 'tapir-0763').ok, true);
  assert.equal(oneRoomRow(panelRows(`${view}  └ ◯ bob  working\n`), 'tapir-0763').ok, false);
  assert.equal(oneRoomRow(panelRows(`${view}  ◯ tapir-0763  type here\n`), 'tapir-0763').ok, false);
  assert.equal(oneRoomRow(panelRows('  ⏺ main\n'), 'tapir-0763').ok, false);
  assert.equal(rowViewLine(view, 'tapir-0763'), null); // no hold's line: the chat has none
});

test('panes footerMode: the permission mode a footer shows (default: none named, a prompt box drawn)', () => {
  const box = (foot: string): string => `⏺ done\n\n────────────────────\n❯ \n────────────────────\n  ${foot}\n`;
  assert.equal(footerMode(box('⏵⏵ auto mode on · ← 1 agent · ↓ to manage')), 'auto');
  assert.equal(footerMode(box('⏵⏵ accept edits on (shift+tab to cycle)')), 'acceptEdits');
  assert.equal(footerMode(box('⏸ plan mode on (shift+tab to cycle)')), 'plan');
  assert.equal(footerMode(box('← 1 agent · ↓ to manage')), 'default');
  assert.equal(footerMode('Exit plan mode?\n❯ 1. Yes\n  2. No\nEsc to cancel\n'), null);
  assert.equal(footerMode(''), null);
});

test('transcripts subagents: the room row, its blocking hold, and an old participant row', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-subagents-'));
  const dir = path.join(d, 'sid-1', 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  const line = (o: unknown): string => JSON.stringify(o) + '\n';
  const call = (id: string, room: string, at: string) => line({ type: 'assistant', timestamp: at, message: { content: [{ type: 'tool_use', id, name: 'mcp__plugin_sub-human_room__hold', input: { room } }] } });
  const result = (id: string, text: string, at: string) => line({ type: 'user', timestamp: at, message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });
  // the room row: a first hold answered by a timeout, then the one blocking now
  fs.writeFileSync(path.join(dir, 'agent-a1.jsonl'), line({ type: 'user', timestamp: '2026-01-01T00:00:01Z', message: { content: 'room: egret-7989' } })
    + call('t1', 'egret-7989', '2026-01-01T00:00:02Z') + result('t1', 'timeout', '2026-01-01T00:01:00Z') + call('t2', 'egret-7989', '2026-01-01T00:01:01Z'));
  fs.writeFileSync(path.join(dir, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'sub-human:room' }));
  // a duplicate row, told to stop
  fs.writeFileSync(path.join(dir, 'agent-a2.jsonl'), line({ type: 'user', timestamp: '2026-01-01T00:00:05Z', message: { content: 'room: egret-7989' } })
    + call('t3', 'egret-7989', '2026-01-01T00:00:06Z') + result('t3', 'STOP: duplicate row: room egret-7989 already has its row.', '2026-01-01T00:00:06Z'));
  fs.writeFileSync(path.join(dir, 'agent-a3.jsonl'), line({ type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { content: 'member: bob' } }));
  fs.writeFileSync(path.join(dir, 'agent-a3.meta.json'), JSON.stringify({ agentType: 'sub-human:participant' }));
  const all = subagents(d);
  assert.deepEqual(all.map(s => [s.file, s.agentType]), [['agent-a3.jsonl', 'sub-human:participant'], ['agent-a1.jsonl', 'sub-human:room'], ['agent-a2.jsonl', '']]);
  assert.deepEqual(all.map(s => isRoomRow(s, 'egret-7989')), [false, true, true]);
  assert.deepEqual(all.map(s => holdingRow(s, 'egret-7989')), [false, true, false]);
  assert.equal(all.filter(s => holdingRow(s, 'swan-6397')).length, 0);
  assert.equal(subagents(d, 'sid-2').length, 0);
});

test('transcripts subagents: the 0.8.0 chat row holds through its keeper; nothing else nests under it', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-subagents-'));
  const dir = path.join(d, 'sid-1', 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  const line = (o: unknown): string => JSON.stringify(o) + '\n';
  const put = (id: string, meta: unknown, ...ls: string[]): void => {
    fs.writeFileSync(path.join(dir, `agent-${id}.jsonl`), ls.join(''));
    fs.writeFileSync(path.join(dir, `agent-${id}.meta.json`), JSON.stringify(meta));
  };
  const prompt = (t: string, at: string) => line({ type: 'user', timestamp: at, message: { content: t } });
  const hold = (id: string, at: string) => line({ type: 'assistant', timestamp: at, message: { content: [{ type: 'tool_use', id, name: 'mcp__plugin_sub-human_room__hold', input: { room: 'tapir-0763', take: true } }] } });
  // as 2.1.296 writes them (run tapir-0763): the row named the code, its keeper's meta naming it parent
  put('row', { agentType: 'sub-human:room', name: 'tapir-0763', spawnDepth: 1 }, prompt('chat: tapir-0763', '2026-01-01T00:00:01Z'));
  put('keep', { agentType: 'sub-human:keeper', parentAgentId: 'row', spawnDepth: 2 }, prompt('keep: tapir-0763', '2026-01-01T00:00:02Z'), hold('k1', '2026-01-01T00:00:03Z'));
  let all = subagents(d);
  const [row, keep] = all;
  assert.ok(row && keep);
  assert.deepEqual([row.id, keep.id, keep.parent], ['row', 'keep', 'row']);
  assert.deepEqual([isRoomRow(row, 'tapir-0763'), isChatRow(row, 'tapir-0763'), isKeeper(keep, 'tapir-0763'), isRoomRow(keep, 'tapir-0763')], [true, true, true, false]);
  assert.equal(holdingRow(keep, 'tapir-0763'), true);
  assert.equal(holdingRow(row, 'tapir-0763'), false); // the row itself holds nothing
  assert.deepEqual([isRoomRow(row, 'swan-6397'), isKeeper(keep, 'swan-6397')], [false, false]); // an earlier run's room in the same folder
  assert.equal(rowHolds(all, 'tapir-0763'), true);
  assert.equal(rowHeld(all, row, 'tapir-0763'), true);
  assert.deepEqual(rowStrays(all, 'tapir-0763'), []);
  // the keeper's hold returned: the row holds no more
  fs.appendFileSync(path.join(dir, 'agent-keep.jsonl'), line({ type: 'user', timestamp: '2026-01-01T00:01:00Z', message: { content: [{ type: 'tool_result', tool_use_id: 'k1', content: 'STOP: you left' }] } }));
  assert.equal(rowHolds(subagents(d), 'tapir-0763'), false);
  // a chat row with no keeper holds nothing; another agent under the row is a stray
  put('keep', { agentType: 'sub-human:keeper', parentAgentId: 'other', spawnDepth: 2 }, prompt('keep: tapir-0763', '2026-01-01T00:00:02Z'), hold('k2', '2026-01-01T00:00:03Z'));
  assert.equal(rowHolds(subagents(d), 'tapir-0763'), false); // a keeper of another row
  put('x', { agentType: 'Explore', parentAgentId: 'row', spawnDepth: 2 }, prompt('read the store', '2026-01-01T00:00:04Z'));
  all = subagents(d);
  assert.deepEqual(rowStrays(all, 'tapir-0763').map(s => s.id), ['x']);
});

test('transcripts rowKeepers and modelText: a row that respawns its keeper past the cap, and writes text of its model\'s', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-subagents-'));
  const dir = path.join(d, 'sid-1', 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  const line = (o: unknown): string => JSON.stringify(o) + '\n';
  const put = (id: string, meta: unknown, ...ls: string[]): void => {
    fs.writeFileSync(path.join(dir, `agent-${id}.jsonl`), ls.join(''));
    fs.writeFileSync(path.join(dir, `agent-${id}.meta.json`), JSON.stringify(meta));
  };
  const at = (s: number): string => new Date(Date.parse('2026-01-01T00:00:00Z') + s * 1000).toISOString();
  // the module's answer (answeredWithoutRequest) is no model text; the run vole-7874's row wrote its own
  put('row', { agentType: 'sub-human:room', name: 'vole-7874' }, line({ type: 'user', timestamp: at(0), message: { content: 'chat: vole-7874' } }),
    line({ type: 'assistant', timestamp: at(1), answeredWithoutRequest: true, message: { content: [{ type: 'text', text: 'only you' }] } }));
  for (let i = 0; i < 5; i++) put(`k${i}`, { agentType: 'sub-human:keeper', parentAgentId: 'row' }, line({ type: 'user', timestamp: at(2 + i * 60), message: { content: 'keep: vole-7874' } }));
  let all = subagents(d);
  let row = all.find(x => x.id === 'row');
  assert.ok(row);
  assert.deepEqual(row.modelText, []);
  assert.deepEqual(drawnIn(all, 'vole-7874').map(l => l.text), ['only you']); // the module's answer: drawn
  assert.deepEqual(drawnIn(all, 'swan-6397'), []);
  assert.deepEqual([rowKeepers(all, row, 'vole-7874').keepers.length, rowKeepers(all, row, 'vole-7874').peak], [5, 5]);
  // a sixth inside the window: past the cap; one after it starts a window of its own
  put('k5', { agentType: 'sub-human:keeper', parentAgentId: 'row' }, line({ type: 'user', timestamp: at(300), message: { content: 'keep: vole-7874' } }));
  put('k6', { agentType: 'sub-human:keeper', parentAgentId: 'row' }, line({ type: 'user', timestamp: at(5000), message: { content: 'keep: vole-7874' } }));
  fs.appendFileSync(path.join(dir, 'agent-row.jsonl'), line({ type: 'assistant', timestamp: at(400), message: { content: [{ type: 'text', text: "I've started the background keeper again" }] } }));
  all = subagents(d);
  row = all.find(x => x.id === 'row');
  assert.ok(row);
  assert.deepEqual([rowKeepers(all, row, 'vole-7874').keepers.length, rowKeepers(all, row, 'vole-7874').peak], [7, 6]);
  assert.ok(rowKeepers(all, row, 'vole-7874').peak > KEEPERS_MAX);
  assert.deepEqual(row.modelText, ["I've started the background keeper again"]);
});

test('demo.sh: 0.6.0 rows: no holds document, each seat\'s row waited on, the objection mode opt-in', () => {
  const sh = fs.readFileSync(DEMO_SH, 'utf8');
  assert.doesNotMatch(sh, /wait-holds/);
  assert.ok(!('wait-holds' in COMMANDS));
  for (const s of ['S1', 'S2']) assert.match((new RegExp(`^${s}\\(\\) \\{[^\\n]*\\n([\\s\\S]*?)\\n\\}`, 'm').exec(sh) ?? [])[1] ?? '', /\$LIB wait-row "\$[ab]"/);
  assert.match(sh, /--object-mode\) OBJECT_MODE="\$2"/);
  assert.match((/^S4\(\) \{[^\n]*\n([\s\S]*?)\n\}/m.exec(sh) ?? [])[1] ?? '', /set-mode "sh-\$a" "\$OBJECT_MODE"/);
  const r = spawnSync('bash', [DEMO_SH, '--object-mode', 'plan'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /auto, default or acceptEdits/);
});

test('demo.sh --film: the panel beat opens the room row and comes back with one ↑; S6b prompts name no tool', () => {
  const sh = fs.readFileSync(DEMO_SH, 'utf8');
  const show = (/^show_room\(\) \{\n([\s\S]*?)\n\}/m.exec(sh) ?? [])[1] ?? '';
  assert.match(show, /select-row "sh-\$s" "\$\(room\)"/);
  assert.match(show, /select-row "sh-\$s" main --key Up/);
  assert.equal((show.match(/keys "\$s" Up/g) || []).length, 1);
  assert.match(sh, /mark panel "Everyone in the room shows up in your agent panel"/);
  const s6b = (/^S6b\(\) \{\n([\s\S]*?)\n\}/m.exec(sh) ?? [])[1] ?? '';
  const prompts = [...s6b.matchAll(/submit "\$[ab]" "([^"]*)"/g)].flatMap(m => m[1] ?? []);
  assert.ok(prompts.length >= 3, `${prompts.length} S6b prompts`);
  for (const p of prompts) assert.doesNotMatch(p, /mcp__|op \\"|tool/, p);
  assert.match(s6b, /wait-subagent-row "sh-\$b"/);
});

test('demo.sh --film: tristan opens the room and jess joins; no alice or bob in the film\'s words or captions', () => {
  const sh = fs.readFileSync(DEMO_SH, 'utf8');
  assert.match(sh, /\[ "\$FILM" = 1 \] && \{ SEAT_A=tristan; SEAT_B=jess; \}/);
  assert.match(sh, /--sessions "\$SEAT_A=sh-\$SEAT_A,\$SEAT_B=sh-\$SEAT_B,claude=sh-claude"/);
  // the words the film types (its branch of the scripted words), the S6b scene and the marks' captions
  const words = (/^if \[ "\$FILM" = 1 \]; then\n(  SAY3=[\s\S]*?)\nelse\n/m.exec(sh) ?? [])[1] ?? '';
  const s6b = (/^S6b\(\) \{\n([\s\S]*?)\n\}/m.exec(sh) ?? [])[1] ?? '';
  const film = ['S1', 'S2', 'S3', 'S4', 'S5', 'S10'].map(s => (new RegExp(`^${s}\\(\\) \\{[^\\n]*\\n([\\s\\S]*?)\\n\\}`, 'm').exec(sh) ?? [])[1] ?? '');
  for (const t of [words, s6b, ...film]) assert.doesNotMatch(t, /\b(alice|bob)\b/i);
  // the handoff waits on the state itself: A's commit on the origin, then in B's checkout
  assert.match(s6b, /wait_commit "\$BASE\/origin\.git" "\$a"/);
  assert.match(s6b, /wait_commit "\$BASE\/\$b" "\$a"/);
  // each half is real code with its own tests
  assert.match(s6b, /src\/store\.js and test\/store-paging\.test\.js only/);
  assert.match(s6b, /src\/server\.js and test\/server-paging\.test\.js only/);
});

test('demo-lib plan-run --seats and run-words: the run\'s people and scripted words in run.json, as checks/context.ts reads them', () => {
  const d = tmp();
  const f = path.join(d, 'run.json');
  assert.equal(lib(['plan-run', f, '--all', ALL, '--seats', 'tristan jess', '--fresh', 'S1']).status, 0);
  assert.equal(lib(['run-words', f, 'say3', 'jess, can you take the HTTP side?', 'note5', 'a garbled cursor like `after=zzz` must 400, not 500 — add a test for it']).status, 0);
  assert.deepEqual(readJson(f), { scenes: ['S1'], partial: true, seats: ['tristan', 'jess'], words: { say3: 'jess, can you take the HTTP side?', note5: 'a garbled cursor like `after=zzz` must 400, not 500 — add a test for it' } });
  const r = runInfo(d);
  assert.deepEqual([r.A, r.B, r.DEMO.say3], ['tristan', 'jess', 'jess, can you take the HTTP side?']);
  assert.match(r.DEMO.plan4, /^let's write a room plan for cursor paging/); // a word the run did not write: the default
  assert.deepEqual([runInfo(tmp()).A, runInfo(tmp()).B], ['alice', 'bob']); // no run.json
  assert.equal(lib(['run-words', f, 'say3']).status, 2); // a key with no text
});

test('demo-lib: demo.sh edits no JSON inline (node -e)', () => {
  assert.doesNotMatch(fs.readFileSync(DEMO_SH, 'utf8'), /node -e/);
});

test('demo-lib: an unknown subcommand exits 2 with the usage pointer', () => {
  const r = lib(['no-such-command']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /header of scripts\/demo-lib\.ts/);
  assert.equal(lib(['toString']).status, 2); // not an inherited property
});

test('demo-lib opts: flags take no value, other options one', () => {
  assert.deepEqual(opts(['f.json', '--all', 'S1 S2', '--fresh', 'S1', '--absent', '--timeout', '5']),
    { _: ['f.json', 'S1'], all: 'S1 S2', fresh: true, absent: true, timeout: '5' });
});

test('demo-lib prune-index: drops the named scenes, keeps the rest and their order', () => {
  const f = path.join(tmp(), 'index.json');
  fs.writeFileSync(f, JSON.stringify([{ scene: 'S1', n: 1 }, { scene: 'S4', n: 2 }, { scene: 'S2', n: 3 }, { scene: 'S5', n: 4 }]));
  assert.equal(lib(['prune-index', f, 'S4', 'S5']).status, 0);
  assert.deepEqual(readJson(f), [{ scene: 'S1', n: 1 }, { scene: 'S2', n: 3 }]);
  assert.match(fs.readFileSync(f, 'utf8'), /^\[\n \{/); // the same layout snap.ts writes (1-space indent)
});

test('demo-lib prune-index: a missing or broken index becomes []', () => {
  const d = tmp();
  assert.equal(lib(['prune-index', path.join(d, 'index.json'), 'S1']).status, 0);
  assert.deepEqual(readJson(path.join(d, 'index.json')), []);
  fs.writeFileSync(path.join(d, 'bad.json'), '{"torn');
  assert.equal(lib(['prune-index', path.join(d, 'bad.json'), 'S1']).status, 0);
  assert.deepEqual(readJson(path.join(d, 'bad.json')), []);
});

const ALL = 'S1 S2 S3 S4 S5 S6 S7 S8 S9 S9b S10';

test('demo-lib plan-run: a fresh run lists only its scenes, in the --all order', () => {
  const f = path.join(tmp(), 'screens', 'run.json'); // the folder is created
  fs.mkdirSync(path.dirname(f));
  fs.writeFileSync(f, JSON.stringify({ scenes: ['S3', 'S6'] }));
  assert.equal(lib(['plan-run', f, '--all', ALL, '--fresh', 'S10', 'S1', 'S9b']).status, 0);
  assert.deepEqual(readJson(f), { scenes: ['S1', 'S9b', 'S10'], partial: true });
});

test('demo-lib plan-run: a resume adds to the scenes already listed; every scene = not partial', () => {
  const f = path.join(tmp(), 'run.json');
  assert.equal(lib(['plan-run', f, '--all', ALL, 'S1', 'S2']).status, 0); // no file yet: just these
  assert.deepEqual(readJson(f), { scenes: ['S1', 'S2'], partial: true });
  assert.equal(lib(['plan-run', f, '--all', ALL, 'S4', 'S2']).status, 0);
  assert.deepEqual(readJson<{ scenes?: unknown }>(f).scenes, ['S1', 'S2', 'S4']);
  assert.equal(lib(['plan-run', f, '--all', ALL, ...ALL.split(' ')]).status, 0);
  assert.deepEqual(readJson(f), { scenes: ALL.split(' '), partial: false });
});

test('demo-lib plan-run: matches the inline edit it replaced', () => {
  // the former demo.sh one-liner, kept here as the reference
  const old = (f: string, fresh: boolean, all: string, add: string[]): string => {
    let p: string[] = [];
    if (!fresh) try { p = parseJson<{ scenes?: string[] }>(fs.readFileSync(f, 'utf8')).scenes || []; } catch { /* none */ }
    const s = all.split(' ').filter(x => p.includes(x) || add.includes(x));
    return JSON.stringify({ scenes: s, partial: s.length < all.split(' ').length }, null, 1) + '\n';
  };
  const d = tmp();
  const cases: Array<[boolean, string[] | null, string[]]> = [[true, ['S3'], ['S1', 'S2']], [false, ['S3'], ['S1']], [false, null, ['S5']], [false, ['S1'], []]];
  for (const [fresh, prev, add] of cases) {
    const f = path.join(d, `run-${Math.random().toString(36).slice(2)}.json`);
    if (prev) fs.writeFileSync(f, JSON.stringify({ scenes: prev }));
    const want = old(f, fresh, ALL, add);
    assert.equal(lib(['plan-run', f, '--all', ALL, ...(fresh ? ['--fresh'] : []), ...add]).status, 0);
    assert.equal(fs.readFileSync(f, 'utf8'), want);
  }
});

test('demo-lib record: appends one waits.jsonl line for the current scene; --ok false marks it failed', () => {
  const d = tmp();
  const env = { SNAP_DIR: d, DEMO_SCENE: 'S4' };
  assert.equal(lib(['record', '--what', 'nudge: alice asked for the card'], env).status, 0);
  assert.equal(lib(['record', '--what', 'S4: timed out waiting: "x"', '--ok', 'false'], env).status, 0);
  const lines: Array<{ time: string, [k: string]: unknown }> = fs.readFileSync(path.join(d, 'waits.jsonl'), 'utf8').trim().split('\n').map(l => parseJson<{ time: string, [k: string]: unknown }>(l));
  assert.deepEqual(lines.map(({ time, ...r }) => (assert.ok(Date.parse(time)), r)), [
    { scene: 'S4', what: 'nudge: alice asked for the card', ok: true, ms: 0 },
    { scene: 'S4', what: 'S4: timed out waiting: "x"', ok: false, ms: 0 },
  ]);
});

test('demo-lib listsRoomClaude: by job id or session id, as the S10 check reads claude agents --json', () => {
  const roomClaude = { job: 'job-1', session_id: 'sid-1' };
  assert.equal(listsRoomClaude([{ id: 'job-1', state: 'stopped' }], roomClaude), true);
  assert.equal(listsRoomClaude([{ id: 'other', sessionId: 'sid-1' }], roomClaude), true);
  assert.equal(listsRoomClaude([{ id: 'other', sessionId: 'sid-2' }], roomClaude), false);
  assert.equal(listsRoomClaude([], roomClaude), false);
  assert.equal(listsRoomClaude([{ id: undefined }], {}), false);
});
