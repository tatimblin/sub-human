/**
 * plugin/sub-human/mod/core/seat.mjs: what the module knows about its session, from hooks/mod-hello.js, as pure
 * functions. The module keeps the parsed hello in $.state (sub-human/hello) so a hot reload keeps it.
 *
 *   parseHello(stdout, sid) -> hello | null
 *       hello = {sid, home, realHome, userHome, pluginRoot, seat: {name, code, role, addr} | null}. null when the
 *       output is not a hello (then the module "does not know" and every prefilter runs node).
 *   seated(hello) -> bool          a seat is known for this session
 *   parseAddr("bob.otter-4821") -> {name, code} | null     a seat's address (the session title), or null
 *   NAME_RE, CODE_RE               copies of lib/text.js (test/mod-core.test.js asserts they are equal)
 */

export const NAME_RE = /^[A-Za-z0-9_.-]{1,32}$/;
export const CODE_RE = /^[a-z]+-\d{4}$/;
const ABS = v => typeof v === 'string' && v.startsWith('/') ? v : null;

export function parseAddr(addr) {
  if (typeof addr !== 'string') return null;
  const m = /^(.+)\.([a-z]+-\d{4})$/.exec(addr.trim());
  if (!m || !NAME_RE.test(m[1]) || !CODE_RE.test(m[2])) return null;
  return { name: m[1], code: m[2] };
}

function parseSeat(s) {
  if (!s || typeof s !== 'object') return null;
  if (!NAME_RE.test(String(s.name)) || !CODE_RE.test(String(s.code))) return null;
  return { name: s.name, code: s.code, role: s.role === 'claude' ? 'claude' : 'member', addr: `${s.name}.${s.code}` };
}

export function parseHello(stdout, sid) {
  let o;
  try { o = JSON.parse(String(stdout || '').trim()); } catch { return null; }
  if (!o || typeof o !== 'object' || !ABS(o.home)) return null;
  return {
    sid: typeof sid === 'string' ? sid : null,
    home: o.home,
    realHome: ABS(o.realHome) || o.home,
    userHome: ABS(o.userHome),
    pluginRoot: ABS(o.pluginRoot),
    seat: parseSeat(o.seat),
  };
}

export const seated = hello => !!(hello && hello.seat);
