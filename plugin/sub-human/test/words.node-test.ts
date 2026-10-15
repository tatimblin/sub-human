// Tests for D's words: the member and room Claude mechanics texts, the room's Claude agent, SKILL.md, facilitate.md,
// README.md and plugin.json. Char budgets, placeholders, exact tool names, required mechanics, banned phrases.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const MEMBER = 'skills/sub-human/member.md';
const ROOM_CLAUDE_FILL = 'skills/sub-human/room-claude.md';
const FACILITATE = 'skills/sub-human/facilitate.md';
const SKILL = 'skills/sub-human/SKILL.md';
const AGENT = 'agents/room-claude.md';
const README = 'README.md';
const PREFIX = 'mcp__plugin_sub-human_room__';
const PLACEHOLDERS = ['{NAME}', '{CODE}', '{OTHERS}', '{ADDR_EXAMPLE}', '{PLUGIN}'];

// Five members, a long installed plugin path: the worst case the join block sees.
function fill(t, { name = 'alice', code = 'vole-8126', others = 'bob, carol, dave, erin, claude' } = {}) {
  const plugin = '/Users/someone/.claude/plugins/cache/sub-human/sub-human/0.2.0';
  return t.replaceAll('{NAME}', name).replaceAll('{CODE}', code).replaceAll('{OTHERS}', others)
    .replaceAll('{ADDR_EXAMPLE}', `bob.${code}`).replaceAll('{PLUGIN}', plugin);
}
function frontmatter(t) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(t);
  assert.ok(m, 'frontmatter present');
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([a-z-]+):\s*(.*)$/.exec(line);
    if (kv) fm[kv[1]] = kv[2];
  }
  return { fm, body: m[2] };
}

test('words: member template is <= 900 chars raw and filled for 5 members, with every placeholder', () => {
  const t = read(MEMBER);
  assert.ok(t.length <= 900, `member.md is ${t.length} chars`);
  for (const p of PLACEHOLDERS) assert.ok(t.includes(p), `member.md lacks ${p}`);
  const filled = fill(t);
  assert.ok(filled.length <= 900, `filled member text is ${filled.length} chars`);
  assert.doesNotMatch(filled, /\{[A-Z_]+\}/, 'no unknown placeholders left after the fill');
  assert.ok(!/^ROWS/m.test(t), 'ROWS is appended by the join hook, not part of the template');
});

test('words: member text carries the mechanics (identity, address, @room, quoting, consent, card, tasks)', () => {
  const t = read(MEMBER);
  for (const s of ['{NAME}\'s Claude', 'room {CODE}', '"you", not by name', '@room', 'exact words', 'group chat',
    'already sees', 'never repeat them', '(for Claude)', 'never print it', 'room ids',
    'SendMessage', 'on any machine', '{ADDR_EXAMPLE}', 'AskUserQuestion', 'hash', 'reopen', 'agreed, confirmed or approved',
    'commitment', 'task', 'propose', PREFIX]) {
    assert.ok(t.includes(s), `member.md lacks "${s}"`);
  }
});

test('words: claude fill is short and names the room task; agent body holds the apply rules', () => {
  const fillT = read(ROOM_CLAUDE_FILL);
  for (const p of ['{CODE}', '{OTHERS}', '{ADDR_EXAMPLE}', '{PLUGIN}']) assert.ok(fillT.includes(p), `claude fill lacks ${p}`);
  assert.ok(fill(fillT).length <= 500, `claude fill is ${fill(fillT).length} chars`);
  assert.match(fillT, /room \{CODE\} open/);
  assert.match(fillT, /in_progress/);
  assert.match(fillT, /owner "room"/);
  assert.match(fillT, /facilitate\.md/);

  const { fm, body } = frontmatter(read(AGENT));
  assert.equal(fm.name, 'room-claude');
  assert.ok(fm.description.length <= 200, `claude description is ${fm.description.length} chars`);
  assert.ok(body.length <= 1900, `claude body is ${body.length} chars`);
  for (const s of ['TaskCreate', 'TaskUpdate', 'one message', 'metadata {req: N, by: NAME}', 'only status completed', 'drops every field', 'completed',
    'owner\'s done request', 'room closed', 'Task 1', 'SendMessage', 'propose', 'no #ids', 'No Bash',
    'agreed, confirmed or approved', 'never ask here', 'one message per person', 'not the room', 'No status', 'open questions', 'one round']) {
    assert.ok(body.includes(s), `claude body lacks "${s}"`);
  }
});

