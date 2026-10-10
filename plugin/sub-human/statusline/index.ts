// plugin/sub-human/statusline/index.ts: what scripts/sub-human dispatches to.
//   agentStatusline(input) -> string    `sub-human agent-statusline` (subagentStatusLine); {"id","content"} lines
// input is the parsed stdin JSON; never throws. There is no main status line. Logic: segments.ts
// + lib/rows.ts.
import { agentStatusline } from './segments.ts';
export { agentStatusline };
