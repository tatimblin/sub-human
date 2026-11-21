// plugin/sub-human/hooks/handlers/walk.ts: not a hook event: the hooks module runs it (mod/deliver.ts offerWalk) once a
// bare /sub-human opened a room, in the background while the join's turn runs, to learn which ways this machine can
// bring someone in for the question it then asks (mod/core/walk.ts). It changes nothing and starts nothing.
// Out: {subHuman: {walk: {tailnet, ssh, sshAddr}}} (mod/core/walk.ts WalkFacts): Tailscale as a bare invite checks it
// (lib/commands/invite.ts seam: its CLI, and `tailscale status` naming this machine online), Remote Login or an sshd
// (lib/remote/hosting.ts remoteLogin; SUB_HUMAN_REMOTE_LOGIN forces it), and whether SUB_HUMAN_SSH_ADDR is set. A check
// that throws reads as not known (null).
import { seam } from '../../lib/commands/invite.ts';
import { remoteLogin } from '../../lib/remote/hosting.ts';
import { envStr } from '../../lib/env.ts';
import type { HookBase, Reply } from '../types.ts';

export function handle(_input: HookBase): Reply {
  let tailnet: 'up' | 'down' | 'none' | null = null;
  let ssh: 'on' | 'off' | null = null;
  try { tailnet = seam.tailnet(); } catch { /* not known */ }
  try { ssh = remoteLogin(); } catch { /* not known */ }
  const sshAddr = !!envStr('SUB_HUMAN_SSH_ADDR');
  return { kind: 'classic', outputs: [{ subHuman: { walk: { tailnet, ssh, sshAddr } } }] };
}
