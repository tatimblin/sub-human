'use strict';
// Lints the plugin surface: hooks.json (paths, matcher anchoring per the binary's rule, timeouts), no monitors,
// agent frontmatter, SKILL.md, the manifests, and the room MCP server's tool metadata and initialize reply.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const h = require('./helpers.js');
const cc = require(path.join(h.LIB, 'cc.js'));

const PLUGIN = h.PLUGIN;
const readJson = rel => JSON.parse(fs.readFileSync(path.join(PLUGIN, rel), 'utf8'));
const hooks = readJson('hooks/hooks.json').hooks;
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied']);
const ROOM = 'mcp__plugin_sub-human_room__';

function* allHooks() {
  for (const [event, groups] of Object.entries(hooks)) {
    for (const g of groups) for (const hk of g.hooks) yield { event, matcher: g.matcher, hook: hk };
  }
}
const scriptOf = cmd => {
  const m = /\$\{CLAUDE_PLUGIN_ROOT\}\/([^"\s]+)/.exec(cmd);
  return m && m[1];
};
// Top-level alternatives of a regex (splits on | outside parentheses and classes).
function alternatives(re) {
  const out = [];
  let depth = 0, cls = false, cur = '';
  for (let i = 0; i < re.length; i++) {
    const c = re[i];
    if (c === '\\') { cur += c + (re[++i] || ''); continue; }
    if (cls) { if (c === ']') cls = false; cur += c; continue; }
    if (c === '[') cls = true;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === '|' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

test('hooks.json: every command runs node on a script that exists in the plugin', () => {
  for (const { event, hook } of allHooks()) {
    assert.equal(hook.type, 'command', event);
    assert.match(hook.command, /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/[^"]+"$/, `${event}: ${hook.command}`);
    const rel = scriptOf(hook.command);
    assert.ok(fs.existsSync(path.join(PLUGIN, rel)), `${event}: ${rel} is missing`);
  }
});

test('hooks.json: every matcher is an exact-name list or an anchored regex (binary rule: regexes are unanchored)', () => {
  for (const { event, matcher } of allHooks()) {
    if (matcher === undefined) continue;
    const toolEvent = TOOL_EVENTS.has(event);
    assert.ok(matcher && matcher !== '*', `${event}: use no matcher instead of "${matcher}"`);
    if (cc.matcherIsExact(matcher, { toolEvent })) continue;
    assert.doesNotThrow(() => new RegExp(matcher), `${event}: ${matcher}`);
    for (const alt of alternatives(matcher)) assert.ok(alt.startsWith('^'), `${event}: "${alt}" in "${matcher}" is unanchored`);
  }
});

test('hooks.json: tool matchers select exactly the intended tools; the store guard is the module\'s, not a command hook', () => {
  const pre = hooks.PreToolUse.map(g => g.matcher);
  assert.ok(!hooks.PreToolUse.some(g => /hooks\/guard\.js/.test(g.hooks[0].command)), 'the store guard is mod/guard.mjs');
  assert.ok(!fs.existsSync(path.join(PLUGIN, 'hooks', 'guard.js')));
  assert.deepEqual(readJson('hooks/hooks.json').modules, ['../mod/register.mjs']);
  const consent = hooks.PreToolUse.find(g => /hooks\/consent\.js/.test(g.hooks[0].command)).matcher;
  const m = (x, name) => cc.matcherMatches(x, name);
  for (const t of ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', ROOM + 'propose']) assert.ok(m(consent, t), `consent misses ${t}`);
  for (const t of ['mcp__x__ExitPlanMode', 'ExitPlanModeV2', 'Edit']) assert.ok(!m(consent, t), `consent wrongly matches ${t}`);
  assert.ok(pre.includes('Agent|Task') && !m('Agent|Task', 'TaskCreate'));
});

test('hooks.json: every blocking hook has a timeout (<= 10 s, row-rewake aside); SessionEnd >= 3 s', () => {
  for (const { event, hook } of allHooks()) {
    assert.ok(Number.isFinite(hook.timeout) && hook.timeout > 0, `${event} ${scriptOf(hook.command)} has no timeout`);
    if (!hook.async && !hook.asyncRewake) assert.ok(hook.timeout <= 10, `${event} ${scriptOf(hook.command)}: ${hook.timeout}s`);
    assert.ok(hook.timeout <= 60, 'Claude Code caps hook budgets at 60 s');
  }
  for (const g of hooks.SessionEnd) for (const hk of g.hooks) assert.ok(hk.timeout >= 3, `SessionEnd gets 1.5 s unless timeout is set (got ${hk.timeout})`);
});

test('hooks.json: async only on hooks whose output nothing reads', () => {
  const asyncScripts = [...allHooks()].filter(x => x.hook.async).map(x => `${x.event}:${scriptOf(x.hook.command)}`).sort();
  assert.deepEqual(asyncScripts, ['Notification:hooks/presence.js', 'SessionStart:hooks/row-launcher.js', 'StopFailure:hooks/presence.js']);
});

test('no Monitor: the hooks module\'s tail child is the only delivery', () => {
  assert.equal(fs.existsSync(path.join(PLUGIN, 'monitors')), false, 'monitors/ is gone');
  const manifest = readJson('.claude-plugin/plugin.json');
  assert.equal(manifest.monitors, undefined);
  assert.equal((manifest.experimental || {}).monitors, undefined);
});

function frontmatter(file) {
  const t = fs.readFileSync(file, 'utf8');
  const m = /^---\n([\s\S]*?)\n---\n/.exec(t);
  assert.ok(m, `${file}: frontmatter`);
  return m[1];
}

test('agents: no model key; Agent(...) restrictions name agents that exist', () => {
  const dir = path.join(PLUGIN, 'agents');
  const names = new Set(fs.readdirSync(dir).filter(f => f.endsWith('.md')).map(f => `sub-human:${f.slice(0, -3)}`));
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.md'))) {
    const fm = frontmatter(path.join(dir, f));
    assert.doesNotMatch(fm, /^model:/m, `${f} prescribes a model`);
    const tools = /^tools: (.*)$/m.exec(fm);
    if (!tools) continue;
    assert.doesNotMatch(tools[1], /(^|,\s*)Agent(\s*,|$)/, `${f}: a bare Agent lets it spawn any type`);
    for (const [, types] of tools[1].matchAll(/Agent\(([^)]*)\)/g)) {
      for (const t of types.split(',').map(s => s.trim())) assert.ok(names.has(t) || t === 'general-purpose', `${f}: unknown agent type ${t}`);
    }
  }
  assert.match(frontmatter(path.join(dir, 'room.md')), /^tools: Agent\(sub-human:participant\), mcp__plugin_sub-human_room__hold$/m);
});

test('SKILL.md: user-invoked only, and hold is not pre-allowed', () => {
  const fm = frontmatter(path.join(PLUGIN, 'skills', 'sub-human', 'SKILL.md'));
  assert.match(fm, /^disable-model-invocation: true$/m);
  assert.doesNotMatch(fm, /room__hold/);
  assert.match(fm, /^description: .*\/sub-human NAME/m);
});

test('manifests: plugin.json carries the version; the marketplace entry does not repeat it', () => {
  const p = readJson('.claude-plugin/plugin.json');
  assert.equal(p.$schema, 'https://anthropic.com/claude-code/plugin.schema.json');
  assert.match(p.version, /^\d+\.\d+\.\d+$/);
  assert.ok(Array.isArray(p.keywords) && p.keywords.length);
  assert.notEqual(p.license, 'UNLICENSED', 'not an SPDX id');
  const mk = JSON.parse(fs.readFileSync(path.join(PLUGIN, '..', '..', '.claude-plugin', 'marketplace.json'), 'utf8'));
  const entry = mk.plugins.find(x => x.name === 'sub-human');
  assert.ok(entry && entry.version === undefined, 'plugin.json wins at install; keep one version');
});

function rpc(msgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [h.MCP], { env: h.childEnv({}), stdio: ['pipe', 'pipe', 'pipe'] });
    const out = new Map();
    let buf = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('mcp timeout')); }, 10000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', d => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (m.id != null) out.set(m.id, m);
        if (out.size === msgs.length) { clearTimeout(timer); child.kill(); resolve(out); }
      }
    });
    for (const [i, [method, params]] of msgs.entries()) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i + 1, method, params }) + '\n');
  });
}

