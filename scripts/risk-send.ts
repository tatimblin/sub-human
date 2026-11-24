#!/usr/bin/env node
/**
 * risk-send: U6's risk 1 in a real session (docs/internals/v2-risks.md). The kit has no engine core beneath the
 * plugins, so whether Claude Code honours a `session.send` answer given without `next` needs a real run.
 *
 * A temp plugin's module hooks session.send: for `*.TESTROOM` it records the send and answers `{ isDelivered: true }`
 * without `next`; any other address goes on with `next` and its result is recorded (the control). At session.start
 * it also sends, model-free, through `$.session.send` and `$.tool.call` of SendMessage. Then one `claude -p` (the
 * pinned 2.1.330, the default model, capped at $0.10) is asked to SendMessage `bob.TESTROOM` and `carol.ELSEWHERE`.
 * The evidence: what the hook recorded, each SendMessage tool result as the model read it, and the reply.
 *
 *   node scripts/risk-send.ts                 the model run; print the evidence as JSON
 *   node scripts/risk-send.ts --model-free    only the session.start probes (`claude -p /cost`, no model turn, $0);
 *                                             plugin origin only: the model origin and the control need the model run
 */
import fs from 'node:fs';
import path from 'node:path';
import { tempPlugin, runClaude, outcome, debugLines, cleanUp } from './risk-detach.ts';

// The module compiler refuses a $ passed to a helper, so each hook writes the whole record itself.
const moduleFor = (out: string): string => `// risk 1: catch *.TESTROOM at the sender, answer delivered without next.
const OUT = ${JSON.stringify(out)}
const lines = []
const add = (o) => { lines.push(JSON.stringify(o)); return lines.join('\\n') + '\\n' }
export function register(on) {
  on('session.send', async ($, e, next) => {
    const seen = { hook: 'session.send', to: e.to, text: e.text, origin: e.origin, agentId: e.agentId ?? null }
    if (/\\.TESTROOM$/.test(e.to)) { await $.fs.write(OUT, add({ ...seen, answer: 'isDelivered:true without next' })); return { isDelivered: true } }
    const r = await next(e)
    await $.fs.write(OUT, add({ ...seen, answer: 'next', result: r }))
    return r
  })
  on('session.receive', async ($, e, next) => { await $.fs.write(OUT, add({ hook: 'session.receive', text: String(e.text).slice(0, 200) })); return next(e) })
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    let sent
    try { sent = { result: await $.session.send({ to: 'alice.TESTROOM', text: 'model-free' }) } } catch (err) { sent = { threw: String(err) } }
    await $.fs.write(OUT, add({ probe: '$.session.send', ...sent }))
    void (async () => {
      let called
      try { called = { result: await $.tool.call({ tool: 'SendMessage', to: 'dave.TESTROOM', message: 'model-free tool call' }) } } catch (err) { called = { threw: String(err) } }
      await $.fs.write(OUT, add({ probe: '$.tool.call SendMessage', ...called }))
    })()
    return started
  })
}
`;

const PROMPT = 'Use the SendMessage tool twice, one call after the other: first to "bob.TESTROOM" with message "hello", '
  + 'then to "carol.ELSEWHERE" with message "hello". Then reply with each tool result exactly as you received it, one per line, and nothing else.';

const field = (o: unknown, k: string): unknown => (o && typeof o === 'object' && k in o ? Object.getOwnPropertyDescriptor(o, k)?.value : undefined);
const blocks = (e: unknown): unknown[] => { const c = field(field(e, 'message'), 'content'); return Array.isArray(c) ? c : []; };

function main(): number {
  const t = tempPlugin('send', '');
  const out = path.join(t.dir, 'hook.jsonl');
  fs.writeFileSync(path.join(t.plugin, 'module', 'register.ts'), moduleFor(out));
  // --model-free: a local command, so no model turn runs; only the session.start probes send.
  const modelFree = process.argv.includes('--model-free');
  const run = runClaude(t, modelFree ? '/cost' : PROMPT, modelFree ? '0.01' : '0.10');
  const calls = run.events.flatMap(blocks).filter(b => field(b, 'type') === 'tool_use' && field(b, 'name') === 'SendMessage')
    .map(b => ({ id: field(b, 'id'), input: field(b, 'input') }));
  const results = run.events.flatMap(blocks).filter(b => field(b, 'type') === 'tool_result')
    .map(b => ({ id: field(b, 'tool_use_id'), isError: field(b, 'is_error') ?? false, content: field(b, 'content') }));
  const toolResults = run.events.map(e => field(e, 'tool_use_result')).filter(r => r !== undefined);
  const hook = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim().split('\n').map((l): unknown => JSON.parse(l)) : [];
  const debug = debugLines(t.dir, /risk-send|session\.send|SendMessage|skipped/i).slice(0, 30);
  cleanUp(t);
  // /cost's result is the person's account usage, not evidence.
  const { result, ...rest } = outcome(run.events);
  const ended = modelFree ? rest : { ...rest, result };
  process.stdout.write(`${JSON.stringify({ dir: t.dir, claudeExit: run.status, ...ended, calls, results, toolResults, hook, debug }, null, 2)}\n`);
  return run.status === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = main();
