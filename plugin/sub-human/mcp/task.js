'use strict';
/**
 * plugin/sub-human/mcp/task.js: the `task` tool, a room-server plug-in (create(ctx) -> {tools, call}).
 *
 *   task({op: add|claim|release|done, id?, subject?, detail?, evidence?, for?})
 *     add needs subject; claim, release and done need id; done needs evidence. Appends a task_req entry
 *     (via agent, from the resolved member; owner = for || me) and returns "queued; the orch applies it".
 *     The orch applies requests to its native task list (the room's list). With no live orch it returns
 *     "no orch: the room task list is unavailable" and appends nothing.
 */

const path = require('node:path');
const LIB = path.join(__dirname, '..', 'lib');
const tasks = require(path.join(LIB, 'tasks.js'));
const identity = require(path.join(LIB, 'identity.js'));
const room = require(path.join(LIB, 'room.js'));

const S = d => ({ type: 'string', description: d });
const TOOL = {
  name: 'task',
  title: 'Request a room task change',
  description: 'Ask the sub-human room\'s orch to change the shared room task list; it is queued and the orch applies it. '
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

function create(ctx = {}) {
  const text = ctx.text || ((s, isError) => ({ content: [{ type: 'text', text: String(s) }], ...(isError ? { isError: true } : {}) }));

  function orchLive(code) {
    const o = identity.readMembers(code).orch;
    return !!(o && o.role === 'orch' && identity.seatAlive(o));
  }

  function call(name, me, args) {
    if (name !== 'task') return text(`unknown tool ${name}`, true);
    if (me.role === 'orch') return text('you hold the room task list: apply requests with TaskCreate/TaskUpdate', true);
    const v = tasks.validate(args || {});
    if (!v.ok) return text(`refused: ${v.error}`, true);
    const r = v.req;
    if (!orchLive(me.code)) return text('no orch: the room task list is unavailable');
    const owner = r.for || me.name;
    if (r.for) {
      const m = identity.readMembers(me.code)[r.for];
      if (!m || m.role === 'orch') return text(`refused: no member named ${r.for} in ${me.code}`, true);
    }
    const task = { op: r.op, owner };
    for (const k of ['id', 'subject', 'detail', 'evidence']) if (r[k] !== undefined) task[k] = r[k];
    room.append({ kind: 'task_req', text: tasks.requestText(task), ...task }, { via: 'agent', from: me.name });
    return text('queued; the orch applies it');
  }

  return { tools: [TOOL], call };
}

module.exports = { create, TOOL };
