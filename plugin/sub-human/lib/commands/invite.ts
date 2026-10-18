/**
 * plugin/sub-human/lib/commands/invite.ts: `/sub-human invite [--ssh [DEST]] | --web | --public [--port P] | --pipe |
 * --stop | --cancel [ID]` (host only): an invite line and its PIN (lib/remote/hosting.ts hostInvite,
 * webhost.ts hostWeb), shown to the person only (a secret: it holds the PIN); --stop stops serving the room over the
 * web, --cancel cancels an unused invite (hosting.cancelInvite).
 *
 * With no way named, the tailnet (Tailscale Serve, as --web) when Tailscale is up here (seam.tailnetUp: its CLI and
 * `tailscale status`, checked before the listener starts), else ssh; SUB_HUMAN_SSH_ADDR set keeps ssh. A tailnet
 * invite that fails falls back to ssh with one line why. Funnel is never chosen: its hostname goes into public
 * certificate-transparency logs, so a tailnet-only invite ends with the pointer to --public (OFF_TAILNET) instead.
 */
import * as hosting from '../remote/hosting.ts';
import { parse } from '../cli/args.ts';
import { HELP_HINT, hostOnly, refused, say, secret } from './answer.ts';
import { msgOf } from '../errors.ts';
import { envStr } from '../env.ts';
import type { Pinned, Verb } from './types.ts';
import type * as WebhostMod from '../remote/webhost.ts';
import type * as TailscaleMod from '../remote/tailscale.ts';
import { lazy } from '../io.ts';

// the web listener and the tailscale CLI only for an invite (start cost: /sub-human loads this file)
const webhost = lazy<typeof WebhostMod>(import.meta.url, '../remote/webhost.ts');
const ts = lazy<typeof TailscaleMod>(import.meta.url, '../remote/tailscale.ts');

export const INVITE_USAGE: string = `usage: /sub-human invite (over your tailnet when Tailscale is up here, else ssh; --ssh for ssh, --public for anyone on the internet). ${HELP_HINT}`;
export const OFF_TAILNET = 'Off your tailnet? /sub-human invite --public';

/** Whether Tailscale is usable here: its CLI, and `tailscale status` naming this machine (no serve, no Funnel). */
function tailnetUp(): boolean {
  const b = ts().bin();
  if (!b) return false;
  try { ts().self(b); return true; } catch { return false; }
}

/** The tests' stubs: whether the tailnet is up here, and the web invite itself. */
export const seam: { tailnetUp: () => boolean; hostWeb: typeof WebhostMod.hostWeb } = {
  tailnetUp,
  hostWeb: (...a) => webhost().hostWeb(...a),
};

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
    // no way named: the tailnet when Tailscale is up here, unless an ssh address is set up (never Funnel)
    const tailnet = ways === 0 && envStr('SUB_HUMAN_SSH_ADDR') === undefined && seam.tailnetUp();
    const ssh = () => hosting.hostInvite(cur.code, { ssh: f.pipe ? undefined : f.ssh === undefined ? true : f.ssh, pipe: !!f.pipe, by: cur.name });
    let r: { text: string; pinned: Pinned; mode?: string }, why = '';
    if (web || tailnet) {
      try {
        r = seam.hostWeb(cur.code, { funnel: !!f.public, port: f.port !== undefined ? Number(f.port) : undefined, by: cur.name });
      } catch (e) {
        if (!tailnet) throw e;
        why = `Not over your tailnet: ${msgOf(e)} This invite is over ssh instead.\n\n`;
        r = ssh();
      }
    } else r = ssh();
    // every text the invite shows in (whole, pinned, cut) gets the same line before and after
    const tail = r.mode === 'tailscale' ? `\n${OFF_TAILNET}` : '';
    const around = (t: string) => `${why}${t}${tail}`;
    const { pinned } = r;
    // for this terminal only, never the model: it holds the PIN. Through the hooks module the line
    // and the PIN are pinned under the prompt, which Claude Code does not save (a notice is a transcript row)
    return secret(around(r.text), { pinned: { ...pinned, text: around(pinned.text), ...(pinned.cut !== undefined ? { cut: around(pinned.cut) } : {}) } });
  } catch (e) { return refused(msgOf(e)); }
};
