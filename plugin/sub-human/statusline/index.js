'use strict';
// plugin/sub-human/statusline/index.js: what bin/sub-human dispatches to.
//   statusline(input) -> string         `sub-human statusline` (Claude Code's statusLine); '' when not in a room
//   agentStatusline(input) -> string    `sub-human agent-statusline` (subagentStatusLine); {"id","content"} lines
// input is the parsed stdin JSON. Neither throws. The logic lives in segments.js (+ lib/rows.js).
const { statusline, agentStatusline } = require('./segments.js');
module.exports = { statusline, agentStatusline };
