# Feasibility evaluation: ten production plans

"d" means focused days. Part-time gives about 1.5 a week.

## 1. Claims checked against the code

| Claim | Verdict | Evidence |
|---|---|---|
| `serve --stdio` sits unchanged behind a listener (04, 07, 08, 10) | **Confirmed** | `server.serve(transport, …)` takes any `{send, onFrame, onClose, close}`. Spawning `serve --stdio CODE` and piping bytes needs no change to server.js. |
| `server.js` in-process in a long-lived daemon (02, 03, 05, 06) | **Works, risky** | `lib/lock.js` waits with `sleepSync`, and seats, place and decide are synchronous. One lock wait stalls every link in the daemon. One process per connection keeps today's isolation. |
| Plan 06: "split the handler from the stdio loop" | **Refuted** | `serve()` is already independent of the transport. |
| A new duplex transport slots in cleanly | **Partly** | `lineTransport` makes a new kind about 15 lines. But kinds are hard-coded in `transportOf`, `connectLink` and `transports/index.open`. `open()` is synchronous and hello goes out at once, so a transport that connects asynchronously (WS, handshake, DHT) needs an async `open()`. |
| PAKE: "impossible in node:crypto" (05) vs "40–60 lines of BigInt" (02, 08) | **Unclear** | Doable, but hand-rolled security code. Plan 05's alternative is sound and cheaper: pin the host's public key in the invite and use the PIN as an online second factor. |
| **Plan 01: `authorize` bakes a versioned plugin path** | **Confirmed, worse** | The line uses `fs.realpathSync(__filename)` **and** `process.execPath`. The cache is `cache/<marketplace>/<plugin>/<version>/` (docs; the local cache matches and keeps old versions). After an update, sshd silently runs the *old* server against the host store. The node path is versioned too (`~/.nvm/…/v24.15.0/bin/node`). The shim fits the existing `<home>/bin/row-status` pattern. |
| **Plan 09: org sync rejects top-level `bin/`** | **Confirmed** | The docs say: "claude.ai rejects a plugin that has one". `plugin/sub-human/bin/` is exactly that. |
| **Plan 09: auto-update is off by default** | **Confirmed** | The docs say: "Background auto-update is off for your marketplace by default." So host/joiner version skew is the normal case, which makes hello version ranges a 1.0 item. |
| Plan 01: the sealed key's 6-digit PIN can be brute-forced offline | **True, low impact** | `serve --link ID` takes only that link's token or its unredeemed invite. A key cracked after redemption gets an unauthenticated hello, so `key.rotate` is optional. |

## 2. Shared building blocks

| Block | Reinvented by | Minimal shared version |
|---|---|---|
| Transport registry | all | Map each kind to `{parse(locator), open(spec) -> Promise<Transport>}`, plus `fromDuplex(stream)` over `lineTransport`. Move pipe and memory onto it. About 120 lines, no behaviour change. |
| Stable server shim | 01 (every listener needs it) | `<home>/bin/sub-human`, rewritten at SessionStart to point at the current plugin root and node. `authorize` and the listeners spawn through it. |
| Host listener daemon | 02–05, 07, 08, 10 | `listener.js` takes a Duplex from any acceptor (TCP, WS, relay, DHT). It enforces pre-auth limits (hello deadline, frame cap, per-IP count), spawns `serve --stdio` through the shim and exits when idle, like `link.js`. This ends "no host daemon"; document that once. |
| WebSocket | 02, 04, 07, 08, 10 | `ws.js`: RFC 6455 server and client, HTTPS_PROXY CONNECT, close on a missed ping. About 300 lines. Node's global `WebSocket` ignores proxy environment variables, so we need our own client anyway. |
| E2E channel | 02, 03, 07, 08, 10 | `secure.js`, Duplex to Duplex: Noise IK/NK (X25519, HKDF, ChaCha20-Poly1305), host key pinned from the invite, token-derived PSK for reconnects. **No PAKE at first.** |
| sh2 invite with PIN | 01, 02, 04, 05, 07–10 | `{code, locators[], hostKey, secret, expires}`, PIN stored as a hash, 5-attempt burn, 15-minute TTL. Take the PIN through the expansion hook, as invites are taken today. An AskUserQuestion answer (05, 06, 09, 10) is visible to the model. |
| Reconnect hardening | 01, 09; per-transport pings in 04, 07, 08 | Build it once in `link.js` and the protocol: a `ping` op, wake detection, jittered backoff, session supersede, auto-rejoin, and a hello version range. |

Then a new transport costs 1–3 d.

## 3. Scores (5 = least effort / best fit / least maintenance)

| Plan | Claimed | Realistic | Effort | Fit | Maint | Main issue |
|---|---|---|---|---|---|---|
| 01 SSH-first | 14 d | 20 d (trimmed 10) | 4 | 5 | 4 | User sshd, ControlMaster priming and key rotation are extras |
| 09 Core hardening | 48 d | 60+ d (trimmed 25) | 2 (3) | 5 | 3 | Handoff, promote and outbox add a large stateful surface |
| 04 Tailnet | 11 d | 20 d | 4 | 5 | 3 | The Tailscale CLI JSON is unstable; needs no crypto of its own |
| 02 CF relay | 13 d | 35 d (20 without CPace) | 2 | 4 | 2 | Hand-rolled crypto, wrangler drift, user must deploy |
| 08 Tunnels + PIN | 22 d | 35 d | 2 | 4 | 2 | Brittle adapters, trycloudflare widely blocked |
| 05 hyperdht | 11 d | 22 d | 3 | 4 | 2 | Native addons, ABI bumps, fails without UDP |
| 10 Team relay | 37 d | 50+ d | 1 | 3 | 2 | Host move rewires `isHost`; only M0–M1 are cheap |
| 07 Nostr/ntfy | 19 d | 35+ d | 2 | 3 | 1 | Rebuilds TCP over pub/sub; relay churn |
| 06 S3/git mailbox | 27 d | 45+ d | 1 | 2 | 2 | Polling replaces subscribe; pump, epoch keys, SigV4 |
| 03 Wormhole + P2P | 32 d | 60+ d | 1 | 3 | 1 | Three protocol clients, volunteer infrastructure |

**Overall rank:** 01, 09 (trimmed), 04, 02 (without CPace), 08, 05, 10, 07, 06, 03.

## 4. Build order

**1.0: harden what exists (about 25–30 d)**
- Stable shim; `authorize` writes the shim path.
- Move `bin/` to `scripts/`; README note on turning on auto-update.
- Hello version range, with "update the host" / "update yours" health lines.
- Reconnect hardening.
- `host --ssh` does invite and authorize in one step (marker block), plus `revoke`.
- Basic `doctor`.
- Transport registry refactor.
- Harness plus an N-1 version-skew job in GitHub Actions.

**1.1: reachable without SSH (about 15–20 d)**
- `listener.js`, `ws.js`, a `wss:` locator and sh2 PIN invites.
- Ship it as plan 04's Serve/Funnel recipe. It works the same for a LAN, a tailnet IP or a bring-your-own tunnel URL (no adapters).

**1.2: two laptops behind NAT (about 20 d)**
- `secure.js` (pinned host key, no PAKE).
- A relay transport and one dumb relay: about 150 lines as a self-deployed Cloudflare DO, with the same wire protocol as a Node process for homelab or team use (plan 10 M0–M1).

**Later, on demand:** CPace short codes, hyperdht opt-in, handoff/promote, outbox, sealed replica. **Skip:** Nostr, S3/git mailbox, wormhole/TURN.
