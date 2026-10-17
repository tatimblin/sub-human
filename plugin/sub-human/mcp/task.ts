/**
 * plugin/sub-human/mcp/task.ts: the `task` tool, a room-server plug-in (create(ctx) -> {tools, call}).
 *
 *   task({op: add|claim|release|done, id?, subject?, detail?, evidence?, suggest?, plan?})
 *     add needs subject (suggest: a suggested owner, who claims it themselves; plan: the room plan it comes from, tagged
 *     with its current version); claim, release and done need id; done
 *     needs evidence. The host applies it at once (lib/tasks.ts apply: the ownership rules, then the log, the room
 *     session's task list and tasks.json): a room hosted here in this process, one hosted elsewhere through its link
 *     (the `task` op, lib/remote/server.ts). The reply is the change made, or why it was refused; nothing is queued.
 */

import * as tasks from '../lib/tasks.ts';
import * as room from '../lib/room.ts';
import { msgOf } from '../lib/errors.ts';
import { MirrorRoomStore } from '../lib/room/store-mirror.ts';
import type { Me, PluginContext, JsonSchema, ToolArgs, ToolDefinition, ToolResult } from './types.ts';

/** The plug-in (a PluginApi): its call reads only the seat's code, name and role, and answers at once. */
interface TaskPlugin { tools: ToolDefinition[]; call(name: string, me: Pick<Me, 'code' | 'name' | 'role'>, args: ToolArgs): ToolResult }

const S = (d: string): JsonSchema => ({ type: 'string', description: d });
const TOOL: ToolDefinition = {
  name: 'task',
  title: 'Change the room task list',
  description: 'Change the sub-human room\'s shared task list; the host applies it at once and replies with the change or why not. '
    + 'add needs subject; claim (for yourself), release and done (your own task) need id; done also needs evidence.',
  inputSchema: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: tasks.OPS, description: 'add, claim (take it), release (give it back) or done.' },
      id: S('Task id, e.g. "3".'),
      subject: S('add: a short title.'),
      detail: S('Optional longer description.'),
      evidence: S('done: what shows it is finished (a test run, a commit).'),
      suggest: S('add: the member you suggest for it (they claim it themselves).'),
      plan: S('add: the room plan it comes from (its current version is recorded).'),
    },
    required: ['op'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
};

function create(ctx: Partial<Pick<PluginContext, 'text'>> = {}): TaskPlugin {
  const text = ctx.text ?? ((s: unknown, isError?: boolean): ToolResult => ({ content: [{ type: 'text', text: String(s) }], ...(isError ? { isError: true } : {}) }));

  function call(name: string, me: Pick<Me, 'code' | 'name' | 'role'>, args: ToolArgs): ToolResult {
    if (name !== 'task') return text(`unknown tool ${name}`, true);
    if (me.role === 'claude') return text('the room session takes no task requests', true);
    const store = room.open(me.code).store;
    let r: tasks.Applied;
    try {
      if (store.isHost) r = tasks.apply(store, args || {}, { by: me.name });
      else if (store instanceof MirrorRoomStore) r = store.request('task', { name: me.name, req: args || {} });
      else return text('not applied: this room has no host to ask', true);
    } catch (e) { return text(`not applied: ${msgOf(e)}`, true); }
    return r.ok ? text(r.text) : text(`refused: ${r.error}`, true);
  }

  return { tools: [TOOL], call };
}

export { create, TOOL };
export type { TaskPlugin };
