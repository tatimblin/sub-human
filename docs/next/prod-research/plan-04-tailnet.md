# Plan 04: Overlay-network native (Tailscale first, with Funnel for everyone else)

## 1. Summary
- The host binds a small TCP/WebSocket listener to 127.0.0.1 only. It drives the host's own `tailscaled` with `tailscale serve --bg` (tailnet joiners) or `tailscale funnel --bg` (joiners with no Tailscale). It does not embed tsnet.
- Every connection is still handed to today's process-per-connection `serve --stdio`, so file locks, auth and the protocol stay the same. Only a new `wss:` locator and transport are added.
- Join = URL + 6-digit PIN: `/sub-human join NAME https://box.tail1a2b.ts.net/ABCD 482913`. The PIN is the single-use invite secret, with a 15-minute TTL and 5 tries.
- Developer cost is $0. Tailscale (or self-hosted Headscale) belongs to the user. Funnel relays only see TLS ciphertext, and the TLS ends on the host.
- Weak spots: the host must run Tailscale, which some corporate machines forbid. A laptop host that sleeps takes the room offline. Phone is unaffected, because Remote Control drives a seated session.

## 2. User journey
**Host (once per machine):** install Tailscale, run `tailscale up`, and turn on HTTPS certificates and Funnel in the admin console (the plugin prints the exact link if they are off).

**Host (per room)**, inside Claude Code:
```
/sub-human alice                 # opens room ABCD, as today
/sub-human host                  # auto-picks: Funnel if allowed, else tailnet Serve, else falls back to --ssh
  -> block reason (person only): Join: https://box.tail1a2b.ts.net/ABCD   PIN 482913 (15 min, single use)
/sub-human host --tailnet        # force tailnet-only (Serve), no public exposure
```
Behind the scenes: `sub-human listen` starts on `127.0.0.1:<port>`, then `tailscale funnel --bg --https=443 --set-path=/sh http://127.0.0.1:<port>` runs. The path is namespaced so it does not clobber the user's other serves.

**Joiner with no Tailscale (works through any corporate network that allows HTTPS out):**
```
/sub-human join bob https://box.tail1a2b.ts.net/ABCD 482913
```
**Joiner on the same tailnet, or holding a node share:** same command. The client resolves the MagicDNS name over the tailnet when `tailscale status` shows it as a peer, so traffic stays peer-to-peer WireGuard.

**Discovery (optional, tailnet only):** `/sub-human rooms` lists open rooms on tailnet peers via `GET /sh/.well-known/rooms`, which returns codes only. You still need a PIN.

**Phone:** no change. The person starts Remote Control on the session that holds their seat (laptop or SSH dev box), and the phone drives that session. Native plan and question cards render on the phone exactly as today. The phone never speaks the room protocol and needs no Tailscale.

**Rejoin:** `/sub-human bob ABCD`. The link token is stored and the daemon reconnects by itself.

## 3. Architecture changes
| Area | Change |
|---|---|
| `lib/remote/transports/ws.ts` (new, ~250 lines, zero deps) | RFC 6455 framing over `node:http` upgrade (server) and `node:https`/`tls` (client). Text frames carry today's NDJSON lines through `lineTransport`. Ping every 15 s; 2 missed pongs closes the link, mirroring ssh's `ServerAliveInterval`. Node 22's global `WebSocket` is used client-side when present. |
| `lib/remote/transports/index.ts` | `KINDS += 'ws'`. `open({kind:'ws', url})`. |
| `lib/remote/link.ts` | `wssLocator(host, port?, path)` and `transportOf('wss:host[:port]/path')`, validated like ssh: a hostname plus an optional port and a fixed path charset, with no userinfo or query. Allow only `*.ts.net` hosts or the user's own `--allow-host`, so an invite cannot point the daemon at an arbitrary server. |
| `bin/sub-human listen` (new) → `lib/remote/listener.ts` | A per-host daemon, one per home. It accepts WS upgrades and spawns `serve --stdio CODE` per connection, piping frames both ways, so `server.ts` is untouched. It also enforces pre-auth limits: 1 MiB frames, 8 unauthenticated connections per IP (taken from `X-Forwarded-For` / Tailscale-Funnel headers, or the proxy-protocol header), a 10 s hello deadline, and an idle exit when no hosted room has a link. |
| `lib/remote/tailscale.ts` (new) | Wraps the CLI: `tailscale status --json` (DNS name, Funnel capability, peer list), `serve`/`funnel --bg … ` and `… off` on room close, `whois --json` (advisory display of who the tailnet peer is). It wraps every call with a timeout. |
| `lib/remote/auth.ts` | `mintInvite({pin:true})` adds a 6-digit secret, `expires_at`, and an attempt counter (5 tries, then the invite burns). Redemption stays the same: the hashed link token replaces the invite. `parseJoinUrl(url, pin)` → `{code, locator, secret}`, so the rest of the join path sees a normal invite. |
| `hooks/join.ts`, `/sub-human host` | Add the `join NAME URL PIN` form. `host` picks the transport. The block-reason text is shown to the person only, as today. |
| `lib/room/links.ts` | The link file stores `transport: {kind:'ws', url}`. Nothing else changes. |
| `scripts/remote-docker/` | Add a Headscale + DERP container pair and a Toxiproxy-fronted ws listener. Run the existing reconnect/FORK suites against ws. |