test('mcp: every tool has a description, documented properties, additionalProperties:false and annotations', async () => {
  const r = await rpc([['initialize', { protocolVersion: '2025-06-18', capabilities: {} }], ['tools/list', {}]]);
  const tools = r.get(2).result.tools;
  assert.deepEqual(tools.map(t => t.name).sort(), ['hold', 'post', 'propose', 'read', 'task']);
  for (const t of tools) {
    assert.ok(typeof t.description === 'string' && t.description.length >= 60, `${t.name}: description`);
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(t.inputSchema.additionalProperties, false, `${t.name}: additionalProperties`);
    for (const [k, v] of Object.entries(t.inputSchema.properties)) assert.ok(v.description, `${t.name}.${k}: description`);
    assert.ok(t.annotations, `${t.name}: annotations`);
    assert.equal(t.annotations.openWorldHint, false);
  }
  const by = Object.fromEntries(tools.map(t => [t.name, t]));
  assert.equal(by.read.annotations.readOnlyHint, true);
  assert.equal(by.hold.annotations.readOnlyHint, true);
  for (const n of ['post', 'propose', 'task']) {
    assert.equal(by[n].annotations.readOnlyHint, false);
    assert.equal(by[n].annotations.destructiveHint, false);
  }
});

test('mcp initialize: negotiates the protocol version; serverInfo.version is the plugin version', async () => {
  const version = readJson('.claude-plugin/plugin.json').version;
  const r = await rpc([
    ['initialize', { protocolVersion: '2025-03-26', capabilities: {} }],
    ['initialize', { protocolVersion: '1999-01-01', capabilities: {} }],
    ['initialize', { capabilities: {} }],
  ]);
  assert.equal(r.get(1).result.protocolVersion, '2025-03-26');
  const latest = r.get(2).result.protocolVersion;
  assert.match(latest, /^\d{4}-\d{2}-\d{2}$/);
  assert.notEqual(latest, '1999-01-01');
  assert.equal(r.get(3).result.protocolVersion, latest);
  for (const i of [1, 2, 3]) assert.equal(r.get(i).result.serverInfo.version, version);
});
