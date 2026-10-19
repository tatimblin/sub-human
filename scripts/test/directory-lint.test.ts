// scripts/directory-lint.ts: each rule fires on a small fixture, and a clean plugin passes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkPermissionAnswers, checkProcessRuns, checkCommands, checkInvisible, checkLimits, pluginFiles, readmeWords, lint, words } from '../directory-lint.ts';
import type { Finding } from '../directory-lint.ts';

const README = `# demo\n\n${'This plugin does a small useful thing for the people who install it and use it. '.repeat(3)}\n\n\`\`\`sh\nnpm test\n\`\`\`\n`;

/** A clean plugin in a temp dir; files overrides (null deletes). */
function plugin(files: Record<string, string | null> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'directory-lint-'));
  const base: Record<string, string | null> = {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0', license: 'MIT' }),
    'README.md': README,
    'hooks/run.sh': '#!/bin/sh\n',
    'hooks/hooks.json': JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'sh "${CLAUDE_PLUGIN_ROOT}/hooks/run.sh" end' }] }] } }),
    '.mcp.json': JSON.stringify({ mcpServers: { room: { command: 'sh', args: ['${CLAUDE_PLUGIN_ROOT}/hooks/run.sh', '--flag'] } } }),
    'mod/register.ts': [
      "on('classic.PreToolUse', { tool: 'Agent' }, async ($, e, next) => {",
      "  if (x) return { deny: 'no', additionalContext: ctx };",
      "  if (y) return { ask: q, updatedInput: input };",
      '  return next(e);',
      '}).catch((_$, e, next) => next(e));',
      "on('tool.call', { tool: 'Bash' }, async ($, e, next) => {",
      '  const r = await next(e);',
      "  if (z) return r;",
      "  return why ? { deny: text(why) } : next(e);",
      "}).catch((_$, e, next) => (e.agentId ? next(e) : { deny: HOLD }));",
      "on('classic.PostToolUse', async ($, e, next) => ({ ...await next(e), extra: 1 }));",
      "await $.process.run(['sh', `${root}/scripts/clip.sh`, name], init);",
    ].join('\n'),
    ...files,
  };
  for (const [rel, text] of Object.entries(base)) {
    if (text === null) continue;
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

const rules = (fs: Finding[]): string[] => fs.map(f => f.rule);

test('a clean plugin passes every rule', () => {
  assert.deepEqual(lint(plugin()), []);
});

test('MOD_PERMISSION_ANSWER_UNREAD: a spread, a computed key, a method, allow, a call or a variable in an answer', () => {
  const hook = (ret: string): string => `on('classic.PreToolUse', async ($, e, next) => {\n  ${ret}\n}).catch((_$, e, next) => next(e));`;
  for (const ret of [
    "return { deny: 'x', ...context };",
    "return { [k]: 'x' };",
    "return { deny: 'x', toString() { } };",
    "return { get deny() { } };",
    "return { allow: true };",
    "return { additionalContext: 'x' };",
    'return build(e);',
    'return answer;',
    "return c ? next(e) : { ...r, deny: 'x' };",
  ]) {
    const f = checkPermissionAnswers(hook(ret), 'mod/x.ts');
    assert.deepEqual(rules(f), ['MOD_PERMISSION_ANSWER_UNREAD'], ret);
    assert.equal(f[0]?.line, 2, ret);
  }
  // the .catch handler is judged too, and a tool.call hook that answers { deny
  assert.equal(checkPermissionAnswers("on('classic.PreToolUse', ($, e, next) => next(e)).catch((_$, e, next) => ({ ...e }));", 'm').length, 1);
  assert.equal(checkPermissionAnswers("on('tool.call', async ($, e, next) => {\n  const r = await next(e);\n  return c ? { deny: 'x' } : { ...r, context: [] };\n});", 'm').length, 1);
  // a tool.call hook that never answers { deny is out of scope; a brace or `return` in a string or comment is not code
  assert.equal(checkPermissionAnswers("on('tool.call', async ($, e, next) => { const r = await next(e); return { ...r }; });", 'm').length, 0);
  assert.equal(checkPermissionAnswers("on('classic.PreToolUse', async ($, e, next) => {\n  // return { ...x }\n  const s = '} return {...y}';\n  return next(e);\n});", 'm').length, 0);
});

test('MOD_PERMISSION_ANSWER_UNREAD: tool.check and classic.PermissionRequest hooks are refused outright', () => {
  assert.deepEqual(rules(checkPermissionAnswers("on('tool.check', ($, e, next) => next(e));", 'm')), ['MOD_PERMISSION_ANSWER_UNREAD']);
  assert.deepEqual(rules(checkPermissionAnswers("on('classic.PermissionRequest', ($, e, next) => next(e));", 'm')), ['MOD_PERMISSION_ANSWER_UNREAD']);
});

test('MOD_RUNS_PROCESS: -c, -e or a shell program in a $.process argv', () => {
  for (const call of [
    "$.process.run(['sh', '-c', script], init)",
    "$.process.run(['node', '-e', code])",
    "$.process.spawn({ argv: ['node', \"--eval\", code] })",
    "$.process.run(['sh', `cat ${f} | pbcopy`])",
  ]) assert.deepEqual(rules(checkProcessRuns(`await ${call};`, 'mod/x.ts')), ['MOD_RUNS_PROCESS'], call);
  assert.deepEqual(checkProcessRuns("await $.process.run(shimArgv(root, 'join'), { stdin: '-c' === x ? a : b });", 'm').length, 1);
  assert.deepEqual(checkProcessRuns("await $.process.run(['sh', `${root}/scripts/clip.sh`, name]);", 'm'), []);
});

test('COMMAND_PATH_COMPUTED: words; another variable, a missing file, -c, an operator, a glob, a substitution', () => {
  assert.deepEqual(words('exec sh "${CLAUDE_PLUGIN_ROOT}/a b.sh" --x \'y\''), ['exec', 'sh', '${CLAUDE_PLUGIN_ROOT}/a b.sh', '--x', 'y']);
  for (const command of [
    '"${SUB_HUMAN_HOME:-$HOME/.sub-human}/bin/row-status"',
    'sh "${CLAUDE_PLUGIN_ROOT}/hooks/missing.sh"',
    'sh "${CLAUDE_PLUGIN_ROOT}/../outside.sh"',
    'sh -c "echo hi"',
    'node -e 1',
    'sh "${CLAUDE_PLUGIN_ROOT}/hooks/run.sh" ; rm x',
    'sh "${CLAUDE_PLUGIN_ROOT}/hooks/*.sh"',
    'sh "$(dirname x)/run.sh"',
    'sh `which run`',
  ]) {
    const root = plugin({ 'settings.json': JSON.stringify({ subagentStatusLine: { type: 'command', command } }) });
    const f = checkCommands(root);
    assert.ok(f.length >= 1 && f.every(x => x.rule === 'COMMAND_PATH_COMPUTED' && x.file === 'settings.json'), command);
  }
  const mcp = plugin({ '.mcp.json': JSON.stringify({ mcpServers: { r: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/hooks/run.sh', '$HOME/x'] } } }) });
  assert.deepEqual(checkCommands(mcp).map(f => f.file), ['.mcp.json']);
  const hooks = plugin({ 'hooks/hooks.json': JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node -e "1"' }] }] } }) });
  assert.deepEqual(checkCommands(hooks).map(f => f.file), ['hooks/hooks.json']);
});

test('INVISIBLE_CHARACTER: each range as a character; the escape spelled out is fine', () => {
  for (const cp of [0xad, 0x200b, 0x200f, 0x202a, 0x202e, 0x2060, 0x2069, 0xfeff]) {
    const f = checkInvisible(`ok\nbad ${String.fromCodePoint(cp)} here`, 'x.md');
    assert.equal(f.length, 1, cp.toString(16));
    assert.equal(f[0]?.line, 2);
  }
  assert.deepEqual(checkInvisible('const s = "\\u2068";', 'x.ts'), []);
  const root = plugin({ 'skills/a/SKILL.md': `hi${String.fromCodePoint(0x202e)}` });
  assert.deepEqual(rules(lint(root)), ['INVISIBLE_CHARACTER']);
});

test('LIMIT_*: file count, file size, OS junk, README words, license, a lockfile beside package.json', () => {
  const root = plugin();
  const files = pluginFiles(root);
  assert.ok(files.includes('README.md') && files.includes('mod/register.ts'));
  assert.deepEqual(rules(checkLimits(root, [...files, ...Array.from({ length: 512 }, (_, i) => `f${i}`)])), ['LIMIT_FILE_COUNT']);

  assert.deepEqual(rules(lint(plugin({ 'lib/big.ts': 'x'.repeat(256 * 1024) }))), ['LIMIT_FILE_SIZE']);
  assert.deepEqual(lint(plugin({ 'assets/big.png': 'x'.repeat(256 * 1024) })), []);
  assert.deepEqual(rules(lint(plugin({ '.DS_Store': '' }))), ['LIMIT_JUNK_FILE']);
  assert.deepEqual(rules(lint(plugin({ '__MACOSX/x': '' }))), ['LIMIT_JUNK_FILE']);

  assert.equal(readmeWords('one two\n```\nthree four five\n```\nsix'), 3);
  assert.deepEqual(rules(lint(plugin({ 'README.md': '# demo\n\nToo short.\n\n```\n' + 'code '.repeat(100) + '\n```\n' }))), ['LIMIT_README']);
  assert.deepEqual(rules(lint(plugin({ 'README.md': null }))), ['LIMIT_README']);

  assert.deepEqual(rules(lint(plugin({ '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo' }) }))), ['LIMIT_LICENSE']);
  assert.deepEqual(lint(plugin({ '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo' }), LICENSE: 'MIT' })), []);

  assert.deepEqual(lint(plugin({ 'package.json': '{}' })), []);
  assert.deepEqual(rules(lint(plugin({ 'package.json': '{}', 'package-lock.json': '{}' }))), ['LIMIT_LOCKFILE']);
});
