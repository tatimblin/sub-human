/**
 * plugin/sub-human/mcp/task.ts: the `task` tool, a room-server plug-in (create(ctx) -> {tools, call}).
 *
 *   task({op: add|claim|release|done, id?, subject?, detail?, evidence?, for?})
 *     add needs subject; claim, release and done need id; done needs evidence. Appends a task_req entry
 *     (via agent, from the resolved member; owner = for || me) and returns "queued; the room's Claude applies it".
 *     The room's Claude applies requests to its native task list (the room's list). With no live room Claude it returns
 *     "the room's Claude is not running: the room task list is unavailable" and appends nothing.
 */

import * as tasks from '../lib/tasks.ts';
import * as identity from '../lib/identity.ts';
import * as room from '../lib/room.ts';
import type { Me, PluginApi, PluginContext, JsonSchema, ToolArgs, ToolDefinition, ToolResult } from './types.ts';
import type { RoomCode } from '../lib/brand.ts';

const S = (d: string): JsonSchema => ({ type: 'string', description: d });
const TOOL: ToolDefinition = {
  name: 'task',
  title: 'Request a room task change',
  description: 'Ask the sub-human room\'s Claude to change the shared room task list; it is queued and the room\'s Claude applies it. '
    + 'add needs subject; claim, release and done need id; done also needs evidence.',
  inputSchema: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: tasks.OPS, description: 'add, claim (take it), release (give it back) or done.' },
      id: S('Task id, e.g. "3".'),
      subject: S('add: a short title.'),
      detail: S('Optional longer description.'),
      evidence: S('done: what shows it is finished (a test run, a commit).'),
      for: S('The member it is for; default you.'),
    },
    required: ['op'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
};

function create(ctx: Partial<Pick<PluginContext, 'text'>> = {}): PluginApi {
  const text = ctx.text ?? ((s: unknown, isError?: boolean): ToolResult => ({ content: [{ type: 'text', text: String(s) }], ...(isError ? { isError: true } : {}) }));

  function roomClaudeLive(code: RoomCode) {
    const o = identity.readMembers(code).claude;
    return !!(o && o.role === 'claude' && identity.seatAlive(o));
  }

  function call(name: string, me: Me, args: ToolArgs): ToolResult {
    if (name !== 'task') return text(`unknown tool ${name}`, true);
    if (me.role === 'claude') return text('you hold the room task list: apply requests with TaskCreate/TaskUpdate', true);
    const v = tasks.validate(args || {});
    if (!v.ok) return text(`refused: ${v.error}`, true);
    const r = v.req;
    if (!roomClaudeLive(me.code)) return text("the room's Claude is not running: the room task list is unavailable");
    const owner = r.for || me.name;
    if (r.for) {
      const m = identity.readMembers(me.code)[r.for];
      if (!m || m.role === 'claude') return text(`refused: no member named ${r.for} in ${me.code}`, true);
    }
    const task: { op: string; owner: string; id?: string; subject?: string; detail?: string; evidence?: string } = { op: r.op, owner };
    for (const k of ['id', 'subject', 'detail', 'evidence'] as const) if (r[k] !== undefined) task[k] = r[k];
    room.open(me.code).append({ kind: 'task_req', text: tasks.requestText(task), ...task }, { via: 'agent', from: me.name });
    return text('queued; the room\'s Claude applies it');
  }

  return { tools: [TOOL], call };
}

export { create, TOOL };
