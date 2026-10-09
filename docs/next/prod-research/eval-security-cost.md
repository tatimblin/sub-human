# Evaluation: security, privacy, cost, third-party risk

## Fact checks
- **Node floor:** root `package.json` sets `engines.node >=20`. Node 20 went end-of-life on 2026-04-30. Raise the floor to 22, which is supported until 2027-04 and has a stable global `WebSocket` from 22.4.
- **node:crypto:** X25519, Ed25519, `hkdfSync` and `chacha20-poly1305` all work (checked locally). It has **no** XChaCha20, Elligator2, ristretto255 or Schnorr, so Plan 07's "XChaCha20 via node:crypto" is wrong.
- **Audited JS PAKE:** none exists for CPace or SPAKE2.
  - @noble/curves has no PAKE, but it does have audited ristretto255 hash-to-curve (Cure53 2024, Trail of Bits 2026). Its only dependency is @noble/hashes.
  - The only audited JS option is OPAQUE through `@serenity-kit/opaque`, a WASM build of the NCC-audited opaque-ke. It is a poor fit for a symmetric PIN.
- **Cloudflare Terms of Use** forbid using the Services "to provide a virtual private network or other similar proxy services". A relay the host deploys for their own room is a grey area; a community relay the developer promotes is not.
- **trycloudflare:** "for testing and development. For production, create a Cloudflare Tunnel." No uptime guarantee, 200 in-flight requests, and the domain is widely blocked for malware abuse.
- **magic-wormhole public servers:** free "until volume or abuse makes it infeasible". Apps that need reliability are told to run their own.

## Universal point
In every plan, the developer could read messages only by shipping a malicious update that auto-update pulls in. Mitigate with tagged releases and no telemetry, and say so in THREAT-MODEL.md.

## Per plan

| Plan | What third parties see | Attack surface | Crypto risk | Supply chain | Ops and ToS |
|---|---|---|---|---|---|
| **01 SSH** | Nobody in the path | PIN seals an SSH key, so a leaked invite allows offline guessing: 10^6 × scrypt finishes in under 24 h on parallel hardware. Pinned host key stops MITM. | None new | OpenSSH only | $0, clean |
| **02 CF relay** | Cloudflare: IPs, room id, sizes, timing | CPace allows one online guess. Noise KK with pinned keys stops MITM. | **High as written** (hand-written Elligator2 and Noise) | none | Each host needs a Cloudflare account. Proxy clause is a grey area. |
| **03 Wormhole P2P** | Mailbox, transit relay, Metered TURN, croc VPS: IPs, timing | 16-bit code, online-only guesses | SPAKE2 on vendored noble (good), hand-written Noise and TURN | Low | Poor etiquette: hourly reconnect mailboxes on volunteer servers. Four upstreams to police. |
| **04 Tailnet** | Tailscale: node metadata. Funnel ends TLS on the host. Hostnames appear in **public CT logs**. | PIN checked online behind TLS. Public, hand-written WebSocket pre-auth surface. | None | User's own Tailscale | $0. Employers may ban Tailscale. |
| **05 hyperdht** | Bootstrap nodes **and random DHT peers**: IPs, lookups | Pinned key, Noise from libsodium | Low | **Worst**: about 56 packages plus native addons fetched at run time, long-term trust in Holepunch | Bootstrap nodes are meant for public use: OK |
| **06 Mailbox** | Bucket or cloud: ciphertext, padded sizes, timing | 4-digit PIN seals a cloud credential (trivial offline). Admit card is the real gate. A leaked credential allows deletion (DoS). | Moderate (hand-built key wrap) | none | $0 to the developer, users pay pennies |
| **07 Nostr/ntfy** | Volunteer relays: both IPs, timing. Corporate proxies label it "crypto" traffic, which will weird people out. | AEAD key derived from the invite. Needs a fresh DH after redemption. | Schnorr is low stakes (throwaway keys). XChaCha claim is wrong. | none | Weekly health job on the relay list. NIP-46 is precedent. Keep ntfy as fallback only. |
| **08 Tunnels** | Tunnel provider: ciphertext, IPs | Host keeps the PIN in recoverable form | **Highest** (BigInt CPace with PIN-dependent timing, custom resume handshake and WebSocket code) | cloudflared binary | trycloudflare is "not for production" and widely flagged. Adds an ntfy beacon. |
| **09 Hardening** | Nobody | PIN-split invite checked online. Outbox never queues consent. Handoff moves token hashes only. | None | none | $0, about 1 h per release |
| **10 Team relay** | Operator: IPs, OIDC subjects, timing, plus a **long-lived sealed replica** | PSK = HKDF(urlSecret‖PIN), so anyone with the URL can grind the PIN offline | Hand-written WebSocket server and Noise exposed to the internet | Developer must maintain a server image | Someone pays about $2/mo or runs a VM |

In all ten plans the developer cannot read messages, even in principle, apart from the universal malicious-update caveat.

## Scores (5 = best)

| Plan | Privacy | $0/ops | Security | Rank |
|---|---|---|---|---|
| 09 | 5 | 5 | 5 | **1** |
| 01 | 5 | 5 | 4 | **2** |
| 04 | 4 | 5 | 4 | **3** |
| 02 (with noble) | 4 | 4 | 3 (2 as written) | 4 |
| 06 | 5 | 4 | 3 | 5 |
| 10 | 4 | 3 | 3 | 6 |
| 05 | 3 | 4 | 3 | 7 |
| 07 | 3 | 3 | 3 | 8 |
| 03 | 3 | 2 | 2 | 9 |
| 08 | 4 | 3 | 1 | 10 |

## Recommendation
For 1.0, ship **Plan 09 plus Plan 01's SSH automation**, and use **tailnet-only** Tailscale Serve or node sharing from Plan 04 for reachability. Make Funnel opt-in and document the CT-log leak. Plan 02's self-deployed relay can come in 1.1 if people ask for it.

Never default to volunteer infrastructure (Nostr, the wormhole mailbox, ntfy, Holepunch) or to trycloudflare.

Minimum security design:
- **Pairing:**
  - The invite carries a secret of at least 128 bits plus the **pinned host-key fingerprint**.
  - The PIN is an *online-only* second factor checked by the host: 5 tries, burn on failure, 15-minute TTL.
  - Never seal a credential under a PIN. Keys are minted on the joiner's machine.
  - Admission ends at a native consent card.
- **Session:**
  - 1.0: OpenSSH with forced command, `restrict` and per-link `known_hosts`.
  - Any later relay: Noise KK/IK over `node:crypto` (X25519, ChaCha20-Poly1305 with counter nonces, HKDF-SHA256), with pinned static keys and per-session ephemeral keys.
- **Library:**
  - 1.0: `node:crypto` only, with the floor raised to Node 22.
  - Any short-code PAKE: CPace-ristretto255 on vendored, sha256-pinned `@noble/curves` and `@noble/hashes`, checked against the draft test vectors.
  - Never hand-write field arithmetic.

Sources: [Cloudflare ToU](https://conductatlas.com/platform/cloudflare/cloudflare-terms-of-use/provision/CA-P-069161/prohibition-on-vpn-or-proxy-service-use/), [Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/), [noble-curves](https://github.com/paulmillr/noble-curves), [opaque-ke](https://github.com/facebook/opaque-ke), [magic-wormhole](https://magic-wormhole.readthedocs.io/en/latest/welcome.html), [Node EOL](https://isitpatched.com/eol/nodejs).
