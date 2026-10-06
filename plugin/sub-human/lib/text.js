'use strict';
/**
 * plugin/sub-human/lib/text.js: the string helpers and name patterns every module shares. Zero dependencies.
 *
 *   clip(s, n) -> string     at most n code points; a longer string keeps n - 1 and ends in "…". Counting code
 *                            points (not UTF-16 units) never splits a surrogate pair, so an emoji is never halved.
 *   oneLine(s) -> string     whitespace runs collapsed to one space, trimmed; null / undefined -> ''
 *   NAME_RE                  a seat name: letters, digits, . _ -, 1-32
 *   CODE_RE                  a room code: "otter-4821"
 *   SID_SAFE                 a session id safe to use in a file name
 */

const NAME_RE = /^[A-Za-z0-9_.-]{1,32}$/;
const CODE_RE = /^[a-z]+-\d{4}$/;
const SID_SAFE = /^[A-Za-z0-9_-]{1,128}$/;

function clip(s, n) {
  const str = String(s);
  // Fast path: a string no longer than n UTF-16 units has at most n code points.
  if (str.length <= n) return str;
  const cps = Array.from(str);
  return cps.length > n ? cps.slice(0, Math.max(0, n - 1)).join('') + '…' : str;
}

const oneLine = s => (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim();

module.exports = { clip, oneLine, NAME_RE, CODE_RE, SID_SAFE };
