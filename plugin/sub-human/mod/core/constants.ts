/**
 * plugin/sub-human/mod/core/constants.ts: the values the hooks module and node share, owned here (pure: no import).
 * lib/config.ts, lib/room/render.ts and lib/tail.ts import them from here, so there is one copy, not two kept equal.
 *
 *   MOD_RESTART_MS, MOD_RESTART_MAX_MS, MOD_RESTART_STEADY_MS, MOD_DELIVERY_ERROR_LOG_MS   the tail child's backoff
 *   CHAT_NEST, CHAT_LINES_MAX, FOR_CLAUDE        how a chat message is laid out, and the head of a line only for Claude
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
