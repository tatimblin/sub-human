// Shared plumbing for the sub-human hooks.
//
// Hooks are trusted code run by Claude Code itself, never by a model. Identity is resolved from the
// hook payload's session_id first, then from CLAUDE_PID (Claude Code sets it for every hook it runs)
// by a direct lookup of the registered pid: /clear changes the session_id but not the claude process.
//
//   readInput({strict = true}?) -> object   the hook's stdin JSON (lib/io.ts readInput; {} when empty). strict:
//       a parse error throws (run() reports it); otherwise it gives {}.
//   resolveSeat(input, {ancestry}?) -> {code, name, role, session_id, pid, address} | null   (see below)
//   whoami(input)      resolveSeat (hooks open the room explicitly: room.open(me.code))
//   run(body, onError?), logError(err, where?), out, pre, deny, context   output helpers
//   capture(fn) -> {outputs, error}   out() collects instead of writing while fn runs (hooks/prompt.ts)

import fs from 'node:fs';
import path from 'node:path';

const PLUGIN_ROOT = path.join(import.meta.dirname, '..');
import * as identity from '../lib/identity.ts';
import * as room from '../lib/room.ts';
import * as rows from '../lib/rows.ts';
import * as text from '../lib/text.ts';
import { readInput } from '../lib/io.ts';
import * as config from '../lib/config.ts';
import { roomClaudePresence } from '../lib/room/members.ts';
import * as seatKeyMod from './seat-key.ts';
import type { HookOutput } from './types.ts';
import type { Member } from '../lib/room/types.ts';
import type { Identity } from '../lib/identity.ts';
// Every hook process may write via=human (a person's own typed words or card answers): install the seat-key
// signer (hooks/seat-key.ts). The MCP server and the CLI never load this file, so they cannot.
seatKeyMod.arm();

const CAP = config.CONTEXT_CAP;


let sink: HookOutput[] | null = null; // capture(): outputs collected instead of written (hooks/prompt.ts merges two handlers)
const out = (obj: HookOutput | null | undefined): void => { if (!obj) return; if (sink) sink.push(obj); else process.stdout.write(JSON.stringify(obj) + '\n'); };
/** Run fn with out() collecting into an array instead of stdout; returns that array (also when fn throws: err). */
function capture(fn: () => void): { outputs: HookOutput[]; error: unknown } {
  const prev = sink;
  const got: HookOutput[] = [];
  sink = got;
  try { fn(); return { outputs: got, error: null }; } catch (error) { return { outputs: got, error }; } finally { sink = prev; }
}

/** PreToolUse decisions; the reason reaches the model. */
const pre = (decision: 'allow' | 'deny' | 'ask', reason: string, extra: { updatedInput?: unknown } = {}) => out({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason, ...extra },
});
const deny = (reason: string) => pre('deny', reason);

/** additionalContext for any event that supports it. */
const context = (event: string, text: string, top: HookOutput = {}) => out({ ...top, hookSpecificOutput: { hookEventName: event, additionalContext: text } });

/** Write an error to stderr (Claude Code shows hook stderr to the user only, never to the model). */
function logError(err: unknown, where = 'hook') {
  try { process.stderr.write(`sub-human ${where} error: ${err instanceof Error && err.stack || err}\n`); } catch { /* stderr closed */ }
}

/**
 * Run a hook body. An unexpected error is always written to stderr. Then onError(err, input), when given,
 * decides the output and the exit code (gates fail closed; the row hooks exit 0 so they never disturb the
 * session); without one the hook exits 1, which Claude Code shows to the user only.
 */
function run<I extends object>(body: (input: I) => void, onError?: (err: unknown, input: Partial<I>) => void) {
  let input: I | undefined;
  try {
    const parsed: I = readInput();
    input = parsed;
    body(parsed);
  } catch (err) {
    logError(err);
    if (onError) { try { onError(err, input || {}); return; } catch (e2) { logError(e2, 'hook onError'); } }
    process.exitCode = 1;
  }
}

/** readMembers() ({name: record}) as an array, in join order. */
const members = (code: string): Member[] => Object.values<Member>(identity.readMembers(code) || {}).filter(m => m && m.name);
const hasLeft = (m: Member) => !!m.left_at;

