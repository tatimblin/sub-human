'use strict';
/**
 * plugin/sub-human/lib/room.js: the room log (envelope v3). A facade over lib/room/*, so callers keep one
 * require. CommonJS, zero dependencies, Node 24.
 *
 *   room/store.js     binding (bind, code, dir, logPath; ROOM_DIR for tests), reading (readAll, readById,
 *                     readAfter, lastId, follow, normalize, readView), append (the only writer), validateChain
 *                     (whole log), verifyChain (incremental, from the log.idx checkpoint), hash12, cursors
 *                     (getCursor, setCursor)
 *   room/validate.js  the envelope rules append() enforces: which kinds each via may write, settable fields,
 *                     task fields; RoomError (INVALID | RATE | LOCK | NO_ROOM)
 *   room/lanes.js     proposal queries (proposal, proposals, answers, answered, decided) and lane(me, e,
 *                     entries?) -> push | pull | none, retractedIds
 *   room/render.js    line, tailLine, fmt, who, chatLines, FOR_CLAUDE, stateLine, digest
 * Size caps come from lib/config.js; DIGEST_CAP, TAIL_MAX, CHAT_MAX, CHAT_WRAP, CHAT_LINES_MAX and CHAT_NEST are
 * re-exported here.
 */

const store = require('./room/store.js');
const { RoomError } = require('./room/validate.js');
const lanes = require('./room/lanes.js');
const render = require('./room/render.js');
const { DIGEST_CAP, TAIL_MAX, CHAT_MAX, CHAT_WRAP, CHAT_LINES_MAX, CHAT_NEST } = require('./config.js');

module.exports = {
  RoomError, DIGEST_CAP, TAIL_MAX, CHAT_MAX, CHAT_WRAP, CHAT_LINES_MAX, CHAT_NEST,

  bind: store.bind, code: store.code, dir: store.dir, logPath: store.logPath, hash12: store.hash12,
  readAll: store.readAll, readById: store.readById, readAfter: store.readAfter, lastId: store.lastId,
  follow: store.follow, normalize: store.normalize, append: store.append, validateChain: store.validateChain,
  verifyChain: store.verifyChain, readView: store.readView,
  getCursor: store.getCursor, setCursor: store.setCursor,

  proposal: lanes.proposal, proposals: lanes.proposals, answers: lanes.answers, answered: lanes.answered,
  decided: lanes.decided, lane: lanes.lane, retractedIds: lanes.retractedIds,

  line: render.line, tailLine: render.tailLine, chatLines: render.chatLines, FOR_CLAUDE: render.FOR_CLAUDE,
  fmt: render.fmt, who: render.who, stateLine: render.stateLine, digest: render.digest,
};
