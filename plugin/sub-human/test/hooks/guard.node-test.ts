// The store guard's verdicts (mod/core/guard.ts), against a real temp home on disk. The hooks that apply them
// in-process (mod/guard.ts) are tested under `npm run test:mods` (mod/test/guard.test.ts); `decide` below does
// what they do, with node's realpath standing in for $.fs.stat's realPath. test/hooks/security.node-test.ts has the
// full Bash table.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { World, PLUGIN } from './helpers.ts';
import type * as Guard from '../../mod/core/guard.ts';
import type { GuardCtx } from '../../mod/core/types.ts';
import { sn } from '../support/brands.ts';

let g: typeof Guard;
test.before(async () => { g = await import(path.join(PLUGIN, 'mod', 'core', 'guard.ts')) as typeof Guard; });

/** A tool call's input as the table gives it. */
type ToolInput = Record<string, unknown>;

const real = (p: string) => { try { return fs.realpathSync(p); } catch { return undefined; } };
/** What mod/guard.ts decides for one call: 'allow' | 'deny' | undefined (no opinion). */
function decide(tool: string, input: ToolInput,
  { w, seated = false, hello = true, agentId }: { w: Pick<World, 'home' | 'userHome' | 'cwd'>; seated?: boolean; hello?: boolean; agentId?: string }) {
  const ctx: GuardCtx = hello ? { home: w.home, realHome: real(w.home), userHome: w.userHome, pluginRoot: PLUGIN } : {};
  if (tool.startsWith(g.MCP_PREFIX)) { const v = g.roomToolVerdict({ tool, agentId }, seated); return v ? v.decision : undefined; }
  if (tool === 'Bash') return g.bashVerdict(input.command, { ...ctx, cwd: w.cwd, realCwd: real(w.cwd) }) ? 'deny' : undefined;
  if (tool === 'Read') {
    const p = g.writeTarget(input);
    const abs = g.absTarget(p, { cwd: w.cwd, userHome: ctx.userHome });
    let placed: string | undefined;
    for (const a of abs ? g.ancestors(abs) : []) { const r = real(a); if (r) { placed = path.join(r, abs!.slice(a.length)); break; } }
    return g.readVerdict(abs ? [abs, placed] : [], ctx, p) ? 'deny' : undefined;
  }
  if (tool === 'Grep' || tool === 'Glob') {
    const targets = g.searchTargets(tool, input);
    const cands: (string | undefined)[] = [];
    for (const p of targets) {
      const abs = p ? g.absTarget(p, { cwd: w.cwd, userHome: ctx.userHome }) : g.absTarget(w.cwd, {});
      let placed: string | undefined;
      for (const a of abs ? g.ancestors(abs) : []) { const r = real(a); if (r) { placed = path.join(r, abs!.slice(a.length)); break; } }
      if (abs) cands.push(abs, placed);
    }
    return g.searchVerdict(tool, cands, ctx, targets.join(' ')) ? 'deny' : undefined;
  }
  if (g.WRITE_TOOLS.includes(tool)) {
    const p = g.writeTarget(input);
    const abs = g.absTarget(p, { cwd: w.cwd, userHome: ctx.userHome });
    let placed: string | undefined;
    for (const a of abs ? g.ancestors(abs) : []) { const r = real(a); if (r) { placed = path.join(r, abs!.slice(a.length)); break; } }
    return g.writeVerdict(abs ? [abs, placed] : [], ctx, p) ? 'deny' : undefined;
  }
  return undefined;
}

