/**
 * plugin/sub-human/mod/register.ts: the module hooks.json names under `modules`; register(on) calls each part's
 * registerX(on). An event is hooked once per module without a matcher (validate), so each such event lives in one file.
 * The mod routes, node writes: nothing under mod/ writes room state or holds the seat key, and it knows the store only
 * from the hello (hooks/mod-hello.ts, kept in $.state). Every `$` call sits in the file that registers the hook
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
import type { On } from 'claude-code';

export const HOOKS = [
  { event: 'session.start', matcher: '', file: 'mod/deliver.ts', does: 'runs hooks/mod-hello.ts with the session\'s nonce (minted once per session id into $.state; the lease keeps it; home, plugin root, seat into $.state); unless surely unseated, starts the tail child (node scripts/sub-human tail --ndjson, restarted with backoff; the seat\'s only delivery) and routes its events: chat -> $.ui.log (typed through Remote Control: relayed as a prompt of only the room lines, asUser, batched one per RELAY_GAP_MS), pull -> isMeta append, wake -> $.prompt.submit (mid-turn: append), rows -> $.state' },
  { event: 'command.run', matcher: 'command sub-human:sub-human|sub-human', file: 'mod/deliver.ts', does: 'answers /sub-human itself when typed here (or through Remote Control with no PIN in it; never in the room\'s Claude): node hooks/join.ts through the shim (sub_human_via, the nonce), then its reply as $.ui.log notices with an empty answer (no row, nothing for the model to read or repeat; through Remote Control a reply with no secret is the command\'s output {text}), so none reads "blocked by hook"; a join that worked expands as before (next), its mechanics block handed to the expansion hook below, and a one-line confirmation logged; then mod-hello again. .catch passes it on to the classic hook' },
  { event: 'classic.UserPromptExpansion', matcher: 'command_name ^(sub-human:)?sub-human$', file: 'mod/deliver.ts', does: 'after the join (hooks/join.ts beneath, or the mechanics block of the one command.run took, without running it again), runs mod-hello again for the new seat and starts the tail child' },
  { event: 'classic.SessionStart', matcher: 'source clear|compact|resume', file: 'mod/deliver.ts', does: 'after session-restore beneath (a /clear rebinds the seat to a new session id), runs mod-hello again and starts the tail child for that id; reviewMaybeOpen unsure' },
  { event: 'session.end', matcher: '', file: 'mod/deliver.ts', does: 'stops that session id\'s tail child' },
  { event: 'turn.start', matcher: '', file: 'mod/deliver.ts', does: 'marks a main-loop turn running (a wake then appends instead of submitting)' },
  { event: 'turn.complete', matcher: '', file: 'mod/deliver.ts', does: 'marks idle; submits a mid-turn wake no request carried (none followed a tool call that finished after it), and schedules the Remote Control relay held during the turn' },
  { event: 'classic.PostToolUse', matcher: '', file: 'mod/deliver.ts', does: 'observes when a main-loop tool call finished (a model request follows it, carrying a mid-turn wake)' },
  { event: 'classic.PostToolUseFailure', matcher: '', file: 'mod/deliver.ts', does: 'the same, for a tool call that failed' },
  { event: 'tool.call', matcher: 'Bash', file: 'mod/guard.ts', does: 'denies a command that names the store or runs the plugin\'s code (mod/core/guard.ts bashVerdict); .catch fails closed on "sub-human"' },
  { event: 'tool.call', matcher: 'Write|Edit|MultiEdit|NotebookEdit', file: 'mod/guard.ts', does: 'denies a write into the store, lexically or after $.fs.stat realPath; .catch fails closed on "sub-human"' },
  { event: 'tool.call', matcher: 'Read', file: 'mod/guard.ts', does: 'denies a read of a seat signing key (<home>/keys, lexically or after $.fs.stat realPath); the rest of the store stays readable' },
  { event: 'tool.call', matcher: 'mcp__plugin_sub-human_room__hold', file: 'mod/guard.ts', does: 'denies hold outside a row subagent (no agentId)' },
  { event: 'tool.check', matcher: '/^mcp__plugin_sub-human_room__/', file: 'mod/guard.ts', does: 'allows the room tools for a seated session (no permission prompt); hold only with agentId' },
  { event: 'prompt.submit', matcher: '', file: 'mod/prompt.ts', does: 'a relay of this module\'s own (mod/deliver.ts) passes with RELAY_CONTEXT as context; drops an @room (or, in a room, an @claude) whose origin is not composer, sdk or bridge (a peer, a notification, a plugin); a typed origin says whether the person is on Remote Control (bridge) or here; hands the origin to the shim below; a typed prompt the tail child delivers for carries the held rows text as context (once per change of that text: $.state rowsInjected) and writes "working" presence (node hooks/presence.ts, not awaited) unless already working; .catch drops only an @room' },
  { event: 'classic.Notification', matcher: 'notification_type idle_prompt|permission_prompt', file: 'mod/prompt.ts', does: 'notes the presence presence.ts beneath writes, so the next prompt writes "working" again' },
  { event: 'classic.StopFailure', matcher: '', file: 'mod/prompt.ts', does: 'notes the error presence presence.ts beneath writes' },
  { event: 'classic.UserPromptSubmit', matcher: '', file: 'mod/prompt.ts', does: 'sessionTitle NAME.CODE once per session id (members); no node for a relay, nor when not an @room (or a seated @claude) and surely unseated, or a member\'s seat the tail child delivers for with no review open; else node hooks/prompt.ts with sub_human_origin and the session\'s nonce, which at-room checks against the lease (systemMessage via $.ui.log; typed through Remote Control, a refusal is relayed as a prompt after the hook returns)' },
  { event: 'session.append', matcher: 'door notice', file: 'mod/prompt.ts', does: 'keeps the warning row of an @room\'s stop (the shim\'s "✓ sent", "⧗ queued: …") as the receipt alone, without Claude Code\'s "Operation stopped by hook: " frame; only a row that is exactly that frame around a receipt the shim just returned; the model\'s isMeta copy is left alone. .catch passes the row on' },
  { event: 'tool.call', matcher: 'EnterPlanMode|ExitPlanMode', file: 'mod/consent.ts', does: 'sets reviewMaybeOpen (a room review starts only through these)' },
  { event: 'classic.Stop', matcher: '', file: 'mod/consent.ts', does: 'node hooks/consent.ts (the open-review nudge) only while a review may be open or the seat is unknown' },
  { event: 'classic.PostToolUse', matcher: 'tool_name TaskCreate|TaskUpdate', file: 'mod/tasks.ts', does: 'node hooks/tasks.ts (the room task mirror) only for the room\'s Claude or an unknown seat' },
  { event: 'classic.TaskCompleted', matcher: '', file: 'mod/tasks.ts', does: 'node hooks/tasks.ts (the gate; exit 2 -> block) only for the room\'s Claude or an unknown seat; .catch blocks in the room\'s Claude' },
  { event: 'ui.render', matcher: 'UserMessage, origin peer|peer-send-message|plugin', file: 'mod/render.ts', does: 'draws another member\'s Claude as "bob\'s Claude: …" and a sub-human prompt as its chat lines, without "(for Claude)" lines' },
  { event: 'session.send', matcher: '', file: 'mod/send.ts', does: 'a SendMessage to NAME.CODE of this room whose seat is on another machine (its seat record\'s machine is not this home\'s machine id; the native send reaches only this machine\'s sessions) is posted to the room instead, addressed to NAME, through the room server ($.mcp.call post), and answered delivered (or not, with the room\'s refusal); anything else, or a failure, passes on' },
];

export function register(on: On) {
  registerDeliver(on);
  registerGuard(on);
  registerPrompt(on);
  registerConsent(on);
  registerTasks(on);
  registerRender(on);
  registerSend(on);
}