const attempt = <T>(f: () => T): T | null => { try { return f(); } catch { return null; } };

/**
 * Who this hook runs for: {code, name, role, session_id, pid, address} or null. In order: the payload's
 * session_id; then CLAUDE_PID (Claude Code sets it for every hook) by a direct lookup of the registered
 * pid; then, only with {ancestry: true}, identity.resolveSelf() (CLAUDE_CODE_SESSION_ID, CLAUDE_PID, then
 * the nearest registered ancestor pid, which costs a `ps` table). The row hooks ask for the walk (a row
 * hook may run without CLAUDE_PID, e.g. by hand); the others never walk, so an unjoined session stays
 * cheap and a hook never borrows the seat of whatever claude process happens to be an ancestor.
 */
function resolveSeat(input: { session_id?: unknown } = {}, { ancestry = false } = {}): Identity | null {
  let me: Identity | null = input && input.session_id ? attempt(() => identity.resolveBySession(input.session_id)) : null;
  if (!me) { const pid = identity.claudePid(); if (pid) me = attempt(() => identity.resolveByPid(pid)); }
  if (!me && ancestry) me = attempt(() => identity.resolveSelf());
  return me && me.code && me.name ? me : null;
}

/** resolveSeat (a hook then opens its room explicitly: room.open(me.code)). */
const whoami = (input: { session_id?: unknown } = {}) => resolveSeat(input);

/** Best-effort presence write for the resolved member. */
function presence(me: Identity | null, state: string, detail?: string) {
  try { if (me) identity.writePresence(me.code, me.name, state, detail); } catch { /* best-effort */ }
}

// ---------- the mechanics block the join / restore hooks inject (<= BLOCK_MAX chars with 5 members) ----------
const BLOCK_MAX = config.BLOCK_MAX;
const TEMPLATE_FILES: Record<'member' | 'claude', string> = { member: 'member.md', claude: 'room-claude.md' };
/** Used only when a role file is missing or has no {CODE} placeholder. */
const DEFAULT_TEMPLATES: Record<'member' | 'claude', string> = {
  member: 'SUB-HUMAN: you are {NAME}\'s Claude in room {CODE} (with {OTHERS}). {NAME} types here.\n'
    + 'Room lines are a group chat {NAME} already sees: never repeat them. Never show room ids.\n'
    + 'Reach a session now: SendMessage to {ADDR_EXAMPLE}. Only a person\'s own plan view answer counts.',
  claude: 'SUB-HUMAN: you are claude, the room\'s Claude of room {CODE} (members: {OTHERS}). Nobody types here.\n'
    + 'Reach a member now: SendMessage to {ADDR_EXAMPLE}. To facilitate: read {PLUGIN}/skills/sub-human/facilitate.md.',
};

const pluginRoot = () => process.env.CLAUDE_PLUGIN_ROOT || PLUGIN_ROOT;

/** The role's template (skills/sub-human/member.md | room-claude.md), with placeholders unfilled. */
function template(role: string) {
  const r = role === 'claude' ? 'claude' : 'member';
  let t = '';
  try { t = fs.readFileSync(path.join(pluginRoot(), 'skills', 'sub-human', TEMPLATE_FILES[r]), 'utf8').trim(); } catch { /* default */ }
  return t.includes('{CODE}') ? t : DEFAULT_TEMPLATES[r];
}

/** The placeholder values: {NAME} {CODE} {OTHERS} {ADDR_EXAMPLE} {PLUGIN}. */
function fillVars(me: Identity, ms = members(me.code)): Record<TemplateVar, string> {
  const live = ms.filter(m => !hasLeft(m) && m.name !== me.name);
  const humans = live.filter(m => m.role !== 'claude').map(m => m.name);
  // the room's Claude only when it runs (or is starting): a stub or a failed start is not someone in the room
  const o = me.role === 'claude' ? null : roomClaudePresence(ms.find(m => m.role === 'claude'));
  const others = o ? [...humans, o === 'live' ? 'claude' : 'claude (starting)'] : humans;
  const ex = humans[0] || (me.role === 'claude' ? 'NAME' : 'claude');
  return {
    NAME: me.name, CODE: me.code, OTHERS: others.length ? others.join(', ') : 'nobody yet',
    ADDR_EXAMPLE: identity.address(ex, me.code), PLUGIN: pluginRoot(),
  };
}
type TemplateVar = 'NAME' | 'CODE' | 'OTHERS' | 'ADDR_EXAMPLE' | 'PLUGIN';
const fill = (t: string, vars: Record<TemplateVar, string>) => t.replace(/\{(NAME|CODE|OTHERS|ADDR_EXAMPLE|PLUGIN)\}/g, (_, k: TemplateVar) => vars[k]);

