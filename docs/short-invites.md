# Short invites: a 6-digit code over CPace, and the host's card

Shipped in 0.5.0-beta.4. User-facing text: `plugin/sub-human/README.md` (Inviting, Joining, Threat model).

```
host:    /sub-human host --ssh [you@machine-a] [--via J]   ->  /sub-human join NAME you@machine-a vole-8126 482913
         /sub-human host --tailscale [--funnel] | --url …  ->  /sub-human join NAME https://box.ts.net/sub-human/vole-8126 482913
joiner:  types that line with their name
host:    a card: "Let carol (SHA256:ab12…) on carols-mbp join room vole-8126? (admit REF)"  Let in / Refuse
```

## Design

| Piece | Where | What |
|---|---|---|
| PAKE | `lib/remote/cpace.js` | CPace, draft-irtf-cfrg-cpace-21, CPACE-RISTR255-SHA512, initiator-responder, key confirmation per §10.4 (HMAC-SHA512 over lv_cat(Y, AD)). Group ops from vendored `@noble/curves` 2.4.0 (`lib/vendor/noble`, reproduced by `scripts/vendor-noble.js`, pinned in `MANIFEST.json`). Vectors A.1, A.3, B.3 in `test/remote-cpace.test.js`. |
| Protocol | `lib/remote/enroll.js` | `enroll.start {sid, ya, ada}` → `{offers: [{yb, adb, tb}]}` → `enroll.finish {i, ta}` → `{box}` (ChaCha20-Poly1305 under HKDF(ISK)). CI = lv_cat("sub-human enroll v1", "joiner", "host", ROOM, KIND). ADa: the joiner's name, machine, label, ssh link key. ADb: the key the host vouches for. |
| Tries | `lib/remote/auth.js` startShort / failShort / enrollShort | 5 tries, 15 min, burn. A try is charged when the host answers `enroll.start`, before it learns anything, so an abandoned attempt costs one. One offer per open short invite of that transport (≤ 4); success refunds the others. |
| Host identity | `enroll.js` checkKey | ssh: the joiner's ssh records the key it was shown (`accept-new` into an empty file, Ed25519 only); it must equal the vouched key before `enroll.finish` goes out. web: the vouched listener key is pinned; later connections are Noise_NK to it. |
| SSH door | `shim.enrollLine`, `enroll.openDoor` / `sweepDoors` | `command="… serve --enroll CODE --kind ssh",restrict <enrollment key> sub-human-enroll:CODE`. The enrollment key is public (sha256("sub-human enroll key v1\0" + CODE) as an Ed25519 seed), never derived from the 6-digit code. Removed when no ssh code is live. |
| Web door | `listener.js` enrollConn | A WebSocket whose first message is text spawns `serve --enroll CODE --kind ws`; one frame per text message. |
| Admission | `lib/remote/admission.js`, `hooks/consent.js`, `lib/tail.js` | The admission record waits for the host person. The host's tail wakes the seat's Claude once ("admit REF"); only the hooks' card answer counts, signed with the seat key. `sub-human admit [REF]` for headless hosts. Let in writes the usual one-link forced-command line (ssh). |

## Why the SSH door is safe without a long secret

Anyone who reaches sshd and knows the room code can authenticate with the enrollment key, but its line forces `serve --enroll`, which runs the PAKE and nothing else (`restrict`: no pty, forwarding or shell). Each attempt costs a try, so the worst case is burning the invite (denial of service for 15 minutes) and a 5-in-a-million guess. The key reveals nothing about the code: it is a function of the room code only, so probing sshd with keys tests no guess. A long secret is not needed.

## Limits (candid)

- 20 bits of code: an online attacker gets 5 guesses per invite (≤ 20 in a million with 4 open). Fine for a 15-minute invite, not a long-lived credential.
- Anyone on the network who can reach the door (or the Funnel URL) can burn an open invite.
- The host's store holds the code in clear while the invite is open (CPace needs it); a model on the host can `Read` the store, as it can read seat keys (already out of scope in the threat model). The code still admits nothing without the card.
- An sshd that demands more than a public key (`AuthenticationMethods publickey,keyboard-interactive`) defeats the door; use `--long`.
- Names and machine labels on the card are what the joiner claims; the fingerprint is what to compare.
- Prompt history keeps the typed line, as it kept a PIN.