test('guard table', () => {
  const w = new World({ claude: 'sleep', alice: 'act' });
  const H = w.home;
  const realH = fs.realpathSync(H);
  const T: [string, ToolInput, boolean, string | undefined][] = [
    // [tool, input, seated, expected decision]
    ['mcp__plugin_sub-human_room__post', { text: 'hi' }, true, 'allow'],
    ['mcp__plugin_sub-human_room__read', { ids: [1] }, true, 'allow'],
    ['mcp__plugin_sub-human_room__propose', { text: 'x' }, true, 'allow'],
    ['mcp__plugin_sub-human_room__post', { text: 'hi' }, false, undefined], // not joined: no opinion
    ['mcp__plugin_sub-human_room__hold', { member: sn('bob') }, true, 'deny'], // main thread: never
    ['mcp__plugin_sub-human_room__task', { op: 'add', subject: 'x' }, true, 'allow'],
    ['Write', { file_path: path.join(H, 'rooms', w.code, 'log.jsonl'), content: 'x' }, true, 'deny'],
    ['Write', { file_path: path.join(realH, 'rooms', 'new.json'), content: 'x' }, false, 'deny'],
    ['Edit', { file_path: path.join(H, 'rooms', w.code, 'members.json'), old_string: 'a', new_string: 'b' }, true, 'deny'],
    ['MultiEdit', { file_path: path.join(H, 'sessions', 'x.json'), edits: [] }, true, 'deny'],
    ['NotebookEdit', { notebook_path: path.join(H, 'n.ipynb'), new_source: '' }, true, 'deny'],
    ['Write', { file_path: path.join(w.cwd, 'app.js'), content: 'x' }, true, undefined],
    ['Write', { file_path: 'app.js', content: 'x' }, true, undefined],
    ['Write', { file_path: path.join(w.cwd, '.sub-human-notes.md'), content: 'x' }, true, undefined],
    ['Bash', { command: `echo x >> ${H}/rooms/log.jsonl` }, true, 'deny'],
    ['Bash', { command: `node -e "require('${path.join(H, '..')}/x/sub-human/lib/room.ts')"` }, true, 'deny'],
    ['Bash', { command: 'sub-human read' }, true, undefined],
    ['Bash', { command: `sub-human show abcdef012345 --room ${w.code}` }, true, undefined],
    ['Bash', { command: `${path.join(PLUGIN, 'scripts', 'sub-human')} show abcdef012345` }, true, undefined], // what propose's reply names (lib/text.ts cliCmd)
    ['Bash', { command: `ls ${H}/rooms/${w.code}/plans` }, true, 'deny'],
    ['Bash', { command: 'npm test' }, false, undefined],
  ];
  for (const [tool, input, seated, want] of T) assert.equal(decide(tool, input, { w, seated }), want, `${tool} ${JSON.stringify(input)} seated=${seated}`);
});

test('guard: the deny text says the store is reached through sub-human and names show', () => {
  const t = g.denyText('it touches the room store (~/.sub-human)', '/p');
  assert.match(t, /the room store is reached only through sub-human\./);
  assert.doesNotMatch(t, /written only by/, 'a read is denied too: the wording is not about writes');
  assert.ok(t.includes('`/p/scripts/sub-human read|digest|who|tasks|show`'));
  assert.match(g.WRITE_DENY('Write', '/x'), /reached only through sub-human/);
});

