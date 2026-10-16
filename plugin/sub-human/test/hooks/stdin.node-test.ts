// Every hook handler on stdin it cannot use: empty, not JSON, or JSON that is not an object. Claude Code always sends an
// object, but a hand run, a shim bug or a truncated pipe must not block the session (exit 2; row-rewake's exit 2 is its
// asyncRewake message, and it finds its seat by CLAUDE_PID), print something that is not one JSON object, or hang past
// the hook's timeout. Each runs as hooks.json and the hooks module run it: node hooks/run.ts <handler>, which reads stdin
// once. The TaskCompleted gate's fail-closed case (exit 2 when the event name is readable) is in tasks.node-test.ts; the
// join's hidden reply on a throw past parsing is in join.node-test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { World, PLUGIN, baseEnv } from './helpers.ts';
import { HANDLERS } from '../../hooks/run.ts';

interface HookEntry { command: string; timeout?: number }
interface HooksJson { hooks: Record<string, { matcher?: string; hooks: HookEntry[] }[]> }

const HOOKS_JSON: HooksJson = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'hooks', 'hooks.json'), 'utf8'));
/** handler -> its smallest timeout (s): a hooks.json entry's, else the module's shim timeout (10 s). */
const TIMEOUTS = new Map<string, number>(HANDLERS.map(h => [h, 10]));
for (const groups of Object.values(HOOKS_JSON.hooks)) {
  for (const g of groups) {
    for (const h of g.hooks) {
      for (const m of h.command.matchAll(/hooks\/run\.ts\\?"? ([a-z-]+)/g)) TIMEOUTS.set(m[1], Math.min(TIMEOUTS.get(m[1]) ?? Infinity, h.timeout ?? 60));
    }
  }
}

// deliberately unusable stdin: nothing, a torn object, not JSON at all, JSON that is not an object
const INPUTS = ['', '{"hook_event_name":"Pre', 'not json', 'null', '[]', '"text"'];

test('stdin: every hooks.json entry runs hooks/run.ts with a handler that exists, and every handler file is one run.ts knows', () => {
  const named = new Set<string>();
  for (const groups of Object.values(HOOKS_JSON.hooks)) for (const g of groups) for (const h of g.hooks) {
    const m = /hooks\/run\.ts\\?"? ([a-z-]+)/.exec(h.command);
    assert.ok(m, `a hooks.json command runs hooks/run.ts: ${h.command}`);
    named.add(m[1]);
  }
  for (const n of named) assert.ok(HANDLERS.includes(n), n);
  const files = fs.readdirSync(path.join(PLUGIN, 'hooks', 'handlers')).filter(f => f.endsWith('.ts')).map(f => f.slice(0, -3));
  assert.deepEqual([...files].sort(), [...HANDLERS].sort());
});

test('stdin: an unknown handler exits 1 and loads nothing', () => {
  const r = spawnSync(process.execPath, [path.join(PLUGIN, 'hooks', 'run.ts'), '../reply'], { input: '{}', encoding: 'utf8', env: baseEnv() });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no hook handler/);
  assert.equal(r.stdout, '');
});

for (const [handler, timeoutS] of TIMEOUTS) {
  test(`stdin: ${handler} on empty or malformed stdin never blocks (exit 0 or 1), prints at most one JSON object, ends within its ${timeoutS} s`, t => {
    const w = new World({ claude: 'sleep', alice: 'act' }, { t });
    for (const input of INPUTS) {
      const t0 = Date.now();
      const r = spawnSync(process.execPath, [path.join(PLUGIN, 'hooks', 'run.ts'), handler], {
        input, encoding: 'utf8', cwd: w.cwd, timeout: timeoutS * 1000,
        env: baseEnv({ SUB_HUMAN_HOME: w.home, HOME: w.userHome, CLAUDE_PLUGIN_ROOT: PLUGIN, CLAUDE_PID: String(w.pid.alice), SUB_HUMAN_CLAUDE: '/usr/bin/false' }),
      });
      const what = `${handler} on ${JSON.stringify(input)}`;
      assert.equal(r.error, undefined, `${what}: ${r.error}`);
      assert.ok(Date.now() - t0 < timeoutS * 1000, `${what}: took ${Date.now() - t0} ms`);
      if (handler === 'row-rewake' && r.status === 2) {
        // its one way to speak (asyncRewake): the seat, found by CLAUDE_PID, has no rows, so it asks for them
        assert.match(r.stderr, /^sub-human: this session was resumed, and its rows are NOT running/, what);
      } else {
        assert.ok(r.status === 0 || r.status === 1, `${what}: exit ${r.status} (2 would block the session) ${r.stderr}`);
      }
      const out = r.stdout.trim();
      if (out) {
        let json: unknown;
        assert.doesNotThrow(() => { json = JSON.parse(out); }, `${what}: stdout is not JSON: ${out}`);
        assert.ok(json && typeof json === 'object' && !Array.isArray(json), `${what}: stdout is not one object: ${out}`);
      }
      // the join sees a prompt it cannot read: hidden (it may carry a PIN), never a plain exit that expands it
      if (handler === 'join' && input.trim() && input.trim() !== 'null' && !/^[["]/.test(input.trim())) {
        const j = JSON.parse(out) as { decision?: string; hookSpecificOutput?: { suppressOriginalPrompt?: boolean } };
        assert.deepEqual([j.decision, j.hookSpecificOutput?.suppressOriginalPrompt], ['block', true], `${what}: ${out}`);
      }
    }
    assert.deepEqual(w.entries().filter(e => e.via === 'human'), [], 'nothing was posted');
  });
}
