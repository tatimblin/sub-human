'use strict';
// plugin/sub-human/statusline/index.js: what scripts/sub-human dispatches to.
//   agentStatusline(input) -> string    `sub-human agent-statusline` (subagentStatusLine); {"id","content"} lines
// input is the parsed stdin JSON; never throws. There is no main status line. Logic: segments.js
// + lib/rows.js.
const { agentStatusline } = require('./segments.js');
module.exports = { agentStatusline };