const roleText = (role: string, me: Identity | null) => (me ? fill(template(role), fillVars(me)) : template(role));

const clip = (s: string, n = CAP) => text.clip(s, n);

/**
 * lib/rows.ts rowCalls(); '' when it fails. Lists only the rows with no live hold in this seat's hold
 * server (rows/holds-NAME.json): rows survive /clear, compaction and a re-run of /sub-human, and a second
 * spawn would duplicate them. After --resume the server is new, so all.
 */
function rowCalls(me: Identity): string {
  try {
    const ms = identity.readMembers(me.code);
    const held = rows.readHolds(me.code, me.name);
    const only = held ? rows.rowsNeeded(me.code, me, { members: ms, held }) : null;
    return String(rows.rowCalls(me, ms, { only }) || '').trim();
  } catch (e) {
    process.stderr.write(`sub-human: rows unavailable: ${e instanceof Error ? e.message : e}\n`);
    return '';
  }
}

/**
 * rowCalls() cut to its Agent(...) lines when the full text would overflow the block. Several participant
 * calls (the room's Claude) become one call pattern plus the names, so the block stays inside the budget with 5 members.
 */
function compactRows(text: string, me: Identity): string {
  const calls = text.split('\n').map(l => l.trim()).filter(l => /^Agent\(\{.*\}\)$/.test(l));
  const tail = me.role === 'claude' ? '\nOn member_joined, follow its "row:" note.' : '';
  if (!calls.length) return `Your rows are running; make no Agent call for them.${tail}`;
  const who = calls.map(c => /subagent_type: "sub-human:participant", description: "([^"]+)"/.exec(c)).filter(m => m !== null).map(m => m[1]);
  if (who.length > 1 && who.length === calls.length) {
    const pattern = calls[0].split(`"${who[0]}"`).join('"NAME"').split(` ${who[0]}"`).join(' NAME"');
    return `Make one Agent call per name, all in one message, now; write nothing about them:\n${pattern}\nNAME = ${who.join(', ')}${tail}`;
  }
  return `Make ${calls.length === 1 ? 'this Agent call' : 'these Agent calls, in one message,'} now, exactly as written; write nothing about it:\n${calls.join('\n')}${tail}`;
}

/** The seat as a session title: its native address "alice.vole-8126" (SendMessage / ListAgents reach it by it). */
const seatTitle = (me: Identity) => identity.address(me.name, me.code);

/**
 * The context the join / restore hooks inject: the role template filled for this seat, then ROWS (rowCalls, cut
 * to the bare calls when the whole block would pass BLOCK_MAX). lead (e.g. "restored after clear") is a
 * short last line. No roster or digest: others' words arrive through the hooks module's tail child (chat, pull, wake).
 */
function contextBlock(me: Identity, lead?: string, { rowsLead = '', rowsText = null }: { rowsLead?: string; rowsText?: string | null } = {}) {
  const text = roleText(me.role, me);
  const tail = lead ? `\n(${lead})` : '';
  let rows = rowsText != null ? rowsText : rowCalls(me);
  if (rows && rowsText == null) {
    const full = `${rowsLead}${rows}`;
    rows = `${text}\n\nROWS\n${full}${tail}`.length <= BLOCK_MAX ? full : compactRows(rows, me);
  }
  return clip(`${text}${rows ? `\n\nROWS\n${rows}` : ''}${tail}`);
}

export {
  identity, room, rows, BLOCK_MAX, readInput, out, capture, pre, deny, context, run, logError, resolveSeat, whoami,
  presence, contextBlock, seatTitle,
};