Not done: tsnet embedding. libtailscale ships C/Swift/Python/Ruby bindings only, and using it from Node needs a cgo shared library plus an N-API addon, which breaks "zero dependencies". A Go sidecar binary is possible later (M5) but adds a release pipeline.

## 4. Security and privacy model
- **Developer:** sees nothing and runs nothing.
- **Tailscale Inc.:** coordinates keys and sees metadata: which nodes exist and that they connected. Tailnet traffic is WireGuard end-to-end, and DERP relays forward ciphertext. Funnel relays proxy TCP. The TLS certificate and key live on the host node, so Tailscale "cannot access or read any content" (Funnel docs). Users who object can use Headscale (self-hosted control plane). Funnel does not exist there, so those users choose tailnet-only or ssh.
- **Host machine:** reads everything. It is the room. This is unchanged.
- **Public internet (Funnel):** can reach the listener and nothing beyond `hello`. Defences are a single-use PIN invite (5 tries × 1e-6 per guess), hashed tokens, Ed25519 seat proofs, signed via=human entries and the hash chain. A leaked URL without the PIN is useless. A leaked URL+PIN is good for one join within 15 minutes. That join is visible in the room as `member_joined`, and the host can `sub-human revoke LINK`.
- **Integrity:** sig v2 plus the hash chain mean that a compromised transport can drop entries but cannot forge them. FORK detection is unchanged.
- **Tailnet ACL:** the listener only hears 127.0.0.1, and Serve/Funnel are the only ingress. LAN neighbours cannot connect. Node sharing gives the friend access to that node only, and the share is quarantined (it cannot start connections back).

## 5. Reliability
- **Reconnect:** the existing link daemon backoff (1 s → 10 s) and `subscribe{after,hash}` resume work as they are. The ws transport closes on a missed pong, so a dead path is noticed in about 30 s rather than at the TCP timeout.
- **NAT / corporate:** Funnel joiners make only outbound HTTPS 443 to a public `ts.net` name with a valid certificate. That gets through HTTP proxies via CONNECT; honour `HTTPS_PROXY`, and leave `NODE_EXTRA_CA_CERTS` to the user for TLS-inspecting proxies. A WebSocket upgrade survives most inspecting proxies. Raw TCP Funnel (`--tls-terminated-tcp`) is kept as a fallback cap, not the default. Tailnet joiners get Tailscale's NAT traversal with DERP-over-443 fallback.
- **Sleep:** a joiner's sleep is today's offline→online path. A host's sleep makes the room OFFLINE for everyone. The docs recommend hosting on the always-on SSH dev box, which fits the Bedrock workflow. `tailscaled` can run in userspace-networking mode without root on boxes that forbid TUN devices. `serve --bg` persists across reboots, and `sub-human listen` is restarted by the join hook when a seated room has links.
- **Partitions:** the mirror keeps reads. Writes return OFFLINE, as designed. A FORK is never auto-repaired.
- **Upgrades:** `hello` already negotiates `v` and `caps`. Add the cap `ws1`. An old client fails with PROTOCOL and a "update sub-human" message. The listener and server versions travel together because they are on the same host.
- **Tailscale outages:** the coordination server being down does not break existing tailnet connections. Funnel depends on Tailscale's ingress, so ssh stays as a documented fallback.

## 6. Cost to the developer
$0/month and no ops. Users can use Tailscale's free Personal plan (Funnel and sharing are "available for all plans"). Funnel bandwidth limits are not configurable, but NDJSON chat plus plan blobs of 1 MiB or less is tiny. The only maintenance is tracking changes to the `tailscale` CLI output, which an `npm run probe` check covers, the same way `lib/cc.ts` handles Claude Code.

