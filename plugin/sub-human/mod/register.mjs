/**
 * plugin/sub-human/mod/register.mjs: sub-human's function hooks, the module hooks.json names under `modules`.
 * register(on) calls each part's registerX(on)
 * (mod/deliver.mjs: the session's lifecycle, the hello and the room's delivery; guard.mjs, prompt.mjs,
 * consent.mjs, tasks.mjs, render.mjs). An event is hooked once per module without a matcher (validate), so each
 * such event lives in one file.
 *
 * The mod routes, node writes: no file under mod/ writes room state or holds the seat key. It knows no store path
 * of its own: hooks/mod-hello.js (run with $.process.run) says the home, the plugin root and this session's seat,
 * kept in $.state sub-human/hello so a hot reload keeps it (mod/deliver.mjs says hello). Every `$` call sits in the
 * file that registers the hook (cc CONTRACT module-dollar-local); mod/core/*.mjs is pure and tested in node
 * (test/mod-core.test.js).
 *
 *   HOOKS     every hook the module registers: {event, matcher, file, does}; scripts/arch-doc.js renders it into
 *             docs/ARCHITECTURE.md ("Function hooks") and test/mod-core.test.js checks it against validate.
 *   register(on)
 */
import { registerGuard } from './guard.mjs';
import { registerRender } from './render.mjs';
import { registerPrompt } from './prompt.mjs';
import { registerConsent } from './consent.mjs';
import { registerTasks } from './tasks.mjs';
import { registerDeliver } from './deliver.mjs';

export const HOOKS = [
  { event: 'session.start', matcher: '', file: 'mod/deliver.mjs', does: 'runs hooks/mod-hello.js with the session\'s nonce (minted once per session id into $.state; the lease keeps it; home, plugin root, seat into $.state); unless surely unseated, starts the tail child (node bin/sub-human tail --ndjson, restarted with backoff; the seat\'s only delivery) and routes its events: chat -> $.ui.log, pull -> isMeta append, wake -> $.prompt.submit (mid-turn: append), rows -> $.state' },
  { event: 'classic.UserPromptExpansion', matcher: 'command_name ^(sub-human:)?sub-human$', file: 'mod/deliver.mjs', does: 'after the join (hooks/join.js beneath), runs mod-hello again for the new seat and starts the tail child' },
  { event: 'classic.SessionStart', matcher: 'source clear|compact|resume', file: 'mod/deliver.mjs', does: 'after session-restore beneath (a /clear rebinds the seat to a new session id), runs mod-hello again and starts the tail child for that id; reviewMaybeOpen unsure' },
  { event: 'session.end', matcher: '', file: 'mod/deliver.mjs', does: 'stops that session id\'s tail child' },
  { event: 'turn.start', matcher: '', file: 'mod/deliver.mjs', does: 'marks a main-loop turn running (a wake then appends instead of submitting)' },
  { event: 'turn.complete', matcher: '', file: 'mod/deliver.mjs', does: 'marks idle; submits a mid-turn wake no request carried (none followed a tool call that finished after it)' },
  { event: 'classic.PostToolUse', matcher: '', file: 'mod/deliver.mjs', does: 'observes when a main-loop tool call finished (a model request follows it, carrying a mid-turn wake)' },
  { event: 'classic.PostToolUseFailure', matcher: '', file: 'mod/deliver.mjs', does: 'the same, for a tool call that failed' },
  { event: 'tool.call', matcher: 'Bash', file: 'mod/guard.mjs', does: 'denies a command that names the store or runs the plugin\'s code (mod/core/guard.mjs bashVerdict); .catch fails closed on "sub-human"' },
  { event: 'tool.call', matcher: 'Write|Edit|MultiEdit|NotebookEdit', file: 'mod/guard.mjs', does: 'denies a write into the store, lexically or after $.fs.stat realPath; .catch fails closed on "sub-human"' },
  { event: 'tool.call', matcher: 'mcp__plugin_sub-human_room__hold', file: 'mod/guard.mjs', does: 'denies hold outside a row subagent (no agentId)' },
  { event: 'tool.check', matcher: '/^mcp__plugin_sub-human_room__/', file: 'mod/guard.mjs', does: 'allows the room tools for a seated session (no permission prompt); hold only with agentId' },
  { event: 'prompt.submit', matcher: '', file: 'mod/prompt.mjs', does: 'drops an @room / room: whose origin is not composer, sdk or bridge (a peer, a notification, a plugin); hands the origin to the shim below; a typed prompt the tail child delivers for carries the held rows text as context and writes "working" presence (node hooks/presence.js, not awaited) unless already working; .catch drops only an @room' },
  { event: 'classic.Notification', matcher: 'notification_type idle_prompt|permission_prompt', file: 'mod/prompt.mjs', does: 'notes the presence presence.js beneath writes, so the next prompt writes "working" again' },
  { event: 'classic.StopFailure', matcher: '', file: 'mod/prompt.mjs', does: 'notes the error presence presence.js beneath writes' },
  { event: 'classic.UserPromptSubmit', matcher: '', file: 'mod/prompt.mjs', does: 'sessionTitle NAME.CODE once per session id (members); no node when not an @room and surely unseated, or a member\'s seat the tail child delivers for with no review open; else node hooks/prompt.js with sub_human_origin and the session\'s nonce, which at-room checks against the lease (systemMessage via $.ui.log)' },
  { event: 'tool.call', matcher: 'EnterPlanMode|ExitPlanMode', file: 'mod/consent.mjs', does: 'sets reviewMaybeOpen (a room review starts only through these)' },
  { event: 'classic.Stop', matcher: '', file: 'mod/consent.mjs', does: 'node hooks/consent.js (the open-review nudge) only while a review may be open or the seat is unknown' },
  { event: 'classic.PostToolUse', matcher: 'tool_name TaskCreate|TaskUpdate', file: 'mod/tasks.mjs', does: 'node hooks/tasks.js (the room task mirror) only for the orch or an unknown seat' },
  { event: 'classic.TaskCompleted', matcher: '', file: 'mod/tasks.mjs', does: 'node hooks/tasks.js (the gate; exit 2 -> block) only for the orch or an unknown seat; .catch blocks in the orch' },
  { event: 'ui.render', matcher: 'UserMessage, origin peer|peer-send-message|plugin', file: 'mod/render.mjs', does: 'draws another member\'s Claude as "bob\'s Claude: …" and a sub-human prompt as its chat lines, without "(for Claude)" lines' },
];

/** @type {import('claude-code').Register} */
export function register(on) {
  registerDeliver(on);
  registerGuard(on);
  registerPrompt(on);
  registerConsent(on);
  registerTasks(on);
  registerRender(on);
}
