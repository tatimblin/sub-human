# Plan 01: SSH-first productionization

## 1. Summary
- SSH becomes the one supported remote transport. The developer runs no relay, pays $0 and can read nothing.
- `/sub-human host --ssh` does invite and authorize in one step. The invite carries a host-minted, room-scoped SSH key and the host-key fingerprint, so the joiner pastes one string plus a PIN.
- Reachability: the host's existing SSH (work), or a free tailnet using **OpenSSH over the tailnet IP** (home). Tailscale SSH is not used because it ignores forced commands.
- Reliability hardening: stable `serve` shim (survives plugin updates), wake/network-change reconnect, ControlMaster for MFA bastions, and a version window in `hello`.
- The phone needs nothing new: Remote Control attaches to a member's own session, which is already on a mirror.

## 2. User journey
**Host** (any box the joiners can `ssh` to, e.g. a work dev box):
```
/sub-human alice                  # create room K7QX
/sub-human host --ssh             # prints:  sh2.K7QX.<locator>.<blob>   PIN 4821-93
```
`host --ssh` resolves its own `user@host`: `$SUB_HUMAN_SSH_ADDR`, else the tailnet MagicDNS name if `tailscale status` works, else `whoami@hostname -f`, with the address shown for confirmation. It mints the invite, generates an ed25519 keypair for the reserved link, appends the forced-command line to `~/.ssh/authorized_keys` between `# sub-human BEGIN/END` markers, and seals the private key plus the host-key fingerprint into the invite under the PIN (scrypt + AES-GCM). The PIN is shown separately so it can be sent through a second channel.

**Joiner:**
```
sub-human join bob sh2.K7QX....   # own shell (Bash guard denies it to the model); PIN read from the TTY
/sub-human bob K7QX               # in Claude Code, as any rejoin
```
`sub-human join` asks for the PIN on the TTY, writes `<home>/links/K7QX/{id_ed25519,known_hosts,ssh_config}` with mode 0600, starts the daemon. The first `hello` redeems the invite. Then a `key.rotate` op replaces the host-minted key with one generated on the joiner's machine, so the secret that travelled in chat is dead within seconds.
- **Behind a bastion:** `sub-human join bob <invite> --via jumphost` writes `ProxyJump jumphost` into the per-link `ssh_config`, so the joiner's `~/.ssh/config` and agent are still honoured.
- **MFA or Duo bastion:** `sub-human link K7QX --prime` opens an interactive `ssh -M` master with `ControlPersist=8h`, and the daemon then rides it under `BatchMode`.
- **No route to the host:** the host runs `tailscale share` (free node sharing) and the joiner accepts it, then repeats the join. The tailnet name is in the locator.

**Phone:** start Remote Control from the seated session (`/remote-control` on the host's or the joiner's machine). Nothing in SSH changes. Relays (`relayQueue`) already work on mirrors.

## 3. Architecture changes
| Change | Files |
|---|---|
| `sh2` invite: `{code, locator, link, secret, sealedKey, hostKeyFp}`, sealed with a PIN; `sh1` still accepted | `lib/remote/auth.js` (`mintInvite`, `parseInvite`), new `lib/remote/seal.js` (node:crypto scrypt + AES-256-GCM, zero deps) |
| `host --ssh`: address discovery, keygen (`ssh-keygen -t ed25519 -N ''`, or node `generateKeyPairSync` with OpenSSH encoding), marker-block authorized_keys edit with `flock`, plus `revoke` and `list` | `hooks/join.js` (`host`), `bin/sub-human` (`authorize` refactored to a library, new `revoke LINK`, `links`), new `lib/remote/sshkeys.js` |
| Stable server shim `<home>/bin/serve`, rewritten at each SessionStart to point at the current `CLAUDE_PLUGIN_ROOT` and node. The authorized_keys line names the shim, never the versioned plugin cache path | `hooks/row-launcher.js` (already writes `<home>/bin/row-status`), `bin/sub-human authorize` |
| Per-link ssh files: `-F <link>/ssh_config` with `IdentityFile`, `IdentitiesOnly yes`, `UserKnownHostsFile`, `StrictHostKeyChecking yes`, `ControlMaster auto`, `ControlPath <tmp>/sh-%C`, `ControlPersist 10m`, optional `ProxyJump`. The invite still names no option; the joiner's CLI writes them | `lib/remote/link.js` (`sshCommand`), `lib/room/links.js` (schema v2) |
| `key.rotate {pubkey}` op: the server rewrites only its own marker line | `lib/remote/server.js`, `protocol.js` (cap `keyrotate`) |
| Reconnect triggers: a wall-clock vs monotonic jump of more than 5 s (wake), or a change in `os.networkInterfaces()` fingerprint, forces an immediate retry and resets backoff. `LINK_RETRY_MAX_MS` rises to 30 s only after 10 minutes of failures | `lib/remote/link.js`, `lib/config.js` |
| Version window: `hello` sends `{v, min_v, plugin}` and the server accepts `v-1..v`. A mismatch gives `PROTOCOL` with "host runs 0.9.2, you run 0.8.0: update with `claude plugin update sub-human`" | `lib/remote/protocol.js`, `server.js`, `lib/tail.js` (health line) |
| `sub-human doctor [--ssh user@host]`: checks ssh/ControlPath, host-key match, shim resolves, node version on host, sshd `AuthorizedKeysFile`/`AuthorizedKeysCommand` policy, clock skew vs `SIG_SKEW_MS` | `bin/sub-human`, new `lib/remote/doctor.js` |
| Opt-in user-level sshd for hosts whose sshd ignores `~/.ssh/authorized_keys` (corporate LDAP): `sub-human sshd --port 2222` runs `sshd -f <home>/sshd_config -D` unprivileged with `ForceCommand` + its own `AuthorizedKeysFile` | new `lib/remote/usersshd.js` |
| Harness: wake (SIGSTOP the daemon for 5 min), interface flap, bastion hop, ControlMaster reuse, plugin upgrade mid-room | `scripts/remote-docker/` (add jump container, toxiproxy timeout toxics) |