## 7. Prior art
- **Tailscale node sharing** (https://tailscale.com/kb/1084/sharing): the recipient must already have a tailnet and be its admin, and the shared node is quarantined. *Copy:* least-exposure sharing. *Avoid:* making it the primary join path. Asking a coworker to make a tailnet is too much friction, so it is an option, not the default.
- **Tailscale Funnel** (https://tailscale.com/kb/1223/funnel): ports 443/8443/10000 only, TLS terminated on the node, relays never decrypt. *Copy:* this is our zero-knowledge "relay we don't own". *Avoid:* assuming it is enabled. Detect it, and print the admin link.
- **Tailscale Serve** (https://tailscale.com/kb/1242/tailscale-serve): `--bg` persists, path mounts, `--proxy-protocol`, identity headers for tailnet users. *Copy:* use path mounts so we coexist with other serves, and use proxy-protocol for per-IP rate limits.
- **tsnet / libtailscale** (https://tailscale.com/kb/1244/tsnet, https://github.com/tailscale/libtailscale): there is no Node binding. *Avoid:* embedding for v1.
- **golink** (https://github.com/tailscale/golink): becomes a MagicDNS name (`go`) and authorizes with WhoIs. *Copy:* WhoIs as an advisory label ("bob@corp via tailnet"). *Avoid:* using WhoIs instead of seat keys, since Funnel users have no identity.
- **tsidp** (https://github.com/tailscale/tsidp): deny-by-default admin endpoints, persistent state required, Funnel for outside reach. *Copy:* the deny-by-default listener and no state in the proxy.
- **Headscale** (https://headscale.net/stable/): a single self-hosted tailnet with no Funnel. *Lesson:* support it in tailnet-only mode, and test in Docker with it, which needs no account.
- **NetBird** (https://pkg.go.dev/github.com/netbirdio/netbird) and **ZeroTier** (https://discuss.zerotier.com/t/zerotier-private-network-limit-free-tier/17486): both are WireGuard/P2P overlays with relays, and ZeroTier's free tier has shrunk. *Lesson:* the transport must stay overlay-agnostic (`wss:` to any hostname with `--allow-host`), so a NetBird/ZeroTier/Nebula IP works with `host --listen 100.x.y.z`. Only the convenience wiring is Tailscale-specific.

## 8. Milestones
- **M1, ws transport + listener (4–5 days):** `ws.ts`, `listener.ts`, `wss:` locator, Docker tests with Toxiproxy (latency, reset, black-hole).
- **M2, PIN invites + URL join (2 days):** `auth.ts` PIN/TTL/attempts, `join NAME URL PIN`, revoke.
- **M3, Tailscale wiring (3 days):** `tailscale.ts`, auto-pick Funnel/Serve/ssh in `/sub-human host`, teardown on close, probe checks, Headscale container in CI.
- **M4, discovery + polish (2 days):** `/.well-known/rooms`, `/sub-human rooms`, WhoIs labels, proxy env support.
- **M5, optional (1–2 weeks):** a Go tsnet sidecar so a host can join a tailnet without installing tailscaled. Do it only if demand shows up.

## 9. Risks and open questions
- Corporate policy may forbid installing Tailscale on the dev box, leaving no Funnel. Fallback: ssh invites (existing), or a host on a personal machine. Is that acceptable for the work use case?
- Enabling Funnel needs a tailnet-admin click and a policy `nodeAttrs` entry. That is one-time, but it is friction for first-time hosts.
- Funnel exposes a public endpoint. The pre-auth surface (listener + hello) needs fuzzing and strict limits.
- A 6-digit PIN is fine because guesses are online-only and limited. Should a PAKE (CPace over X25519) bind the PIN to the channel instead? It is not needed while TLS ends at the host.
- A host laptop that sleeps is a hard limit of host-centric rooms. That problem belongs to other plans (log replication / host failover).
- The `tailscale` CLI's JSON is not a stable API, so it needs probe coverage.

## 10. Self-score
| Criterion | Score |
|---|---|
| Ease of join | 4 (URL+PIN, no install for joiners. The host needs Tailscale and a Funnel toggle.) |
| Reliability | 4 (DERP/NAT traversal and HTTPS 443 work well. A sleeping host is the weak spot.) |
| Privacy | 4 (E2E to host. Tailscale sees metadata only. Headscale is an option.) |
| $0 cost | 5 |
| Effort | 4 (about 2.5 weeks to M4) |
| Fit with existing code | 5 (one new transport + listener. server.ts, protocol and auth model unchanged.) |
