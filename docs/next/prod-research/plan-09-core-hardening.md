# Plan 09: Core hardening for 1.0 (transport-agnostic)

## 1. Summary
- Treat the transport as a small part of the problem. Most remote failures come from version skew, sleep, stale leases, silent forks and missing diagnostics, and those happen on any transport.
- Make the existing link survivable: version-range negotiation, faster reconnect after sleep, a bounded outbox for `@room` posts only, planned host handoff, `sub-human doctor`, and link state on the room row.
- Run the Docker+Toxiproxy harness, plus an N-1 version-skew test, in free GitHub Actions. Ship through the marketplace with stable and latest channels.
- **Ship 1.0 on SSH**, with a documented recipe for hosting on an always-on dev box or tailnet. It is already built and tested, costs $0, is end-to-end by construction, and fits Bedrock-on-SSH-devbox work. A zero-knowledge relay comes in 1.1 as a fourth transport behind the same seam.
- No developer-run infrastructure, and the developer never sees a byte of anyone's messages.

## 2. User journey
**Host** (ideally on the always-on dev box they already SSH into):
```
/plugin marketplace add tatimblin/sub-human     # one time; turn on auto-update in /plugin
/plugin install sub-human@sub-human
/sub-human new                                  # creates the room and seats you
/sub-human host --ssh me@devbox.corp            # prints: sh1.vole-8126.… and PIN 482-913 (to the person, never the model)
```
**Joiner:**
```
/plugin install sub-human@sub-human
/sub-human join alice sh1.vole-8126.…           # asks for the PIN in an AskUserQuestion card
```
If SSH refuses the joiner's key, `join` prints a single line for the host: `sub-human authorize L7 ssh-ed25519 AAA…`. When the host pastes it, the host's hook shows an "Allow alice's key into vole-8126?" card, so approval stays a native consent dialog. Two pastes is the honest cost of SSH.

**Phone (Remote Control):** nothing is transport-specific. The phone drives that person's own Claude Code session. Notices, plan-view consent and question cards already reach it. Hosting on a dev box means a sleeping laptop does not stall the room for phone users. The room row shows `● online`, `◐ reconnecting`, `○ offline 2m` or `⚠ update host`.

**Diagnose:** `sub-human doctor` (either side), and `sub-human doctor --bundle` to produce a redacted tarball to attach to a GitHub issue.

