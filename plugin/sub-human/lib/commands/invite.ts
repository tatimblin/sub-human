/**
 * plugin/sub-human/lib/commands/invite.ts: `/sub-human invite [--ssh [DEST]] | --web | --public [--port P] | --pipe |
 * --stop | --cancel [ID]` (host only): an invite line and its PIN (lib/remote/hosting.ts hostInvite,
 * webhost.ts hostWeb), shown to the person only (a secret: it holds the PIN); --stop stops serving the room over the
 * web, --cancel cancels an unused invite (hosting.cancelInvite).
 */
import * as hosting from '../remote/hosting.ts';
import { parse } from '../cli/args.ts';
import { HELP_HINT, hostOnly, refused, say, secret } from './answer.ts';
import { msgOf } from '../errors.ts';
import type { Verb } from './types.ts';
import type * as WebhostMod from '../remote/webhost.ts';
import { lazy } from '../io.ts';

// the web listener only for a web invite (start cost: /sub-human loads this file)
const webhost = lazy<typeof WebhostMod>(import.meta.url, '../remote/webhost.ts');

export const INVITE_USAGE: string = `usage: /sub-human invite (an ssh line; --web for the web). ${HELP_HINT}`;

export const invite: Verb = (argv, { cur: seat }) => {
  const cur = hostOnly(seat, 'invite');
  if (typeof cur === 'string') return refused(cur);
  const p = parse(argv, { ssh: '?', web: 0, public: 0, port: 1, pipe: 0, stop: 0, cancel: '?' });
  const f = p.flags;
  const bad = p.error ? p.error.split(' ')[0] : p.rest.length ? p.rest[0] : f.port !== undefined && !/^[0-9]{1,5}$/.test(f.port) ? '--port' : null;
  if (bad !== null) return refused(`"${bad}" isn't an invite option. ${INVITE_USAGE}`);
  const web = !!(f.web || f.public);
  const ways = [f.ssh !== undefined, web, !!f.pipe, !!f.stop, f.cancel !== undefined].filter(Boolean).length;
  if (ways > 1) return refused(`pick one way at a time. ${INVITE_USAGE}`);
  try {
    if (f.stop) return say(webhost().unhost(cur.code).text);
    if (f.cancel !== undefined) return say(hosting.cancelInvite(cur.code, f.cancel === true ? undefined : f.cancel).text);
    const r = web
      ? webhost().hostWeb(cur.code, { funnel: !!f.public, port: f.port !== undefined ? Number(f.port) : undefined, by: cur.name })
      : hosting.hostInvite(cur.code, { ssh: f.pipe ? undefined : f.ssh === undefined ? true : f.ssh, pipe: !!f.pipe, by: cur.name });
    // for this terminal only, never the model: it holds the PIN. Through the hooks module the line
    // and the PIN are pinned under the prompt, which Claude Code does not save (a notice is a transcript row)
    return secret(r.text, { pinned: r.pinned });
  } catch (e) { return refused(msgOf(e)); }
};
