# Invites: a 4-digit PIN over CPace, and the host's card

Shipped in 0.5.0-beta.4 (a 6-digit code); since 0.5.0-beta.6 the only invite, with a 4-digit PIN and no name in the line. User-facing text: `plugin/sub-human/README.md` (Inviting, Joining, Threat model).

```
host:    /sub-human invite [--ssh you@machine-a] [--via J]   ->  /sub-human join you@machine-a vole-8126 4829
         /sub-human invite --web | --public | --url …       ->  /sub-human join https://box.ts.net/sub-human/vole-8126 4829
joiner:  types that line (the name: git's user.name, else --as NAME); a hidden step, the PIN never reaches a model
host:    a card: "Let carol (SHA256:ab12…) on carols-mbp join room vole-8126? (admit REF)"  Let in / Refuse
joiner:  /sub-human  (no PIN in it) takes the seat once the link is let in
```

## Design

| Piece | Where | What |
|---|---|---|
| PAKE | `lib/remote/cpace.ts` | CPace, draft-irtf-cfrg-cpace-21, CPACE-RISTR255-SHA512, initiator-responder, key confirmation per §10.4 (HMAC-SHA512 over lv_cat(Y, AD)). Group ops from vendored `@noble/curves` 2.4.0 (`lib/vendor/noble`, reproduced by `scripts/vendor-noble.js`, pinned in `MANIFEST.json`). Vectors A.1, A.3, B.3 in `test/remote-cpace.node-test.ts`. |
| Protocol | `lib/remote/enroll.ts` | `enroll.start {sid, ya, ada}` → `{offers: [{yb, adb, tb}]}` → `enroll.finish {i, ta}` → `{box}` (ChaCha20-Poly1305 under HKDF(ISK)). CI = lv_cat("sub-human enroll v1", "joiner", "host", ROOM, KIND). ADa: the joiner's name, machine, label, ssh link key. ADb: the key the host vouches for. |
| Tries | `lib/remote/auth.ts` mintShort / startShort / failShort / enrollShort | A 4-digit PIN (`SHORT_PIN_RE`), unique among the room's open invites. 5 tries, 15 min, burn. A try is charged when the host answers `enroll.start`, before it learns anything, so an abandoned attempt costs one. One offer per open invite of that transport (≤ 4, `SHORT_LIVE_MAX`); success refunds the others. |
| Host identity | `enroll.ts` checkKey | ssh: the joiner's ssh records the key it was shown (`accept-new` into an empty file, Ed25519 only); it must equal the vouched key before `enroll.finish` goes out. web: the vouched listener key is pinned; later connections are Noise_NK to it. |
| SSH door | `shim.enrollLine`, `enroll.openDoor` / `sweepDoors` | `command="… serve --enroll CODE --kind ssh",restrict <enrollment key> sub-human-enroll:CODE`. The enrollment key is public (sha256("sub-human enroll key v1\0" + CODE) as an Ed25519 seed), never derived from the PIN. Removed when no ssh invite is live. |
| Web door | `listener.ts` enrollConn | A WebSocket whose first message is text spawns `serve --enroll CODE --kind ws`; one frame per text message. |
| Admission | `lib/remote/admission.ts`, `hooks/consent.ts`, `lib/tail.ts` | The admission record waits for the host person. The host's tail wakes the seat's Claude once ("admit REF"); only the hooks' card answer counts, signed with the seat key. `/sub-human admit [REF]`, and `sub-human admit [REF]` for headless hosts. Let in writes the usual one-link forced-command line (ssh). |
| Hidden parsing | `hooks/join.ts` | Every `join`, `invite` and `admit` prompt, and any with a word of digits, is answered with `hidden()` (a block with suppressOriginalPrompt) before its form is sorted out. A PIN join links only; the joiner's link file keeps `join_as`, and a bare `/sub-human` takes that seat once the link holds a token. |

## Why the SSH door is safe without a long secret

Anyone who reaches sshd and knows the room can authenticate with the enrollment key, but its line forces `serve --enroll`, which runs the PAKE and nothing else (`restrict`: no pty, forwarding or shell). Each attempt costs a try, so the worst case is burning the invite (denial of service for 15 minutes) and a 5-in-10,000 guess, which still only opens a card the host person must answer. The key reveals nothing about the PIN: it is a function of the room only, so probing sshd with keys tests no guess. A long secret is not needed.

## Limits (candid)

- 4 digits: an online attacker gets 5 guesses per invite (5 in 10,000; up to 20 in 10,000 with 4 open). A right guess gets a card, not the room: the host person still has to let that machine in, and the card shows the joiner's key fingerprint to compare. Fine for a 15-minute invite, not a long-lived credential.
- Anyone on the network who can reach the door (or the Funnel URL) can burn an open invite.
- The host's store holds the PIN in clear while the invite is open (CPace needs it); a model on the host can `Read` the store, as it can read seat keys (already out of scope in the threat model). The PIN still admits nothing without the card.
- An sshd that demands more than a public key (`AuthenticationMethods publickey,keyboard-interactive`) defeats the door; the joiner joins over their own ssh login, or the host uses `--web`.
- Names and machine labels on the card are what the joiner claims; the fingerprint is what to compare.
- Prompt history keeps the typed line.
