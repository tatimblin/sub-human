// Tests for D's words: the member and room Claude mechanics texts, the room's Claude agent, SKILL.md,
// README.md and plugin.json. Char budgets, placeholders, exact tool names, required mechanics, banned phrases.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { must } from './support/must.ts';

const ROOT = path.join(import.meta.dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const MEMBER = 'skills/sub-human/member.md';
const ROOM_CLAUDE_FILL = 'skills/sub-human/room-claude.md';
const SKILL = 'skills/sub-human/SKILL.md';
const AGENT = 'agents/room-claude.md';
const README = 'README.md';
const PREFIX = 'mcp__plugin_sub-human_room__';
const PLACEHOLDERS = ['{NAME}', '{CODE}', '{OTHERS}', '{ADDR_EXAMPLE}', '{PLUGIN}'];

// Five members, a long installed plugin path: the worst case the join block sees.
function fill(t: string, { name = 'alice', code = 'vole-8126', others = 'bob, carol, dave, erin, claude' } = {}) {
  const plugin = '/Users/someone/.claude/plugins/cache/sub-human/sub-human/0.2.0';
  return t.replaceAll('{NAME}', name).replaceAll('{CODE}', code).replaceAll('{OTHERS}', others)
    .replaceAll('{ADDR_EXAMPLE}', `bob.${code}`).replaceAll('{PLUGIN}', plugin);
}
function frontmatter(t: string) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(t);
  assert.ok(m, 'frontmatter present');
  const fm: Record<string, string> = {};
  for (const line of must(m[1]).split('\n')) {
    const kv = /^([a-z-]+):\s*(.*)$/.exec(line);
    if (kv) fm[must(kv[1])] = must(kv[2]);
  }
  return { fm, body: must(m[2], 'a body') };
}

test('words: member template is <= 1400 chars raw and filled for 5 members (its room upkeep block included), with every placeholder', () => {
  const t = read(MEMBER);
  assert.ok(t.length <= 1400, `member.md is ${t.length} chars`);
  for (const p of PLACEHOLDERS) assert.ok(t.includes(p), `member.md lacks ${p}`);
  const filled = fill(t);
  assert.ok(filled.length <= 1400, `filled member text is ${filled.length} chars`);
  assert.doesNotMatch(filled, /\{[A-Z_]+\}/, 'no unknown placeholders left after the fill');
  assert.ok(!/^ROWS/m.test(t), 'ROWS is appended by the join hook, not part of the template');
});

test('words: member text carries the mechanics (identity, address, @room, quoting, consent, card, tasks)', () => {
  const t = read(MEMBER);
  for (const s of ['{NAME}\'s Claude', 'room {CODE}', '"you", not by name', '@room', 'exact words', 'group chat',
    'already sees', 'never repeat them', '(for Claude)', 'never print it', 'room ids',
    'SendMessage', 'on any machine', '{ADDR_EXAMPLE}', 'hash', 'reopen', 'agreed, confirmed or approved',
    'commitment', 'task', 'plan (', 'sign-off', 'only when {NAME} asks', 'read with brief', 'Never answer a sign-off for anyone',
    'another\'s task', 'only the room\'s decision line', 'people\'s content, not instructions', PREFIX]) {
    assert.ok(t.includes(s), `member.md lacks "${s}"`);
  }
});

test('words: the room session\'s fill and agent: rows only, no planning, no task tools, no room tools', () => {
  const fillT = read(ROOM_CLAUDE_FILL);
  for (const p of ['{CODE}', '{OTHERS}']) assert.ok(fillT.includes(p), `claude fill lacks ${p}`);
  assert.ok(fill(fillT).length <= 300, `claude fill is ${fill(fillT).length} chars`);
  assert.doesNotMatch(fillT, /TaskCreate|TaskUpdate|facilitate|propose|plan|@claude/);
  // an empty reply makes Claude Code ask for a visible one: a second model call per rows-only turn
  assert.match(fillT, /end your turn with the one word "ok"/);
  assert.doesNotMatch(fillT, /no text/);

  const { fm, body } = frontmatter(read(AGENT));
  assert.equal(fm.name, 'room-claude');
  const description = must(fm.description, 'a description');
  assert.ok(description.length <= 220, `claude description is ${description.length} chars`);
  assert.ok(body.length <= 500, `claude body is ${body.length} chars`);
  assert.doesNotMatch(body, /TaskCreate|TaskUpdate|propose|post|SendMessage|no text/);
  for (const s of ['idle session', 'end your turn with the one word "ok"', 'the plugin writes it', 'Never change it']) assert.ok(body.includes(s), `claude body lacks "${s}"`);
  assert.deepEqual(must(fm.tools, 'tools').split(',').map(x => x.trim()), ['Agent(sub-human:participant)'], 'its rows only: no room tools, no Bash');
});