## 4. Security and privacy model
- **Content** travels only inside SSH between joiner and host. There is no third party, and Tailscale (WireGuard) sees only ciphertext. The developer sees nothing.
- **The host machine** sees everything in the room in clear. This is already the trust model ("the host is trusted by everyone who joins it").
- **The invite in chat** holds a key that is useless without the PIN, and the key only reaches `serve --stdio CODE --link ID` (`restrict`, forced command). After redemption the key is rotated, and the invite secret is single-use and hashed on the host. A leaked, sealed invite allows offline guessing against the PIN, so the PIN is 6 digits under scrypt N=2^17, and invites expire after 24 h (an `expiry` field the host enforces).
- **Host-key pinning** comes from the invite fingerprint, so there is no TOFU prompt and no MITM.
- **Seat keys** are unchanged. `via=human` is still signed only in hooks and verified against pinned keys. The model still cannot run `invite/authorize/join/link/serve/sshd/revoke` (Bash guard list grows).
- **Revoke:** `sub-human revoke LINK` deletes the marker line and the token hash, and kills that link's `serve`.

## 5. Reliability
- **Reconnect:** the daemon already resumes with `subscribe{after,hash}`, so there is no replay or buffer to manage (ET's sequence-number idea is already present as the log index). Writes while offline stay refused, never queued (kept: consent must not arrive late).
- **Sleep:** `ServerAliveInterval 15 × 2` detects a dead link in 30 s. The wake detector skips that wait. The seat lease is 120 s, so a short sleep keeps the seat.
- **NAT:** SSH is outbound from the joiner only. The host must be reachable, either directly or through a tailnet, which handles NAT traversal and falls back to DERP.
- **Corporate:** TCP/22 or ProxyJump, with no UDP needed. This is why mosh-style UDP is rejected. The user-level sshd covers locked-down `authorized_keys`.
- **Partitions:** the host is authoritative and `FORK` stays loud. A mirror never writes locally.
- **Upgrades:** the shim survives plugin updates. The protocol window allows skew of one version. `doctor` and the health line tell the person what to update. The host must be at least as new as its joiners (documented).
- **Host laptop sleeps:** the room is down for everyone. The recommendation is to host on an always-on dev box. This is a property of the design.

## 6. Cost to the developer
$0/month and no servers. Ops burden is limited to docs and `doctor` output. Tailscale is the user's own free account. The tmate shutdown (below) shows why a hobby project must not depend on a hosted endpoint.

## 7. Prior art
- **tmate** (https://github.com/tmate-io/tmate). Its public servers shut down in July 2025, and it "no longer works out of the box". *Avoid:* a hosted rendezvous run by the maintainer.
- **upterm** (https://github.com/owenthereal/upterm). Clients use plain `ssh TOKEN@relay` with E2E SSH, and access can be limited by `--authorized-user github:x`. *Copy:* plain ssh as the client and GitHub-key allowlists (a later `--allow github:bob` that fetches `github.com/bob.keys` instead of a minted key). *Avoid:* depending on its public relay.
- **gitolite** (https://gitolite.com/gitolite/glssh.html). One account, a forced command per key, identity in the command argument, and managed authorized_keys. *Copy:* marker-delimited managed block and per-key command. This is already the `authorize` design.
- **Eternal Terminal** (https://eternalterminal.dev/howitworks/). SSH bootstraps a session passkey, and sequence numbers resend the gap. *Copy:* resume-from-cursor (already have it). *Avoid:* a second listening port, which corporate firewalls block.
- **mosh** (https://mosh.org). UDP plus state sync survives roaming. *Avoid:* UDP, blocked on corporate networks. *Copy:* treat roaming and wake as normal events, not errors.
- **VS Code Remote-SSH** (https://code.visualstudio.com/docs/remote/troubleshooting). It installs a server pinned per client version, recommends `ControlMaster auto / ControlPersist`, and offers "Kill server on host". *Copy:* the ControlMaster defaults, an explicit version check, and a `doctor`/reset command.
- **Tailscale SSH** (https://tailscale.com/kb/1193/tailscale-ssh). It does not read authorized_keys, so it cannot enforce our forced command, and a guest would get a shell. *Avoid* it for joiners; use OpenSSH on the tailnet IP.
- **Tailscale sharing** (https://tailscale.com/kb/1084/sharing). Sharing one machine to another user is free on all tiers and quarantined, and ACLs can restrict it to port 22. *Copy:* as the "easy reachability" recipe.
- **Tailscale Funnel** (https://tailscale.com/kb/1223/funnel). It offers TLS-only TCP on 443/8443/10000 with TLS ending on the device. It could expose the user-level sshd to non-tailnet joiners, but the joiner would need TLS wrapping (`openssl s_client` as ProxyCommand). *Defer*.
- **Teleport** (https://goteleport.com/docs/). Too heavy; *copy* only expiring credentials (invite expiry, key rotation).

## 8. Milestones
1. **M1 (3 d):** stable serve shim, `host --ssh` automating keygen and authorized_keys markers, `revoke`, `links`. This fixes the plugin-update break, which is the worst latent bug.
2. **M2 (3 d):** `sh2` sealed invite with PIN, per-link `ssh_config`/known_hosts pinning, `key.rotate`.
3. **M3 (2 d):** wake and network-change reconnect, protocol window, health lines that name the fix.
4. **M4 (2 d):** `--via` ProxyJump, `link --prime` ControlMaster, `doctor`.
5. **M5 (2 d):** tailnet discovery and docs recipe, opt-in user-level sshd.
6. **M6 (2 d):** harness scenarios (bastion, sleep, upgrade) and a live run between two machines over a tailnet and a work bastion.

Total is about 2.5 weeks of evenings-scale work, all in existing modules.

## 9. Risks and open questions
- **Only one side needs reach.** Two laptops behind NAT with no tailnet and no shared box cannot connect. The SSH-first answer is "use a free tailnet". If that is unacceptable, an E2E relay plan must cover it.
- **Corporate sshd policy** (`AuthorizedKeysCommand`, `PermitUserEnvironment`, `restrict` unsupported on old OpenSSH below 7.2, auditors disliking user sshds) may block the host side. `doctor` must detect this early.
- **Versioned plugin cache path:** the current `authorize` bakes the absolute `bin` path. This must be verified against `claude plugin update` behaviour (assumed versioned under `~/.claude/plugins/cache/...`).
- **PIN entry** must happen in the person's TTY, not through the model. Is a hook-block "run this in your shell" step acceptable UX, or can `/sub-human join` read it through an AskUserQuestion-free native prompt?
- **The "room code + PIN" ideal** is only half met. Without a rendezvous, the invite is a long paste. A short code would need a directory service, which conflicts with the $0 constraint.
- **Windows joiners:** built-in OpenSSH works, but the plugin claims only macOS and Linux.

## 10. Self-score
| Criterion | Score | Why |
|---|---|---|
| Ease of join | 3 | One paste plus PIN, but reachability (tailnet or bastion) is on the user |
| Reliability | 4 | TCP+SSH, resume by cursor, wake detection; host sleep is fatal |
| Privacy | 5 | No third party in the path |
| $0 cost | 5 | Nothing hosted |
| Effort | 4 | About 2.5 weeks, no new protocol layer |
| Fit with existing code | 5 | Extends `auth`, `link`, `server` and `authorize` as already designed |
