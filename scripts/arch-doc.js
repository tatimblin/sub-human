#!/usr/bin/env node
'use strict';
/**
 * arch-doc: regenerate the generated sections of docs/ARCHITECTURE.md, so they can't drift from the code.
 *
 *   node scripts/arch-doc.js            rewrite the sections in place (npm run docs)
 *   node scripts/arch-doc.js --check    exit 1 when the committed doc is stale (scripts/test/arch-doc.test.js)
 *
 * A section is the text between `<!-- gen:NAME -->` and `<!-- /gen:NAME -->`; everything else is hand-written
 * and left alone. Sections:
 *   hooks        hooks/hooks.json: event, matcher, script, timeout, async
 *   mod-hooks    the hooks module's function hooks: mod/register.ts HOOKS (event, matcher, file, what it does)
 *   mcp-tools    the room MCP server's tools/list (spawned for real, so plug-ins are included)
 *   cc-contract  lib/cc.ts CONTRACT: id, internals-doc section, stability, note
 *   lib-modules  lib/**.ts (and lib/vendor's .js): each module's header comment, first sentence
 *
 *   generate() -> Promise<{name: markdown}>    render(doc, sections) -> doc    DOC (the doc's path)
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { REPO, PLUGIN } = require('./lib/paths.js');

const DOC = path.join(REPO, 'docs', 'ARCHITECTURE.md');
const cell = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const code = s => '`' + cell(s) + '`';
const table = (head, rows) => [
  `| ${head.join(' | ')} |`,
  `|${head.map(() => '---').join('|')}|`,
  ...rows.map(r => `| ${r.join(' | ')} |`),
].join('\n');

/** The first sentence of s (a second one too when the first is short), skipping boilerplate. */
function firstSentence(s, min = 50) {
  const parts = String(s).split(/(?<=[.])\s+(?=[A-Z(`"])/).filter(p => !/^(CommonJS|Zero dependencies)/i.test(p));
  let out = parts[0] || '';
  if (out.length < min && parts[1]) out += ' ' + parts[1];
  return out.trim();
}

// ---------- hooks ----------
function hooksSection() {
  const cfg = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'hooks', 'hooks.json'), 'utf8')).hooks;
  const rows = [];
  for (const [event, groups] of Object.entries(cfg)) {
    for (const g of groups) {
      for (const h of g.hooks) {
        // node hooks/run.ts HANDLER: the handler's file (hooks/handlers/HANDLER.ts)
        const m = /hooks\/run\.ts"? ([\w-]+)$/.exec(h.command || '');
        const mode = h.asyncRewake ? 'asyncRewake' : h.async ? 'async' : '—';
        rows.push([event, g.matcher ? code(g.matcher) : '(all)', m ? code(`hooks/handlers/${m[1]}.ts`) : code(h.command), h.timeout != null ? `${h.timeout} s` : 'default', mode]);
      }
    }
  }
  return table(['Event', 'Matcher', 'Handler (hooks/run.ts)', 'Timeout', 'Async'], rows);
}

// ---------- function hooks ----------
async function modHooksSection() {
  const { HOOKS } = await import(path.join(PLUGIN, 'mod', 'register.ts'));
  const rows = HOOKS.map(h => [code(h.event), h.matcher ? code(h.matcher) : '(all)', code(h.file), cell(h.does)]);
  return 'From `mod/register.ts` (hooks.json `modules`), in registration order.\n\n' + table(['Event', 'Matcher', 'File', 'Does'], rows);
}

// ---------- MCP tools ----------
/** Spawn the room server, ask for tools/list, and stop it. Resolves the tool array. */
function listTools() {
  const server = path.join(PLUGIN, 'mcp', 'room-server.ts');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-archdoc-'));
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(CLAUDE|SUB_HUMAN)/.test(k)) env[k] = v;
  env.SUB_HUMAN_HOME = home;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [server], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '', done = false;
    const finish = (err, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      fs.rmSync(home, { recursive: true, force: true });
      err ? reject(err) : resolve(v);
    };
    const timer = setTimeout(() => finish(new Error('room server: no tools/list reply in 10 s')), 10_000);
    child.on('error', e => finish(e));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', d => {
      buf += d;
      for (const line of buf.split('\n').slice(0, -1)) {
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 2) finish(m.error ? new Error(m.error.message) : null, m.result.tools);
      }
      buf = buf.slice(buf.lastIndexOf('\n') + 1);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  });
}

async function mcpSection() {
  const mcp = JSON.parse(fs.readFileSync(path.join(PLUGIN, '.mcp.json'), 'utf8')).mcpServers;
  const serverName = Object.keys(mcp)[0];
  const owner = {};
  for (const f of ['hold.ts', 'task.ts']) owner[require(path.join(PLUGIN, 'mcp', f)).TOOL.name] = `mcp/${f}`;
  const tools = await listTools();
  const rows = tools.map(t => [
    code(t.name),
    `${serverName} (${code(owner[t.name] || 'mcp/room-server.ts')})`,
    t.annotations && t.annotations.readOnlyHint ? 'yes' : 'no',
    cell(firstSentence(t.description, 0)),
  ]);
  return `Full names are \`mcp__plugin_sub-human_${serverName}__<tool>\`.\n\n` + table(['Tool', 'Server (module)', 'readOnly', 'Description'], rows);
}

// ---------- cc contract ----------
function ccSection() {
  const { CONTRACT } = require(path.join(PLUGIN, 'lib', 'cc.ts'));
  const rows = CONTRACT.map(c => [code(c.id), `§${c.section}`, c.stability, cell(c.note)]);
  return table(['Id', '§', 'Stability', 'Note'], rows);
}

// ---------- lib modules ----------
/** The module's first header comment (a `/** … *\/` block), its first paragraph as one line. */
function headerOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  const m = /\/\*\*([\s\S]*?)\*\//.exec(src);
  if (!m) return '';
  const lines = m[1].split('\n').map(l => l.replace(/^\s*\* ?/, ''));
  const para = [];
  for (const l of lines) {
    if (!l.trim()) { if (para.length) break; continue; }
    para.push(l.trim());
  }
  return para.join(' ').replace(/^plugin\/sub-human\/[\w/.-]+\.[jt]s:\s*/, '');
}

function libSection() {
  const lib = path.join(PLUGIN, 'lib');
  const files = [];
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.[jt]s$/.test(e.name) && !e.name.endsWith('.d.ts')) files.push(p); // .ts, and lib/vendor's .js
    }
  };
  walk(lib);
  files.sort((a, b) => path.relative(lib, a).localeCompare(path.relative(lib, b)));
  return files.map(f => `- ${code(path.relative(PLUGIN, f))}: ${cell(firstSentence(headerOf(f)))}`).join('\n');
}

