/**
 * plugin/sub-human/mod/register.ts: the module hooks.json names under `modules`; register(on) calls each part's
 * registerX(on). An event is hooked once per module without a matcher (validate), so each such event lives in one file.
 * The mod routes, node writes: nothing under mod/ writes room state or holds the seat key, and it knows the store only
 * from the hello (hooks/handlers/mod-hello.ts, kept in $.state), or, for a session with no session index, from the
 * environment (mod/core/seat.ts localHello). Every node start is `node hooks/run.ts <handler>` (mod/core/shim.ts
 * shimArgv), and only where the handler can act (mod/core/prefilter.ts): a session with no seat starts none but for
 * /sub-human. hooks.json keeps only the /sub-human expansion and SessionEnd as command hooks. Every `$` call sits in the file that registers the hook
 * (cc CONTRACT module-dollar-local); mod/core/*.ts is pure and tested in node.
 *
 *   HOOKS     every hook the module registers, {event, matcher, file, does}: the one place each hook's behaviour is
 *             described. scripts/arch-doc.js renders it; test/mod-core.node-test.ts checks it against validate.
 */
import { registerGuard } from './guard.ts';
import { registerRender } from './render.ts';
import { registerPrompt } from './prompt.ts';
import { registerConsent } from './consent.ts';
import { registerTasks } from './tasks.ts';
import { registerDeliver } from './deliver.ts';
import { registerSend } from './send.ts';
import { registerRows } from './rows.ts';
import type { On } from 'claude-code';

