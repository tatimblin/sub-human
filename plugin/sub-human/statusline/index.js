'use strict';
// plugin/sub-human/statusline/index.js: what bin/sub-human dispatches to.
//   agentStatusline(input) -> string    `sub-human agent-statusline` (subagentStatusLine); {"id","content"} lines
// input is the parsed stdin JSON; never throws. The main status line is gone (Phase 2). Logic: segments.js
// + lib/rows.js.
const { agentStatusline } = require('./segments.js');
module.exports = { agentStatusline };
