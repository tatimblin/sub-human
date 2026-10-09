# Evaluation: user experience and real-world reliability

## The finding that changes the phone story

Every plan says "Phone: nothing changes." For the user's work setup, that is wrong. The Remote Control docs say it is "not available" when "you use Amazon Bedrock, Google Cloud's Agent Platform, or Microsoft Foundry". It also fails behind a custom `ANTHROPIC_BASE_URL`, and it needs a claude.ai Pro, Max, Team or Enterprise login. API keys are not supported. ([docs](https://code.claude.com/docs/en/remote-control))

No transport rescues persona (d) for Bedrock coworkers; phone works only for subscription members whose machine stays up. Phone scores below measure only what a transport affects: can join and PIN be done from the phone (01's TTY PIN cannot), and does the session recover after sleep.

## 1. Persona walk-through

✅ succeeds, ◐ with fallback or friction, ❌ fails. Numbers are join steps.

| Plan | (a) Home friends, NAT | (b) Corporate, bastion, proxy | (c) Host laptop sleeps | (d) Phone-only |
|---|---|---|---|---|
| 01 SSH | ◐ 6+. Both need Tailscale plus a `tailscale share` | ✅ 3. `--via` ProxyJump and ControlMaster suit MFA bastions | ❌ Room down. Fast reconnect on wake | ◐ PIN read from a TTY, so join can't happen from the phone |
| 02 CF relay | ✅ 2 for the joiner. The host needs a Cloudflare account and `wrangler login` (about 5) | ◐ `*.workers.dev` blocked means a custom domain or SSH. A personal CF account may break policy | ❌ Room down | ✅ URL+PIN typeable (subscription only) |
| 03 wormhole | ✅ 2 each, via transit relay :4001 | ❌ A blocked public mailbox kills rendezvous. Port 4001 is blocked. TURN-TLS breaks under TLS inspection. Falls back to SSH | ❌ Room down | ✅ The short code is ideal on a phone |
| 04 tailnet/Funnel | ✅ 1 for the joiner. The host installs Tailscale and flips the Funnel and HTTPS admin toggles (about 4) | ◐ Tailscale is often banned on dev boxes. `*.ts.net` reach is unclear. Falls back to SSH | ❌ Room down | ✅ URL+PIN |
| 05 hyperdht | ◐ 3 plus a 31 MB native download. Symmetric NAT or CGNAT pairs fail with no relay | ❌ UDP blocked. SSH hop | ❌ Room down | ◐ A 52-char key is miserable to type on a phone |
| 06 S3/fs mailbox | ❌ Someone must create a bucket and a token | ✅ About 4 (store once, then invite, PIN card, admit card). HTTPS to S3 passes proxies, and it fits an AWS/Bedrock shop | ◐ Reads continue and writes stop. CAS chat is phase 4 | ✅ Native cards work on the phone |
| 07 Nostr/ntfy | ✅ 2 | ❌ Relays are likely categorised and blocked, and ntfy is uncertain. SSH | ❌ Room down | ✅ |
| 08 tunnels | ◐ 3. Install cloudflared, and the URL rotates on restart (beacon) | ❌ trycloudflare is a known malware vector and the host needs egress on 7844. devtunnel/ngrok need accounts | ❌ Room down | ◐ Long, rotating URL |
| 09 core hardening (SSH) | ◐ Same as 01, plus the two-paste `authorize` | ✅ About 4 (two pastes) | ◐ Planned `handoff`, manual `promote` after 10 min, posts queued in an outbox | ✅ PIN card, auto-rejoin, link state in the room row |
| 10 team relay | ❌ No relay without an admin (homelab users excepted) | ✅ 2, once the team runs the relay. Internal host, outbound 443 | ✅ Sealed-replica reads and an epoch-fenced take-over | ✅ |

Host sleep is fatal in 7 of 10 plans, and "host on the dev box" is the only mitigation most of them offer. Every plan that needs public infrastructure falls back to SSH for persona (b), so SSH is load-bearing in all ten.

## 2. Fact-check

| Claim | Verdict | Source |
|---|---|---|
| tmate's public servers shut down in July 2025 (plans 01, 10) | **Confirmed.** The README says "no longer works out of the box" | https://github.com/tmate-io/tmate |
| n0's iroh relays are for development only (03, 05) | **Confirmed.** "suitable for development and testing", rate-limited, no uptime guarantees | https://docs.iroh.computer/concepts/relays |
| The public wormhole mailbox is OK for a third-party persistent app (03) | **Unclear.** The docs say it is "freely available until volume or abuse makes it infeasible". They say nothing about outside appids or hourly reconnect mailboxes, so we would need upstream's blessing | https://magic-wormhole.readthedocs.io/en/latest/welcome.html |
| Corporate filters block trycloudflare (08) | **Unclear.** Heavy malware abuse is confirmed (AsyncRAT, Remcos and others). I found no source showing default blocking by Zscaler or Netskope. Plan to assume it is blocked | https://www.bleepingcomputer.com/news/security/hackers-abuse-free-trycloudflare-to-deliver-remote-access-malware/ |
| strfry ephemeral limits (07) | **Confirmed.** Events older than 60 s are rejected, ephemeral events live 300 s, events max out at 64 KiB, websocket payloads at 128 KiB, and pings go every 55 s | https://github.com/hoytech/strfry/blob/master/strfry.conf |
| Durable Objects on Workers Free: 100k req/day, 13k GB-s, 20:1 WebSocket billing (02) | **Confirmed.** SQLite-backed objects only | https://developers.cloudflare.com/durable-objects/platform/pricing/ |
| Funnel is on all plans, TLS ends on the device, and relays can't decrypt (04) | **Confirmed.** It needs MagicDNS, HTTPS certs and a `funnel` nodeAttr. Ports are 443, 8443 and 10000, and bandwidth limits are unpublished | https://tailscale.com/kb/1223/funnel |
| "Phone: nothing changes" (all plans) | **Refuted for Bedrock** (see top) | https://code.claude.com/docs/en/remote-control |

## 3. Scores (1–5)

| Rank | Plan | Join | Reliability | Phone |
|---|---|---|---|---|
| 1 | 09 core hardening | 2 | 5 | 4 |
| 2 | 01 SSH-first | 3 | 4 | 2 |
| 3 | 04 tailnet/Funnel | 4 | 3 | 4 |
| 4 | 10 team relay | 3 | 4 | 4 |
| 5 | 02 CF relay | 4 | 3 | 4 |
| 6 | 06 S3 mailbox | 2 | 4 | 4 |
| 7 | 03 wormhole | 5 | 2 | 4 |
| 8 | 07 Nostr | 4 | 2 | 4 |
| 9 | 08 tunnels | 3 | 2 | 3 |
| 10 | 05 hyperdht | 3 | 2 | 2 |

## 4. Recommendation

**Primary transport: SSH, delivered as plan 01's `host --ssh`.** It is the only path that works for the user's real work case (b) without anyone's permission. It costs $0 and has no third party. Every other plan falls back to it anyway. Take from plan 01:
the sealed `sh2` invite with pinned host key and `key.rotate` (replaces 09's two pastes), `--via` ProxyJump, `link --prime` ControlMaster, and the stable `<home>/bin/serve` shim.

**Fallback for home friends: plan 04's `wss:` listener behind Tailscale Funnel.**
Joiners install nothing (URL + PIN); the host's Tailscale is the same install 01 already recommends; no hand-rolled PAKE, since TLS ends on the host. Keep `wss:` generic so 02's or 10's relay can slot in later. Reject 03, 07 and 08 as defaults: each hands reliability to a third party.

**Core hardening that must ship with 1.0, all from plan 09:**
1. `hello{vmin,vmax,version,caps}`, with fix-it messages that say which side to update.
2. Wake detector, a 15 s app-level ping, reconnect-before-disconnect, and auto-rejoin when the lease has lapsed.
3. A PIN entered through an AskUserQuestion card, not the TTY. This keeps join phone-capable: single use, 5 tries, 15-minute TTL.
4. A bounded `@room` outbox. Consent is never queued.
5. `sub-human doctor`, plus `●/◐/○` link state on the room row.
6. Planned `handoff`, so a host can move the room before closing the laptop. Defer `promote`.
7. Move `bin/` to `scripts/` so org-sync distribution works.
8. Documentation that is honest about the phone: Remote Control needs a claude.ai subscription and does not work on Bedrock. Bedrock users join from their laptop or dev box and cannot drive the room from a phone.
