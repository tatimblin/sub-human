/**
 * plugin/sub-human/mod/core/constants.ts: the values the hooks module and node share, owned here (pure: no import).
 * lib/config.ts, lib/room/render.ts and lib/tail.ts import them from here, so there is one copy, not two kept equal.
 *
 *   MOD_RESTART_MS, MOD_RESTART_MAX_MS, MOD_RESTART_STEADY_MS, MOD_DELIVERY_ERROR_LOG_MS   the tail child's backoff
 *   CHAT_NEST, CHAT_LINES_MAX, FOR_CLAUDE        how a chat message is laid out, and the head of a line only for Claude
 *   PULL_HEAD, PULL_END, PULL_CAP, pullDroppedLine   the room context the model reads with the person's next prompt
 *   HOME_MARK, homeMark(home)    the hidden notice that names a seated session's sub-human folder in its transcript
 */

/** The tail child's first restart delay, doubled per failure in a row up to MOD_RESTART_MAX_MS. */
export const MOD_RESTART_MS = 1000;
export const MOD_RESTART_MAX_MS = 60_000;
/** A child that ran this long before it exited was healthy: its restart starts the backoff over. */
export const MOD_RESTART_STEADY_MS = 60_000;
/** At most one delivery-error notice per this long, however many failures it covers. */
export const MOD_DELIVERY_ERROR_LOG_MS = 300_000;

/** The prefix of every continuation line of a chat message, so none can pass as a line of its own. */
export const CHAT_NEST = '  │ ';
/** Text lines shown per chat message; the rest is "[+N more lines: …]". */
export const CHAT_LINES_MAX = 20;
/** The head of a line the model reads and the person's drawing leaves out. */
export const FOR_CLAUDE = '(for Claude)';

/** The room context (the pull lane: what happened in the room since the model's last turn) opens with PULL_HEAD and
 * ends with PULL_END, so nothing after it reads as a room line: it rides as context beside the person's next prompt
 * (mod/prompt.ts), never as a user row of its own (stage 8e B). */
export const PULL_HEAD = 'sub-human room context: what happened in the room since your last turn (for you, not the user: mention it only if they ask):';
export const PULL_END = "end of room context; the prompt it came with is the person's own words, unless the sub-human plugin sent it (then it is room lines).";
/** The room context's size, in characters. */
export const PULL_CAP = 1500;
/** The room context's note of lines left out under PULL_CAP. */
export const pullDroppedLine = (n: number) => `(${n} earlier ${n === 1 ? 'line' : 'lines'} not shown: the room read tool has them)`;

/** The head of the notice the module appends to a seated session's transcript (a system row, drawn only in the ctrl+o
 * view): which sub-human folder its seat is in. An agent-view fork reads it (lib/cc/transcript.ts lastHome), since the
 * bg job it runs in drops a shell's SUB_HUMAN_HOME. */
export const HOME_MARK = 'sub-human: home ';
export const homeMark = (home: string) => `${HOME_MARK}${home}`;