## 3. Architecture changes
| Area | Change | Files |
|---|---|---|
| Version negotiation | `hello{v}` becomes `hello{vmin, vmax, client:"sub-human", version:"1.0.3", caps}`. The server picks the highest common v. Ops are gated by `caps`, not by v. A mismatch returns `PROTOCOL` with `{need:">=1.0", fix:"claude plugin update sub-human@sub-human"}` (Syncthing-style client name and version in Hello). Unknown log `kind`s render as "(newer entry, update to see)" and never throw. | `lib/remote/protocol.js`, `server.js`, `client.js`, `lib/room/validate.js`, `render.js` |
| Log format | Add `fmt` to `room_created`. Readers refuse only a higher major and warn on a higher minor. Sig v1 and v2 stay verifiable forever. | `lib/room/envelope.js`, `store.js` |
| Reconnect | Full-jitter backoff from 1 s to 30 s. A **wake detector** (a monotonic vs wall-clock jump of more than 5 s, or the daemon timer firing late) resets the backoff and redials at once (Mosh). An app-level `ping` every 15 s with a 2-miss timeout, so a half-open TCP or ssh link is caught without relying on `ServerAliveInterval`. **Reconnect-before-disconnect** (Zed #8684): a new hello on the same link token supersedes the old session on the server. | `lib/remote/link.js`, `server.js`, `lib/config.js` |
| Seat lease after sleep | When the daemon is back online with a lapsed lease, it re-`join`s automatically with the pinned key and a fresh proof (`rejoin:true`). The host logs `member_returned` rather than leave and join noise. Presence follows Yjs awareness: refresh every 15 s, expire after 30 s, and send an explicit `null` on clean leave. | `link.js`, `lib/seats.js`, `lib/room/members.js` |
| Outbox | An `@room` post made while `OFFLINE` is signed at once (the nonce and `ts` are fixed), written to `<mirror>/outbox/` (0600), and shown as "queued, sends when online". The daemon flushes it in order after subscribe catch-up. A post older than `SIG_SKEW_MS` (10 min) is dropped with a notice, never re-signed silently. **Answers, consent and joins are never queued**, because stale consent is worse than none. The cap is 20 posts. | `lib/remote/bridge.js`, `link.js`, new `lib/remote/outbox.js` |
| Planned handoff | `sub-human handoff --to <member>@<machine>` (host-only, consent card on both ends). The host stops the room's Claude, appends a signed `host_moved{new_locator, auth_digest}` entry, and streams `auth.json` (token hashes only) to the new host over the existing link. The new host's mirror is already byte-identical, so it becomes the FsRoomStore. Mirrors read `host_moved` and rewrite `links.js` to the new locator. The old host becomes a mirror. | `lib/room/store-mirror.js` (`promote()`), `links.js`, `auth.js`, `lib/room-claude.js` |
| Room Claude move | The room's Claude restarts on the new host **under the new host's model account**. That is a billing change, so it needs an explicit AskUserQuestion on the new host ("Run the room helper on your Bedrock/Anthropic account?"). The room's Claude rebuilds from `tasks` plus the log digest, with no session transfer. If the answer is no, the room runs without a room Claude. | `lib/room-claude.js`, `lib/tasks.js` |
| Unplanned failover | No automatic multi-host failover in 1.0. Without consensus it means split-brain, and the hash chain would turn that into a FORK for everyone. Instead, `sub-human promote` (manual, any member, after the host has been offline for at least 10 min) appends `host_moved` from that member's mirror tip. A returning old host sees `host_moved` in the new host's stream. Its own lines after the fork point go to `orphaned-<ts>.jsonl` and are shown, never merged. | same, plus `link.js` FORK path |
| Observability | The daemon writes a structured JSON-lines log (`<mirror>/link.log`, rotated at 1 MB) with no message bodies. `link.json` gains `rtt_ms`, `last_online`, `reconnects`, `peer_version`. The room row in `statusline/segments.js` adds link state. | `link.js`, `statusline/segments.js` |
| Doctor | Checks: node version; plugin version on both ends (via hello); clock skew against the host (`ts` in the hello reply, warning at 2 min, failure at `SIG_SKEW_MS`); `ssh -T BatchMode` reachability; the forced-command line present; `known_hosts`; socket dir perms 0700; hooks module enabled; link state; chain verify. The `--bundle` option omits the log, keys, tokens and invite secrets, and writes hashes only. | new `lib/doctor.js`, `bin/sub-human` |

## 4. Security and privacy
- **The host machine reads everything in its room** (it holds the log). Every mirror machine reads the whole log too ("addressed is not private"). Nobody else does: SSH gives end-to-end encryption between the two machines, and nothing runs through the developer.
- **The developer** hosts a public git repo and sees no traffic. A future relay must carry only ciphertext (Noise or TLS inside an opaque pipe, like Syncthing relays), with a PAKE over the PIN so the relay cannot MITM the invite.
- **PIN:** the invite secret is split into a URL half and a 6-digit PIN that is never in the link. Redemption is single-use and locks after 5 bad PINs, so a leaked invite URL alone is useless.
- Handoff moves token **hashes** only. Seat keys never leave their machine. `host_moved` is signed by the outgoing host's seat key, or for `promote` by the promoter, and it is visible and attributable in the log.
- The bundle is redacted by construction (an allowlist of fields, not a denylist).
- New `docs/THREAT-MODEL.md`: assets (seat keys, link tokens, log, plans), actors (a steered Claude, a malicious member, a network attacker, a curious relay, a hostile local user), transport-agnostic invariants, and what each transport must guarantee. It replaces the README section and links to it.

## 5. Reliability
- **Reconnect and resume:** `subscribe{after,hash}` already does what Syncthing's `{index ID, max sequence}` delta does. Keep it. Add jittered backoff, wake detection, app pings and session supersede.
- **NAT and corporate networks:** SSH outbound on port 22 to a dev box works on most corporate networks. Where it is blocked, doctor names the tailnet or `ProxyJump` recipe via `SUB_HUMAN_SSH_OPTS`.
- **Sleep:** the joiner's laptop wakes, redials within about 1 s, re-joins if its lease lapsed and flushes the outbox. The host sleeping is the real problem. The answers are host on the dev box (docs default), planned handoff, or manual promote.
- **Partitions:** reads continue from the mirror. Writes queue (posts only) or get a clear refusal. A FORK is never silent.
- **Upgrades:** compatibility is N-1 minor (1.1 talks to 1.0). The host serves `[vmin..vmax]`. A breaking change needs a major bump plus a release-note banner. Hello carries `version`, so the statusline can say which side to update.

## 6. Cost to the developer
**$0/month.** The marketplace is the public GitHub repo, and Actions are free for public repos (Docker on `ubuntu-latest`). Ops burden: triaging `doctor --bundle` issues, plus about 1 hour per release to tag, bump `version` and update the stable branch. No servers, no keys held, no data.

## 7. Prior art
- **Zed collab** (reconnect before disconnect, [commit](https://git.secluded.site/zed/commit/5523a510c5f3d7b4c0e18bc58d98d392fc14a83a); [rejoin test](https://git.secluded.site/zed/commit/1a3940a12ef676e8dfd2e4ab73774694596159e5)). *Copy:* the server accepts the new connection and maps it to the old participant before timing out the old one. *Avoid:* Zed needs its central collab server, which we won't run.
- **VS Code Live Share** ([connectivity](https://learn.microsoft.com/en-us/visualstudio/liveshare/reference/connectivity)). *Copy:* named modes (auto, direct, relay) and a "can you reach X" check, which becomes our doctor. *Avoid:* a vendor relay that terminates sessions.
- **Syncthing** ([BEP](https://docs.syncthing.net/specs/bep-v1.html), [relay](https://docs.syncthing.net/specs/relay-v1.html)). *Copy:* client name and semver in Hello, delta resume by sequence, and relays that carry end-to-end TLS so the relay is blind. *Avoid:* public relay and discovery pools that someone has to operate.
- **Mosh** ([mosh.org](https://mosh.org/)). *Copy:* treat sleep and roaming as normal, use heartbeats, show "last contact N s ago", resume silently. *Avoid:* a UDP-only transport, which corporate firewalls drop.
- **Yjs y-protocols** ([PROTOCOL.md](https://github.com/yjs/y-protocols/blob/master/PROTOCOL.md)). *Copy:* the awareness timings (15 s refresh, 30 s expiry, explicit null on leave) for presence. *Avoid:* CRDT merge. Our log is single-writer by design, and a fork must stay loud.
- **Claude Code marketplace** ([host](https://code.claude.com/docs/en/plugins/host-marketplace), [create](https://code.claude.com/docs/en/plugin-marketplaces)). Users get updates only when `version` changes. Auto-update is off by default, so the README must say to turn it on. Channels are two marketplaces (`stable`, `latest`) on different refs. Use `renames` and never rename the plugin. **Org sync rejects a plugin with a top-level `bin/`**, so `plugin/sub-human/bin/` must move to `scripts/` before teams can push it through claude.ai org settings.

## 8. Milestones
1. **M1 Versioning and release (1 wk):** hello range and caps, `fmt`, unknown-kind rendering, `bin/` to `scripts/`, CHANGELOG, `stable`/`latest` marketplaces, `claude plugin validate` in CI.
2. **M2 CI and flakes (1 wk):** GitHub Actions matrix (node 20/22/24 × linux/mac) for unit tests. A Linux job runs the remote-docker harness. A nightly loop runs each test 50 times and quarantines flakes into `test/quarantine.json` with an owner. Replace sleeps with `lib/clock.js` fakes and condition waits.
3. **M3 Reconnect (1.5 wk):** jitter, wake detector, app ping, supersede, auto-rejoin, presence timings. Chaos tests: Toxiproxy `timeout`, `reset_peer`, `latency`, `slicer` and `bandwidth`; `docker pause` to simulate sleep; libfaketime for clock skew and jumps.
4. **M4 Outbox (0.5 wk)** with tests for expiry and ordering.
5. **M5 Doctor, bundle and room-row status (1 wk).**
6. **M6 Planned handoff and room Claude move (2 wk)**, then manual `promote` and the orphan export (1 wk).
7. **M7 N-1 skew job (0.5 wk):** host at the last stable tag, client at HEAD, and the reverse. Plus THREAT-MODEL.md.
8. **M8 PIN-split invites (0.5 wk).**

Total about 9–10 weeks part-time. 1.1 adds an end-to-end relay transport behind `transports/`.

## 9. Risks and open questions
- SSH join still needs the host to paste `authorize`. That is the weakest part of ease of join, and a relay or tailnet fixes it, not this plan.
- Handoff needs the new host reachable over SSH by every member. Each joiner may need a new `authorize` on the new host, so the token-hash copy is not enough for SSH keys. One option: re-run authorize from the handoff card.
- A manual `promote` while the old host is merely slow, not gone, causes a fork. The 10-minute gate plus the visible orphan file limits the damage. Is that acceptable?
- Is the room's Claude rebuildable from tasks plus a digest alone? This needs a test.
- macOS runners lack Docker, so the harness is Linux-only in CI.

## 10. Self-score
| Criterion | Score (1–5) |
|---|---|
| Ease of join | 3 (SSH second paste) |
| Reliability | 5 |
| Privacy | 5 |
| $0 cost | 5 |
| Effort | 2 (about 10 wk) |
| Fit with existing code | 5 |
