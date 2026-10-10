# sub-human 1.0 — Productionizing remote rooms

Sources: the 10 plans and 3 evaluations in this folder.

Verdict: all three evaluators ranked 09 (core hardening), 01 (SSH-first) and 04 (tailnet) as the top three. Each plan that depends on a public service (02, 03, 05, 07, 08) needs SSH to reach coworkers behind a corporate proxy. So the strongest option is to make SSH excellent, add a WebSocket listener and expose it through Tailscale, and add a self-deployed relay only if users ask for it.

## Principles
- The developer runs no infrastructure and has no way to read messages. Every hop is either OpenSSH or end-to-end encrypted with pinned keys.
- No hand-rolled crypto:
  - Use `node:crypto` only (X25519, Ed25519, HKDF, ChaCha20-Poly1305) and raise the Node floor to 22. Node 20 reached end of life on 2026-04-30.
  - Any future short-code PAKE uses vendored, hash-pinned `@noble/curves` CPace-ristretto255 and is checked against the published test vectors.
- A PIN never seals a credential. It is checked online only: 5 tries, 15-minute lifetime, with an invite secret of at least 128 bits. The joiner types it into the join command, so the expansion hook takes it and the model never sees it. The PIN is not entered on an AskUserQuestion card, because the model can see those answers.
- Joiners create their own keys. The host admits them through a native consent card.
- Each connection spawns its own `serve --stdio` process. The server never runs in-process inside a long-lived daemon, because the lock busy-waits (`sleepSync`) and one wait would stall every link.

## 1.0 — Make what exists reliable (about 4–6 weeks part-time)
1. **Bug fix (do first).** `authorize` saves the versioned plugin cache path and a versioned `process.execPath` into authorized_keys. After a plugin update, the old server keeps running; after a Node upgrade, every link breaks. Fix: a stable `<home>/bin/serve` shim that resolves the current plugin and node at run time.
2. **Move `bin/` to `scripts/`.** Org sync rejects plugins with a top-level `bin/`. Bump `version` on every release, because marketplace auto-update is off by default.
3. **Transport registry.** Replace the three hard-coded kind switches, accept a Duplex adapter, and allow `open()` to be async. A later transport then costs 1–3 days.
4. **Protocol skew.** `hello` carries a min/max version range and the client version. The error names which side needs to update. Old clients tolerate unknown entry kinds.
5. **Reconnect hardening, once, in `link.ts`:**
   - jittered backoff;
   - an immediate redial on wake or network change;
   - app-level ping;
   - make the new connection before dropping the old;
   - automatic rejoin of the seat after the lease lapses;
   - a bounded `@room` outbox, which never queues answers or consent.
6. **`/sub-human host --ssh`, one step.** It mints the invite, installs the forced-command key through the shim, and prints a `sh2` invite plus a PIN. Also:
   - `--via` for ProxyJump through a bastion;
   - a primed ControlMaster for MFA bastions;
   - `revoke` to remove access.
7. **Planned `handoff`.** The host moves the room to another member before closing the laptop. A consent card appears first, because the room's Claude moves to the new host's model account. There is no automatic failover, since that causes split-brain forks.
8. **Observability.**
   - `sub-human doctor`, with a redacted `--bundle` for sharing diagnostics;
   - link state shown on the room row and the statusline.
9. **CI.** GitHub Actions runs the unit tests, the Toxiproxy chaos tests, and a skew test against the previous release. Fix or quarantine the known flaky tests.
10. **Docs.**
    - Recommend hosting on an always-on dev box.
    - Remote Control (phone) needs a claude.ai subscription and does not work with Bedrock or API keys, so Bedrock users won't have a phone client.
    - Publish the threat model.

Who this serves: coworkers on SSH dev boxes, including through bastions and with Bedrock, and anyone already on a tailnet.

## 1.1 — URL + PIN for friends (about 2 weeks)
- Add a `ws:` listener daemon on 127.0.0.1 that spawns `serve --stdio` for each connection. It is a minimal zero-dependency WebSocket server in `lib/remote/ws.ts`.
- The joiner pins the host key carried in the invite, and the session runs over a Noise channel built on `node:crypto` with no PAKE.
- Ship it as a Tailscale recipe:
  - **Serve (tailnet only):** the default.
  - **Funnel:** opt-in, so friends without Tailscale can join with only a URL and PIN. The hostname appears in public certificate logs.
- Joining is `/sub-human join NAME https://box.tailXXXX.ts.net/ABCD 482913`.

## 1.2 — Only if people ask: a relay for two laptops behind NAT
- The host deploys their own Cloudflare Durable Object relay, or runs the same relay protocol as a Node process (`sub-human relay`) on a team VM. Either way it forwards ciphertext only, using Noise KK with pinned keys.
- Do not ship a community default relay. Cloudflare's terms forbid "proxy services", and the developer would be the one running it.

## Rejected
| Plan | Reason |
|---|---|
| 03 wormhole | Relies on the public mailbox's goodwill and needs hand-written SPAKE2. |
| 05 hyperdht | Pulls in 56 packages including native modules, and fails where UDP is blocked. |
| 06 S3/git | The bucket setup is hard for friends to join, and it seals a credential under a 4-digit PIN. |
| 07 Nostr | Etiquette concerns with public relays, corporate networks flag it as crypto traffic, and plan 07 claims node:crypto has XChaCha20, which it doesn't. |
| 08 trycloudflare | Cloudflare documents quick tunnels as for testing only, the domain is commonly blocked, and the plan hand-writes Elligator2. |
| 10 team relay | Kept as the 1.2 Node relay option, not as the main path. |

## Decisions
1. Node floor is raised to 22.
2. Funnel stays opt-in; tailnet-only Serve is the default.
3. Scope of this build: 1.0 and 1.1. 1.2 (relay) is deferred.

Research inputs: docs/next/prod-research/ (plans 01 SSH-first, 04 tailnet, 09 core hardening, and the three evaluations).
