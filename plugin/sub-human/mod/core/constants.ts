/**
 * plugin/sub-human/mod/core/constants.ts: the values the hooks module and node share, owned here (pure: no import).
 * lib/config.ts, lib/room/render.ts and lib/tail.ts import them from here, so there is one copy, not two kept equal.
 *
 *   MOD_RESTART_MS, MOD_RESTART_MAX_MS, MOD_RESTART_STEADY_MS, MOD_DELIVERY_ERROR_LOG_MS   the tail child's backoff
 *   CHAT_NEST, CHAT_LINES_MAX, PEER_LINES_MAX, CHAT_BLANK, messageLines, FOR_CLAUDE   how a chat message is laid
 *       out (a Claude's message to another keeps its blank lines and shows far more), and the head of a line only for Claude
 *   PULL_HEAD, PULL_END_OLD, PULL_CAP, pullDroppedLine   the room context the model reads with the person's next prompt
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
/** Text lines shown per chat message (the room's group chat: blank lines dropped); the rest is "[+N more lines: …]". */
export const CHAT_LINES_MAX = 20;
/** Text lines shown of a message one Claude addressed to another (code, a diff): its blank lines kept, as a bare
 * CHAT_NEST (CHAT_BLANK). */
export const PEER_LINES_MAX = 400;
/** A blank line inside a message, drawn so it still reads as part of it. */
export const CHAT_BLANK: string = CHAT_NEST.trimEnd();
/** A message's lines for drawing: trailing space cut; blank lines dropped (keep: false) or kept as '' with the runs
 * at either end cut and any run inside cut to one. */
export function messageLines(text: string, keep: boolean): string[] {
  const lines = text.split('\n').map(l => l.replace(/\s+$/, ''));
  if (!keep) return lines.filter(l => l.trim());
  const out: string[] = [];
  for (const l of lines) if (l || (out.length && out.at(-1) !== '')) out.push(l);
  while (out.at(-1) === '') out.pop();
  return out;
}
/** The head of a line the model reads and the person's drawing leaves out. */
export const FOR_CLAUDE = '(for Claude)';

/** The room context (the pull lane: what happened in the room since the model's last turn) opens with PULL_HEAD: it
 * rides as a context block of its own beside the person's next prompt (mod/prompt.ts), never as a user row of its own
 * (stage 8e B), so no end line is needed. PULL_END_OLD: an older tail's end line, dropped where it is read. */
export const PULL_HEAD = 'room since your last turn (FYI):';
export const PULL_END_OLD: RegExp = /^end of room context; /;
/** The room context's size, in characters. */
export const PULL_CAP = 1500;
/** The room context's note of lines left out under PULL_CAP. */
export const pullDroppedLine = (n: number) => `(${n} earlier ${n === 1 ? 'line' : 'lines'} not shown: the room read tool has them)`;

/** The head of the notice the module appends to a seated session's transcript (a system row, drawn only in the ctrl+o
 * view): which sub-human folder its seat is in. An agent-view fork reads it (lib/cc/transcript.ts lastHome), since the
 * bg job it runs in drops a shell's SUB_HUMAN_HOME. */
export const HOME_MARK = 'sub-human: home ';
export const homeMark = (home: string) => `${HOME_MARK}${home}`;