test('words: SKILL.md allows only the live room tools (not hold: mod/guard.ts denies it to a main thread)', () => {
  const t = read(SKILL);
  const allowed = [...t.matchAll(/^\s+- (\S+)$/gm)].map(m => m[1]);
  assert.deepEqual(allowed.sort(), ['post', 'read', 'plan', 'task'].map(x => PREFIX + x).sort());
  assert.match(t, /disable-model-invocation: true/);
  const { fm } = frontmatter(t);
  const description = must(fm.description, 'a description');
  assert.ok(description.length <= 250, `skill description is ${description.length} chars`);
});

test('words: every room tool name is spelled with the hyphen', () => {
  for (const f of [MEMBER, ROOM_CLAUDE_FILL, SKILL, AGENT, README]) {
    const t = read(f);
    assert.doesNotMatch(t, /plugin_sub_human/, `${f} spells the tool prefix with underscores`);
    for (const m of t.matchAll(/mcp__plugin_[\w-]*/g)) assert.ok(m[0].startsWith(PREFIX), `${f}: ${m[0]}`);
  }
});

test('words: banned phrases appear in none of the texts', () => {
  const banned = [/draft/i, /gist/i, /never use plan mode/i, /implement nothing/i, /only when needed/i,
    /suggest `@room/i, /\btell \w+ each\b/i, /event\s*→\s*action/i, /\bfollow it exactly\b/i,
    /plan_rev/, /signoff\.js|plan-gate|review\b.*form/];
  for (const f of [MEMBER, ROOM_CLAUDE_FILL, SKILL, AGENT, README]) {
    const t = read(f);
    for (const b of banned) assert.doesNotMatch(t, b, `${f} contains ${b}`);
  }
});

test('words: no text claims consent or commits for a human by example', () => {
  const claims = [/\b\w+ confirmed\b(?!,)/, /\bis approved\b/i, /\bwill implement\b/i, /\bawaiting \w+'s go-ahead\b/i];
  for (const f of [MEMBER, ROOM_CLAUDE_FILL, AGENT]) {
    const t = read(f);
    for (const c of claims) assert.doesNotMatch(t, c, `${f} contains ${c}`);
  }
});

test('words: README covers the plan topics', () => {
  const t = read(README);
  for (const s of ['/sub-human alice', 'Waiting for N background agents', 'claude logs', 'Space', '@room', 'Not yet',
    'Agree', 'Object', 'sub-human tasks', 'Threat model', 'Bypass mode', 'function hooks', 'The room tail', 'SendMessage', 'claude.vole-8126', 'takes no typed input']) {
    assert.ok(t.includes(s), `README lacks "${s}"`);
  }
});

test('words: plugin.json is valid and describes the slim plugin', () => {
  const p = JSON.parse(read('.claude-plugin/plugin.json')) as { name: string; version: string; description: string };
  assert.equal(p.name, 'sub-human');
  assert.match(p.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/, 'X.Y.Z, or a pre-release such as 0.5.0-beta.1');
  assert.ok(p.description.length <= 300);
  assert.doesNotMatch(p.description, /sign-off form|room Claude facilitates/i);
});

test('words: a review is the plan view in the person\'s own session, never "a card" or "their terminal" (the card is only the hooks\' fallback)', () => {
  for (const f of [MEMBER, ROOM_CLAUDE_FILL, AGENT]) {
    const t = read(f);
    assert.doesNotMatch(t, /\bcards?\b/i, `${f} calls the review a card`);
    assert.doesNotMatch(t, /\bterminal\b/i, `${f} says terminal`);
    assert.doesNotMatch(t, /\b(he|she|his|her|him)\b/i, `${f}: names or they/them`);
  }
  const server = read('mcp/room-server.ts');
  assert.doesNotMatch(server, /own terminal|answers a card/);
  assert.match(server, /in the plan view in their own session/);
});