export const HOOKS = [
  { event: 'session.start', matcher: '', file: 'mod/deliver.ts', does: 'the hello: with no session index for this id (<home>/sessions/by-sid, $.fs.exists) and no seat known in this process, the module\'s own (the home from SUB_HUMAN_HOME or HOME, no seat; no node); else node mod-hello with the session\'s nonce (minted once per session id into $.state; the lease keeps it; home, plugin root, seat, restorable into $.state); unless surely unseated, starts the tail child (node scripts/sub-human tail --ndjson, restarted with backoff; the seat\'s only delivery) and routes its events: chat -> $.ui.log (typed through Remote Control: relayed as a prompt of only the room lines, asUser, batched one per RELAY_GAP_MS), pull -> isMeta append, wake -> $.prompt.submit (mid-turn: append), rows -> $.state' },
  { event: 'command.run', matcher: 'command sub-human:sub-human|sub-human', file: 'mod/deliver.ts', does: 'first the lease (node mod-hello, once per session id: the join refuses a session without one); answers /sub-human itself when typed here (or through Remote Control with no PIN in it; never in the room\'s Claude): node join through the shim (sub_human_via, the nonce), then its reply as $.ui.log notices with an empty answer (no row, nothing for the model to read or repeat; through Remote Control a reply with no secret is the command\'s output {text}), so none reads "blocked by hook"; a join that worked expands as before (next), its mechanics block handed to the expansion hook below, and a one-line confirmation logged; then mod-hello again, and the tail child for a seat or a PIN join of this session waiting for the host\'s card (hello pending: its tail says when the host let it in). .catch passes it on to the classic hook' },
  { event: 'classic.UserPromptExpansion', matcher: 'command_name ^(sub-human:)?sub-human$', file: 'mod/deliver.ts', does: 'the lease first, unless command.run ran the join; after the join (the join hook beneath, or the mechanics block of the one command.run took, without running it again), runs mod-hello again for the new seat and starts the tail child for a seat' },
  { event: 'classic.SessionStart', matcher: '', file: 'mod/deliver.ts', does: 'clear, compact or resume, unless the hello is sure there is no seat and nothing to restore, and every fork (← the agent view): node session-restore (puts the seat back, a /clear rebinding it to the new session id, a fork taking the seat its old session held; the mechanics block and the title as context), then mod-hello for that id, reviewMaybeOpen unsure, and on a resume node row-rewake in the background (its row calls a wake, one line shown); the tail child for a seat' },
  { event: 'session.end', matcher: '', file: 'mod/deliver.ts', does: 'stops that session id\'s tail child' },
  { event: 'turn.start', matcher: '', file: 'mod/deliver.ts', does: 'marks a main-loop turn running (a wake then appends instead of submitting); a turn a typed prompt started writes node presence "working" (not awaited; a prompt the plugin stops or refuses starts no turn, so it writes none)' },
  { event: 'turn.complete', matcher: '', file: 'mod/deliver.ts', does: 'marks idle; submits a mid-turn wake no request carried (none followed a tool call that finished after it), and schedules the Remote Control relay held during the turn; after a turn that was "working" or waited on the person ("permission"), node presence "idle" (not awaited: an idle_prompt notification may never come)' },
  { event: 'classic.PostToolUse', matcher: '', file: 'mod/deliver.ts', does: 'observes when a main-loop tool call finished (a model request follows it, carrying a mid-turn wake); after a "permission" notification, node presence "working" again (the person answered)' },
  { event: 'classic.PostToolUseFailure', matcher: '', file: 'mod/deliver.ts', does: 'the same, for a tool call that failed' },
  { event: 'tool.call', matcher: 'Bash', file: 'mod/guard.ts', does: 'denies a command that names the store or runs the plugin\'s code (mod/core/guard.ts bashVerdict); .catch fails closed on "sub-human"' },
  { event: 'tool.call', matcher: 'Write|Edit|MultiEdit|NotebookEdit', file: 'mod/guard.ts', does: 'denies a write into the store, lexically or after $.fs.stat realPath; .catch fails closed on "sub-human"' },
  { event: 'tool.call', matcher: 'Read', file: 'mod/guard.ts', does: 'denies a read under the home\'s secret directories (<home>/keys, listen, links; lexically or after $.fs.stat realPath); the rest of the store stays readable' },
  { event: 'tool.call', matcher: '/^(?:Grep|Glob)$/', file: 'mod/guard.ts', does: 'the same roots for a search path (none: the cwd) and a Glob pattern\'s literal prefix; a Grep at the home or above it too; .catch fails closed on "sub-human"' },
  { event: 'tool.call', matcher: 'mcp__plugin_sub-human_room__hold', file: 'mod/guard.ts', does: 'denies hold outside a row subagent (no agentId)' },
  { event: 'tool.check', matcher: '/^mcp__plugin_sub-human_room__/', file: 'mod/guard.ts', does: 'allows the room tools for a seated session (no permission prompt); hold only with agentId' },
  { event: 'command.run', matcher: '', file: 'mod/prompt.ts', does: 'in the room\'s Claude (SUB_HUMAN_ROOM set) a slash command a person typed (composer, Remote Control), /clear included, is answered with the refusal and never runs; /sub-human (its launch) and every other session pass on' },
  { event: 'prompt.submit', matcher: '', file: 'mod/prompt.ts', does: 'a relay of this module\'s own (mod/deliver.ts) passes with RELAY_CONTEXT as context; drops an @room (or, in a room, an @claude) whose origin is not composer, sdk or bridge (a peer, a notification, a plugin); a typed origin says whether the person is on Remote Control (bridge) or here; hands the origin to the shim below; a typed prompt the tail child delivers for carries the held rows text as context (once per change of that text: $.state rowsInjected) and marks "working" presence pending (turn.start writes it, unless already working for this seat); .catch drops only an @room' },
  { event: 'classic.Notification', matcher: 'notification_type idle_prompt|permission_prompt', file: 'mod/prompt.ts', does: 'node presence (idle, permission), not awaited, for a seat or when unsure; the next typed prompt writes "working" again' },
  { event: 'classic.StopFailure', matcher: '', file: 'mod/prompt.ts', does: 'node presence (error, its code), not awaited, for a seat or when unsure' },
  { event: 'classic.UserPromptSubmit', matcher: '', file: 'mod/prompt.ts', does: 'sessionTitle NAME.CODE once per session id (members); no node for a relay, nor when not an @room (or a seated @claude) and surely unseated, or a member\'s seat the tail child delivers for with no review open; an @room surely unseated is refused here (at-room\'s words, no node); else node prompt with sub_human_origin and the session\'s nonce, which at-room checks against the lease (systemMessage via $.ui.log; typed through Remote Control, a refusal is relayed as a prompt after the hook returns)' },
  { event: 'session.append', matcher: 'door notice', file: 'mod/prompt.ts', does: 'keeps the warning row of an @room\'s stop (the shim\'s "✓ sent", "⧗ queued: …") as the receipt alone, without Claude Code\'s "Operation stopped by hook: " frame; only a row that is exactly that frame around a receipt the shim just returned; the model\'s isMeta copy is left alone. .catch passes the row on' },
  { event: 'tool.call', matcher: 'EnterPlanMode|ExitPlanMode', file: 'mod/consent.ts', does: 'sets reviewMaybeOpen (a room review starts only through these); an ExitPlanMode the person refused in the plan view goes to node consent at once (a PostToolUseFailure payload with the refusal\'s text): a note opens, its line rides on the refusal, the person gets a notice' },
  { event: 'classic.PreToolUse', matcher: 'AskUserQuestion|EnterPlanMode|ExitPlanMode|/^mcp__plugin_sub-human_room__/', file: 'mod/consent.ts', does: 'node consent (the card rewrite, the review\'s allow and ask with the proposal as the plan, the exit): on a room tool only while a review may be open, else for a seat or when unsure; the payload\'s session_id, transcript_path and permission_mode from what the module last saw (the event carries the call alone); next(e) always, ours above it (mergePre); an allow\'s reason a notice' },
  { event: 'classic.PostToolUse', matcher: 'tool_name AskUserQuestion|EnterPlanMode|ExitPlanMode', file: 'mod/consent.ts', does: 'node consent (records the person\'s answer, restores the plan file and the mode) for a seat or when unsure' },
  { event: 'classic.PermissionRequest', matcher: 'tool_name ExitPlanMode', file: 'mod/consent.ts', does: 'node consent (closes a review without a dialog) while a review may be open; a deny beneath wins' },
  { event: 'classic.Stop', matcher: '', file: 'mod/consent.ts', does: 'node consent (the open-review nudge) only while a review may be open or the seat is unknown' },
  { event: 'classic.PostToolUse', matcher: 'tool_name TaskCreate|TaskUpdate', file: 'mod/tasks.ts', does: 'node tasks (the room task mirror) only for the room\'s Claude or an unknown seat' },
  { event: 'classic.TaskCompleted', matcher: '', file: 'mod/tasks.ts', does: 'node tasks (the gate; exit 2 -> block) only for the room\'s Claude or an unknown seat; .catch blocks in the room\'s Claude' },
  { event: 'tool.call', matcher: 'Agent', file: 'mod/rows.ts', does: 'keeps the call\'s agentId while it runs, for classic.PreToolUse beneath (which carries none); always next(e)' },
  { event: 'classic.PreToolUse', matcher: 'Agent', file: 'mod/rows.ts', does: 'node row-guard (denies a duplicate row, or a member\'s stray participant row) for a row agent in a seated or unsure session; next(e) always, ours above it (mergePre)' },
  { event: 'classic.PostToolUse', matcher: 'tool_name Agent|Task', file: 'mod/rows.ts', does: 'node row-map (which panel row the spawned row agent is) for a row agent in a seated or unsure session' },
  { event: 'classic.SubagentStop', matcher: '', file: 'mod/rows.ts', does: 'node row-hold (a row that gave up is told to hold again: block) for a row agent in a seated or unsure session' },
  { event: 'ui.render', matcher: 'UserMessage, origin peer|peer-send-message|plugin', file: 'mod/render.ts', does: 'draws another member\'s Claude as "bob\'s Claude: …" (the room\'s Claude as "the room\'s Claude: …") and a sub-human prompt as its chat lines, its "(for Claude)" lines one dim marker; its .catch draws this plugin\'s own prompts, whose render leaves the hook out for re-entry, from plain data' },
  { event: 'session.send', matcher: '', file: 'mod/send.ts', does: 'a SendMessage to NAME.CODE of this room whose seat is on another machine (its seat record\'s machine is not this home\'s machine id; the native send reaches only this machine\'s sessions) is posted to the room instead, addressed to NAME, through the room server ($.mcp.call post), and answered delivered (or not, with the room\'s refusal); anything else, or a failure, passes on' },
];

export function register(on: On) {
  registerDeliver(on);
  registerGuard(on);
  registerPrompt(on);
  registerConsent(on);
  registerTasks(on);
  registerRows(on);
  registerRender(on);
  registerSend(on);
}