// ---------- assembly ----------
async function generate() {
  return {
    hooks: hooksSection(),
    'mod-hooks': await modHooksSection(),
    'mcp-tools': await mcpSection(),
    'cc-contract': ccSection(),
    'lib-modules': libSection(),
  };
}

/** doc with each gen section's body replaced. A marker pair missing from doc is an error. */
function render(doc, sections) {
  let out = doc;
  for (const [name, body] of Object.entries(sections)) {
    const open = `<!-- gen:${name} -->`, close = `<!-- /gen:${name} -->`;
    const a = out.indexOf(open), b = out.indexOf(close);
    if (a < 0 || b < a) throw new Error(`${path.relative(REPO, DOC)}: missing ${open} … ${close}`);
    out = out.slice(0, a + open.length) + '\n' + body + '\n' + out.slice(b);
  }
  return out;
}

async function main(argv) {
  const check = argv.includes('--check');
  const doc = fs.readFileSync(DOC, 'utf8');
  const next = render(doc, await generate());
  if (check) {
    if (next !== doc) { process.stderr.write('docs/ARCHITECTURE.md is stale: run npm run docs\n'); return 1; }
    return 0;
  }
  if (next !== doc) fs.writeFileSync(DOC, next);
  process.stdout.write(next !== doc ? 'docs/ARCHITECTURE.md updated\n' : 'docs/ARCHITECTURE.md up to date\n');
  return 0;
}

if (require.main === module) main(process.argv.slice(2)).then(c => { process.exitCode = c; }, e => { process.stderr.write(`${e.stack || e}\n`); process.exitCode = 1; });

module.exports = { DOC, generate, render, firstSentence, headerOf };