test('guard: doctor --bundle / --fix in a session gets its own reason: a person\'s step, in a terminal, not the store wording', () => {
  for (const cmd of ['sub-human doctor --bundle', '/p/scripts/sub-human doctor --bundle /tmp/x.json', 'sub-human doctor --quick --fix']) {
    const why = g.bashVerdict(cmd);
    assert.equal(why, g.DOCTOR_WHY, cmd);
    const t = g.denyText(why!, '/p');
    assert.match(t, /^ROOM-GUARD: sub-human doctor --fix and --bundle change or write files/);
    assert.doesNotMatch(t, /reached only through sub-human|room MCP/);
    assert.ok(t.includes("the person's step: they run `node /p/scripts/sub-human doctor --bundle` (or --fix) in a terminal outside Claude Code"), t);
    assert.match(t, /\/sub-human doctor is the read-only check/);
  }
  assert.match(g.denyText(g.DOCTOR_WHY, undefined), /person's step: they run it in a terminal outside Claude Code/);
  // a sub-human folder other than ~/.sub-human is named, so the terminal acts on it (verify12 remote/05a)
  assert.ok(g.denyText(g.DOCTOR_WHY, '/p', { home: '/tmp/sh home', userHome: '/u' }).includes("they run `SUB_HUMAN_HOME='/tmp/sh home' node /p/scripts/sub-human doctor --bundle`"));
  assert.ok(g.denyText(g.DOCTOR_WHY, '/p', { home: '/u/.sub-human', userHome: '/u' }).includes('they run `node /p/scripts/sub-human doctor --bundle`'));
  assert.equal(g.homeEnv('/srv/sh/', '/u'), 'SUB_HUMAN_HOME=/srv/sh/ ');
  assert.equal(g.homeEnv('relative', '/u'), '');
  assert.equal(g.bashVerdict('sub-human doctor --quick'), null, 'the read-only doctor stays allowed');
});

test('guard: a write through a symlink into the home is denied, also into a directory not made yet', () => {
  const w = new World({ claude: 'sleep', alice: 'act' });
  const link = path.join(w.cwd, 'innocent');
  fs.symlinkSync(w.home, link);
  assert.equal(decide('Write', { file_path: path.join(link, 'rooms', w.code, 'log.jsonl'), content: 'x' }, { w }), 'deny');
  assert.equal(decide('Write', { file_path: path.join(link, 'new-dir', 'deeper', 'x.json'), content: 'x' }, { w }), 'deny');
  assert.equal(decide('Write', { file_path: 'innocent/x.json', content: 'x' }, { w }), 'deny');
});

test('guard: the default home ~/.sub-human is protected, by its path and before mod-hello by its spelling', () => {
  const w = new World({ claude: 'sleep', alice: 'act' });
  const dflt = { ...w, home: path.join(w.userHome, '.sub-human'), userHome: w.userHome, cwd: w.cwd };
  assert.equal(decide('Write', { file_path: '~/.sub-human/rooms/x', content: 'x' }, { w: dflt }), 'deny');
  assert.equal(decide('Write', { file_path: path.join(w.userHome, '.sub-human', 'rooms', 'x'), content: 'x' }, { w: dflt }), 'deny');
  assert.equal(decide('Write', { file_path: '~/.sub-human/rooms/x', content: 'x' }, { w, hello: false }), 'deny');
  assert.equal(decide('Bash', { command: 'cat ~/.sub-human/rooms/x/log.jsonl' }, { w, hello: false }), 'deny');
});

test('guard: Read of a seat signing key is denied (by path, through a symlink, before mod-hello by its spelling); the rest of the store reads', () => {
  const w = new World({ claude: 'sleep', alice: 'act' });
  const key = path.join(w.home, 'keys', w.code, 'alice.key');
  assert.equal(decide('Read', { file_path: key }, { w }), 'deny');
  assert.equal(decide('Read', { file_path: path.join(w.home, 'keys', w.code, 'alice.pub') }, { w }), 'deny');
  const link = path.join(w.cwd, 'innocent');
  fs.symlinkSync(w.home, link);
  assert.equal(decide('Read', { file_path: path.join(link, 'keys', w.code, 'alice.key') }, { w }), 'deny');
  assert.equal(decide('Read', { file_path: '~/.sub-human/keys/x/y.key' }, { w, hello: false }), 'deny');
  assert.equal(decide('Read', { file_path: path.join(w.home, 'rooms', w.code, 'log.jsonl') }, { w }), undefined, 'the log stays readable');
  assert.equal(decide('Read', { file_path: path.join(w.home, 'rooms', w.code, 'plans', 'x.md') }, { w }), undefined);
  assert.equal(decide('Read', { file_path: path.join(w.cwd, 'keys', 'mine.key') }, { w }), undefined, 'a keys directory elsewhere is not the store');
  assert.match(g.READ_DENY(key), /seat signing keys/);
});

test('guard: Read of the listener\'s and the links\' secrets is denied (listen/, links/, by path and before mod-hello)', () => {
  const w = new World({ claude: 'sleep', alice: 'act' });
  for (const p of [['listen', 'host-x25519.json'], ['links', `${w.code}.json`], ['links', w.code, 'client-x25519.json']]) {
    assert.equal(decide('Read', { file_path: path.join(w.home, ...p) }, { w }), 'deny', p.join('/'));
    assert.equal(decide('Read', { file_path: `~/.sub-human/${p.join('/')}` }, { w, hello: false }), 'deny', `${p.join('/')} before hello`);
  }
  assert.equal(decide('Read', { file_path: path.join(w.home, 'listen-notes.md') }, { w }), undefined, 'not a secret directory');
  assert.equal(decide('Read', { file_path: path.join(w.cwd, 'links', 'x.json') }, { w }), undefined, 'a links directory elsewhere');
});

test('guard: Grep is denied in a secret directory, at the home and above it (it would print a PEM); elsewhere it runs', () => {
  const w = new World({ claude: 'sleep', alice: 'act' });
  const grep = (p?: string, extra: ToolInput = {}) => decide('Grep', { pattern: '.', output_mode: 'content', ...(p === undefined ? {} : { path: p }), ...extra }, { w });
  assert.equal(grep(path.join(w.home, 'keys')), 'deny', 'the reviewer\'s probe');
  assert.equal(grep(path.join(w.home, 'keys', w.code, 'alice.key')), 'deny');
  assert.equal(grep(path.join(w.home, 'listen')), 'deny');
  assert.equal(grep(path.join(w.home, 'links')), 'deny');
  assert.equal(grep(w.home), 'deny', 'the home: ripgrep descends into keys/');
  assert.equal(grep(path.dirname(w.home)), 'deny', 'above the home');
  assert.equal(grep('/'), 'deny');
  const link = path.join(w.cwd, 'innocent');
  fs.symlinkSync(w.home, link);
  assert.equal(grep(path.join(link, 'keys')), 'deny', 'through a symlink');
  assert.equal(grep(path.join(w.home, 'rooms', w.code)), undefined, 'a room\'s files stay searchable');
  assert.equal(grep(w.cwd), undefined);
  assert.equal(grep(), undefined, 'no path: the cwd');
  assert.equal(grep('src'), undefined);
  assert.equal(decide('Grep', { pattern: '.', path: '~/.sub-human/keys' }, { w, hello: false }), 'deny', 'before hello, by its spelling');
  assert.equal(decide('Grep', { pattern: '.', path: '~/.sub-human' }, { w, hello: false }), 'deny');
  assert.match(g.READ_DENY('/x', 'Grep'), /Denied: Grep on \/x/);
});

test('guard: Glob is denied in a secret directory, by its path or its pattern\'s literal prefix; names elsewhere list', () => {
  const w = new World({ claude: 'sleep', alice: 'act' });
  const glob = (pattern: string, p?: string) => decide('Glob', { pattern, ...(p === undefined ? {} : { path: p }) }, { w });
  assert.equal(glob('**/*', path.join(w.home, 'keys')), 'deny');
  assert.equal(glob('*', path.join(w.home, 'links')), 'deny');
  assert.equal(glob('keys/**', w.home), 'deny', 'the pattern names the directory');
  assert.equal(glob(`${w.home}/listen/*.json`), 'deny', 'an absolute pattern');
  assert.equal(decide('Glob', { pattern: '~/.sub-human/keys/*' }, { w, hello: false }), 'deny', 'before hello');
  assert.equal(glob('rooms/*/plans/*.md', w.home), undefined, 'the rest of the store lists');
  assert.equal(glob('**/*.ts'), undefined);
  assert.equal(glob('**/*', w.home), undefined, 'names only: a Glob from the home lists, it reads nothing');
});

test('guard: hold is allowed for row subagents only', () => {
  const w = new World({ claude: 'sleep', alice: 'act' });
  assert.equal(decide('mcp__plugin_sub-human_room__hold', { room: w.code }, { w, seated: true, agentId: 'a1' }), 'allow');
  assert.equal(decide('mcp__plugin_sub-human_room__hold', { room: w.code }, { w, seated: false }), 'deny');
});

test('guard (live verify, stage 8c): Bash that reaches the home by a glob, a ?, a brace, a cd, or a walker above it is denied', () => {
  const ctx: GuardCtx = { home: '/tmp/shv4/home', realHome: '/private/tmp/shv4/home', userHome: '/Users/me', cwd: '/tmp/shv4/alice', claudeDir: '/Users/me/.claude', sid: 'aaaaaaaa-0000-4000-8000-000000000001' };
  const deny = (cmd: string) => assert.ok(g.bashVerdict(cmd, ctx), `should deny: ${cmd}`);
  const allow = (cmd: string) => assert.equal(g.bashVerdict(cmd, ctx), null, `should allow: ${cmd}`);
  // the live finds: each printed a seat key's path or contents
  deny('grep -rl PRIVATE /tmp/shv4');
  deny('cat /tmp/shv4/h*e/keys/*/*.key');
  deny('cat /tmp/shv4/hom?/keys/x/bob.key');
  deny('cd /tmp/shv4 && cat home/keys/*/*');
  deny('find /tmp -name "*.key" -exec cat {} +');
  deny('rg -uu PRIVATE /tmp');
  // more of the same shapes
  deny('cat /tmp/shv4/{home,x}/keys/a/b.key');
  deny('cat /private/tmp/*/home/sessions/mods/x.json');
  deny('ls /tmp/shv4 | xargs -I{} cat {}/keys/a/b.key');
  deny('tar czf /tmp/out.tgz /tmp/shv4');
  deny('cp -r /tmp/shv4 /tmp/copy');
  deny('python3 -c "import os; print(list(os.walk(\'/tmp\')))"');
  deny('cd .. && grep -r PRIVATE .');
  deny('grep -r PRIVATE ..');
  deny('ssh-keygen -y -f /tmp/shv4/home/keys/a/bob.key');
  deny('find / -name "*.key"');
  // Claude Code's history and this session's transcript: an invite line and its PIN can be in them
  deny('cat ~/.claude/history.jsonl');
  deny('grep 4829 ~/.claude/projects/*/*.jsonl');
  deny('grep -r 4829 ~/.claude');
  deny('tail -n 5 /Users/me/.claude/projects/-tmp-shv4/aaaaaaaa-0000-4000-8000-000000000001.jsonl');
  // what a session does every day
  allow('grep -r foo src');
  allow('cat /tmp/other/notes.txt');
  allow('ls /tmp');
  allow('cat README.md');
  allow('find . -name "*.ts"');
  allow('rg TODO');
  allow('npm test');
  allow('git log --oneline -5');
  allow("sed -n '1,20p' notes.txt");
  allow('cd ../bob && cat README.md');
  allow('ls ~/.claude/projects');
});

test('guard (live verify, stage 8c): Read of the module lease (sessions/), the prompt history and this session\'s transcript is denied', () => {
  const ctx: GuardCtx = { home: '/tmp/shv4/home', realHome: '/tmp/shv4/home', userHome: '/Users/me', claudeDir: '/Users/me/.claude', sid: 'aaaaaaaa-0000-4000-8000-000000000001' };
  assert.ok(g.readVerdict(['/tmp/shv4/home/sessions/mods/aaaaaaaa-0000-4000-8000-000000000001.json'], ctx));
  assert.ok(g.readVerdict(['/tmp/shv4/home/sessions/by-sid/x.json'], ctx));
  assert.ok(g.readVerdict([], {}, '~/.sub-human/sessions/mods/x.json'), 'before the hello, by its spelling');
  assert.ok(g.readVerdict(['/Users/me/.claude/history.jsonl'], ctx));
  assert.ok(g.readVerdict([], {}, '~/.claude/history.jsonl'), 'before the hello, by its name');
  assert.ok(g.readVerdict(['/Users/me/.claude/projects/-w/aaaaaaaa-0000-4000-8000-000000000001.jsonl'], ctx));
  assert.equal(g.readVerdict(['/Users/me/.claude/projects/-w/bbbbbbbb-0000-4000-8000-000000000002.jsonl'], ctx), null, 'another session\'s transcript reads');
  assert.equal(g.readVerdict(['/tmp/shv4/home/rooms/x/log.jsonl'], ctx), null, 'the room log reads');
  assert.ok(g.searchVerdict('Grep', ['/Users/me/.claude'], ctx), 'a Grep above the history');
});

test('R5 (live verify, verify6/07): ANSI-C quoting ($\'…\') is decoded as the shell does before the word is placed; one the guard cannot read is denied', () => {
  const ctx: GuardCtx = { home: '/tmp/shv6/host', realHome: '/private/tmp/shv6/host', userHome: '/Users/me', cwd: '/tmp/shv6/alice' };
  const deny = (cmd: string) => assert.ok(g.bashVerdict(cmd, ctx), `should deny: ${cmd}`);
  const allow = (cmd: string) => assert.equal(g.bashVerdict(cmd, ctx), null, `should allow: ${cmd}`);
  // the live find: zsh and bash resolve it to the store
  deny("cat /tmp/shv6/$'\\x68'ost/keys/machine.json");
  // the other escapes the shells read: octal, \u, \U, a whole word, a control-free mix, inside a cd
  deny("cat /tmp/shv6/$'\\150'ost/keys/x/bob.key");
  deny("cat /tmp/shv6/$'\\u0068\\U0000006fst'/keys/x/bob.key");
  deny("cat $'/tmp/shv6/host/keys/x/bob.key'");
  deny("cd /tmp/shv6 && cat $'h\\x6fst'/keys/*/*");
  deny("cat /tmp/$'\\x73hv6'/host/sessions/mods/x.json");
  // unterminated: not read whole, so not placed: denied
  deny("cat /tmp/shv6/$'\\x68ost/keys/a");
  // decoding helps nothing that is not the store
  allow("printf $'a\\tb\\n'");
  allow("echo $'it\\'s fine'");
  assert.equal(g.ansiC("a $'\\x41\\102\\u0043\\cA\\q' b"), 'a ABC\x01\\q b');
  assert.equal(g.ansiC('no ansi here'), 'no ansi here');
  assert.equal(g.ansiC("$'open"), null);
});

test('stage 8e A (live verify, verify8/guard/04, 06): a $ inside single quotes, double quotes or after a backslash is no ANSI-C quote; everyday shell lines with $ are allowed', () => {
  const ctx: GuardCtx = { home: '/tmp/shv8/x/home', realHome: '/private/tmp/shv8/x/home', userHome: '/Users/u', cwd: '/tmp/w', claudeDir: '/Users/u/.claude', sid: 'abcdef12-3456' };
  // the three live false denies first, then everyday lines with $ (the stage 8c guard allowed each)
  const everyday = [
    "grep -n 'foo$' README.md", "grep -cE '^[0-9]+$' /etc/hosts", "printf '%s\\n' 'a$'",
    "sed -i 's/ *$//' README.md", "awk '{print $1}' f", "awk '/end$/ {print $NF}' f", 'echo "$(git rev-parse HEAD)"',
    'echo $?', 'ls $HOME/repos', 'cat "$HOME/.zshrc"', "echo \"cost: $'\"", "grep -E 'a$|b$' f && echo ok",
    'x="$(date +%s)"; echo "$x"', "echo `echo 'a$'`", "find . -name '*.ts$'", "git log --format='%H$'",
    "perl -ne 'print if /x$/' f", "echo \\$'x", "jq '.a | test(\"z$\")' f.json", "echo $$'x'",
  ];
  for (const cmd of everyday) {
    assert.equal(g.bashVerdict(cmd, ctx), null, `should allow: ${cmd}`);
    if (cmd !== "echo $$'x'") assert.equal(g.ansiC(cmd), cmd, `no ANSI-C word the shell reads: ${cmd}`);
  }
  assert.equal(g.bashVerdict("grep -n 'foo$' README.md", {}), null, 'in a session in no room too');
  // the real ANSI-C paths stay denied, also inside $(…) in double quotes
  for (const cmd of ["cat /tmp/shv8/x/ho$'\\x6d'e/rooms/AB/log.jsonl", "cat /tmp/shv8/x/ho$'\\155'e/x", "cat /tmp/shv8/x/ho$'m'e/x",
    "cat /tmp/shv8/x/ho$'me/x", 'echo "$(cat /tmp/shv8/x/ho$\'m\'e/x)"', "echo `cat /tmp/shv8/x/ho$'m'e/x`"]) {
    assert.ok(g.bashVerdict(cmd, ctx), `should deny: ${cmd}`);
  }
  assert.equal(g.ansiC("echo 'a$' $'\\x41'"), "echo 'a$' A");
  assert.equal(g.ansiC("echo \"$'x\""), "echo \"$'x\"", 'inside double quotes $\' is literal');
});

test('stage 8f item 5: $\'…\' inside ${…} in double quotes, $"…" strings and a case pattern inside $(…) are read as the shell reads them; a quoted heredoc\'s body is literal', () => {
  const ctx: GuardCtx = { home: '/tmp/shv11/home', realHome: '/private/tmp/shv11/home', userHome: '/Users/u', cwd: '/tmp/w' };
  const deny = (cmd: string) => assert.ok(g.bashVerdict(cmd, ctx), `should deny: ${cmd}`);
  const allow = (cmd: string) => assert.equal(g.bashVerdict(cmd, ctx), null, `should allow: ${cmd}`);
  // bash decodes $'…' inside "${…}"; with u unset the word is the store
  assert.equal(g.ansiC("cat \"/t/${u:-$'\\x68'}ome\""), 'cat "/t/${u:-h}ome"');
  deny("cat \"/tmp/shv11/${u:-$'\\x68'}ome/keys/k\"");
  deny("cat /tmp/shv11/${u:-home}/keys/k");
  // $"…" is a double-quoted string (a locale lookup): /x/$"home" is /x/home
  assert.equal(g.ansiC('cat /t/$"home"/k'), 'cat /t/"home"/k');
  deny('cat /tmp/shv11/$"home"/keys/k');
  assert.equal(g.ansiC('echo "A$"B"C"'), 'echo "A$"B"C"', 'inside double quotes $" is a $ and the closing quote');
  // a case pattern's ) inside $(…) in double quotes does not close the $(
  deny("x=\"$(case a in a) cat /tmp/shv11/$'\\x68'ome/keys/k;; esac)\"");
  deny("x=\"$(case a in (a) cat /tmp/shv11/$'\\x68'ome/keys/k;; esac) $'\\x68'\"");
  assert.equal(g.ansiC("echo \"$(case a in a) echo x;; esac) $'q'\""), "echo \"$(case a in a) echo x;; esac) $'q'\"", 'after esac) the double quotes hold again');
  // a quoted heredoc's body is literal: a lone $' in a commit message is fine
  allow("git commit -m \"$(cat <<'EOF'\nGuard: read $' only unquoted\nEOF\n)\"");
  allow("cat > s.sh <<'EOF'\nIFS=$'\\n'\necho $'\nEOF");
  allow("cat <<-\"EOF\"\n\t$'x\n\tEOF\necho done");
  allow("cat <<EOF\n$'x\nEOF");
  // an unquoted heredoc's body still runs its $(…): a path there is read as the shell reads it
  deny("cat <<EOF\n$(cat /tmp/shv11/$'\\x68'ome/keys/k)\nEOF");
  // and the line after the heredoc is the shell's again
  deny("cat <<'EOF'\n$'\nEOF\ncat /tmp/shv11/$'\\x68'ome/keys/k");
  allow("cat <<< 'a$'");
});
