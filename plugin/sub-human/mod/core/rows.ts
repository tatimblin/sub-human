/**
 * plugin/sub-human/mod/core/rows.ts: which agents are the panel's rows, as pure functions. Owned here: lib/rows.ts
 * re-exports the agent types, and the module's row hooks (mod/rows.ts) start node only for a call or stop of one.
 *
 *   PARTICIPANT, ROOM_AGENT     the row agents' types (agents/participant.md, agents/room.md, plugin-namespaced)
 *   isRow(type) -> bool         type is one of them
 */
export const PARTICIPANT = 'sub-human:participant';
export const ROOM_AGENT = 'sub-human:room';

export const isRow = (type: unknown): boolean => type === PARTICIPANT || type === ROOM_AGENT;