test('words: room Claude tools are exactly the plan list (no Bash)', () => {
  const { fm } = frontmatter(read(AGENT));
  const tools = fm.tools.split(',').map(s => s.trim());
  const want = ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Agent(sub-human:participant)', 'Agent(general-purpose)', 'SendMessage', 'ListAgents', 'ToolSearch',
    'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', ...['post', 'read', 'propose', 'hold'].map(t => PREFIX + t)];
  assert.deepEqual([...tools].sort(), [...want].sort());
  assert.ok(!tools.includes('Bash'));
});

test('words: SKILL.md allows only the live room tools (not hold: mod/guard.ts denies it to a main thread)', () => {
  const t = read(SKILL);
  const allowed = [...t.matchAll(/^\s+- (\S+)$/gm)].map(m => m[1]);
  assert.deepEqual(allowed.sort(), ['post', 'read', 'propose', 'task'].map(x => PREFIX + x).sort());
  assert.match(t, /disable-model-invocation: true/);
  const { fm } = frontmatter(t);
  assert.ok(fm.description.length <= 250, `skill description is ${fm.description.length} chars`);
});

test('words: every room tool name is spelled with the hyphen', () => {
  for (const f of [MEMBER, ROOM_CLAUDE_FILL, FACILITATE, SKILL, AGENT, README]) {
    const t = read(f);
    assert.doesNotMatch(t, /plugin_sub_human/, `${f} spells the tool prefix with underscores`);
    for (const m of t.matchAll(/mcp__plugin_[\w-]*/g)) assert.ok(m[0].startsWith(PREFIX), `${f}: ${m[0]}`);
  }
});

test('words: banned phrases appear in none of the texts', () => {
  const banned = [/draft/i, /gist/i, /never use plan mode/i, /implement nothing/i, /only when needed/i,
    /suggest `@room/i, /\btell \w+ each\b/i, /event\s*→\s*action/i, /\bfollow it exactly\b/i,
    /plan_rev/, /signoff\.js|plan-gate|review\b.*form/];
  for (const f of [MEMBER, ROOM_CLAUDE_FILL, FACILITATE, SKILL, AGENT, README]) {
    const t = read(f);
    for (const b of banned) assert.doesNotMatch(t, b, `${f} contains ${b}`);
  }
});

test('words: no text claims consent or commits for a human by example', () => {
  const claims = [/\b\w+ confirmed\b(?!,)/, /\bis approved\b/i, /\bwill implement\b/i, /\bawaiting \w+'s go-ahead\b/i];
  for (const f of [MEMBER, ROOM_CLAUDE_FILL, FACILITATE, AGENT]) {
    const t = read(f);
    for (const c of claims) assert.doesNotMatch(t, c, `${f} contains ${c}`);
  }
});

test('words: facilitate.md is optional, on-demand and small', () => {
  const t = read(FACILITATE);
  assert.ok(t.length <= 3000, `facilitate.md is ${t.length} chars`);
  assert.match(t, /only when someone asks/i);
  assert.match(t, /propose/);
});

test('words: README covers the plan topics', () => {
  const t = read(README);
  for (const s of ['/sub-human alice', 'Waiting for N background agents', 'claude logs', 'Space', '@room', 'Not yet',
    'Agree', 'Object', 'sub-human tasks', 'Threat model', 'Bypass mode', 'function hooks', 'The room tail', 'SendMessage', 'claude.vole-8126', 'takes no typed input']) {
    assert.ok(t.includes(s), `README lacks "${s}"`);
  }
});

test('words: plugin.json is valid and describes the slim plugin', () => {
  const p = JSON.parse(read('.claude-plugin/plugin.json'));
  assert.equal(p.name, 'sub-human');
  assert.match(p.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/, 'X.Y.Z, or a pre-release such as 0.5.0-beta.1');
  assert.ok(p.description.length <= 300);
  assert.doesNotMatch(p.description, /sign-off form|room Claude facilitates/i);
});

test('words: a review is the plan view in the person\'s own session, never "a card" or "their terminal" (the card is only the hooks\' fallback)', () => {
  for (const f of [MEMBER, ROOM_CLAUDE_FILL, FACILITATE, AGENT]) {
    const t = read(f);
    assert.doesNotMatch(t, /\bcards?\b/i, `${f} calls the review a card`);
    assert.doesNotMatch(t, /\bterminal\b/i, `${f} says terminal`);
    assert.doesNotMatch(t, /\b(he|she|his|her|him)\b/i, `${f}: names or they/them`);
  }
  const server = read('mcp/room-server.ts');
  assert.doesNotMatch(server, /own terminal|answers a card/);
  assert.match(server, /in the plan view in their own session/);
});
