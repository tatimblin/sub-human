# Join in one line: URL + PIN lets you in, no PIN asks the host

Goal: a friend joins with one pasted line. With the right PIN they are seated with no card and no follow-up command. Without the PIN, the host is asked. The host's only job in the normal case is sending the line and saying the PIN.

Sources: the live join on 2026-10-17 (room egret-3408; host transcript `f4dbf026`, joiner transcript `~/repos/subhuman-debug/03104d56`), plus three research passes run on 2026-10-18: a threat model, UX and prior art, and implementation cost. Paths below are relative to `plugin/sub-human/`.

## What happened on 2026-10-17

1. The host ran `/sub-human invite --public`. They had to ask their Claude for the flag.
2. The joiner pasted `/sub-human join https://….ts.net/sub-human/egret-3408 SECRET`.
3. The joiner was told to run `/sub-human join PIN`.
4. The host got a card and clicked Let in, and was supposed to compare check codes over another channel.
5. The joiner ran a bare `/sub-human` to take the seat.

That took about 5 minutes and 8 human actions across the two people. A second machine also raced the spent tristan2 invite, and the host's Claude had to explain check codes.

## What each check is for, and what changes

| Check | Job today | After |
|---|---|---|
| SECRET | A 128-bit bearer token that also pins the host's Noise key (`lib/remote/link-connect.ts:129-138`, `invite-secret.ts:6-15`). Stops strangers and a man-in-the-middle at the Funnel/TLS front | **Kept**, moved into the URL fragment so the joiner never handles it as a separate thing |
| PIN | A second channel. Protects against the line leaking | **Kept**, typed on the same command |
| Admit card | Human gate after a correct PIN (`lib/remote/admission.ts`) | **Only when there is no PIN** |
| Check code | Tells a racer apart, if someone compares it | Shown on the card and in the "joined" room line |
| Bare `/sub-human` | None. Exists because admission is async and seats are never taken from a prompt that holds a secret (`lib/remote/joining.ts:2-6`) | **Removed**: the seat is taken by a new, secret-free turn |

Unchanged: single use, 15 min TTL, 5 PIN tries with backoff, at most 4 open invites, Noise XK, protocol `{min:4,max:4}` for steps 1-3.

**Residual risk we accept:** if the line and the PIN leak together, a stranger is seated silently within 15 minutes. Today's card would catch that only if the check code were actually compared. The mitigation is the "joined" room line with a kick hint, and the second-machine warning, which stays.

## Target flow

```
host>   /sub-human invite
        Invite for one machine, 15 min:
          /sub-human join https://devbox.tail1a2b.ts.net/sub-human/egret-3408#Kq7…
        Say the PIN separately: 4829
        (--public for someone off your tailnet)
        ┌ Copy the invite line to your clipboard? (the PIN is not copied)
        │ ❯ Copy    Skip

joiner> /sub-human join https://devbox…/egret-3408#Kq7… 4829
        ✔ You're in room egret-3408 as cameron.

host room line: cameron joined from Mac (check 4985-f668) · not them? /sub-human kick cameron
```

Without the PIN: `joiner> /sub-human join https://…#Kq7…` shows "Asked tristan to let you in…". The host gets today's card, with the check code. On Let in the joiner is seated automatically.

A wrong PIN is refused and **never** falls back to a card, so a guesser can't turn a miss into a card the host might click through.

## Steps

Each step ships on its own, with tests, in this order.

### 1. One line: secret in the URL fragment, PIN on the same line (S)
- `lib/commands/join.ts:161` `joinWeb`: accept `URL#SECRET` (the regex rejects `#` today). Keep the old `URL SECRET` form working.
- Accept an optional trailing PIN. Remove the `PIN_APART` refusals (`join.ts:53,155,192`) for the line-plus-PIN form. Pass the PIN through `joining.linkLine` → `hosting.joinLine` (`hosting.ts:349`) so the link file starts with `pin` set. `link-connect.ts:143` already sends it in the first hello, after the host key is checked.
- Print the new line in `lib/remote/webhost.ts` (~108) and `hosting.inviteText/invitePinned` (`:146,162`).
- ssh invites: keep `HOST ROOM SECRET` for now. A `ssh://u@h/ROOM#SECRET` form is a follow-up.
- Masking: `mod/core/command.ts` (~73) and `lib/cli/doctor/redact.ts` mask a whole-word SECRET only. Teach them the `#fragment` form, and mask a trailing 4-digit PIN on a join line.
- Tests: parse both line forms, check the masking, and check that the PIN is never sent before the host key is checked.

### 2. A right PIN seats you; the host gets a notice, not a card (S/M, host only)
- `lib/remote/invites.ts:134-143` `redeemShort`: on a correct PIN, write the admission as `let-in` (`admitted_by:'pin'`) and take the `used_at`/`check` path in the same hello. That returns a link instead of `ADMIT_WAITING`.
- Name already taken: rename automatically via `admission.taken()` (the card does this today).
- `server.ts:104` room line: "NAME joined from MACHINE (check XXXX-XXXX) · not them? /sub-human kick NAME".
- `admit_sig` (`types-core.ts:257`) is signed but never verified. Either leave it unset for PIN admissions or delete it; decide in review.
- Old proto-4 joiners also get the benefit without updating.
- Tests: right PIN → linked with no card; wrong PIN → refusal and no card; second machine → `INVITE_USED` plus a warning, as today.

### 3. Take the seat automatically on admission (M, hooks module)
- Plain command hooks can't start a turn. The hooks module can, through `$.prompt.submit` (`asUser`, already used in `mod/deliver.ts:269`).
- `lib/tail.ts:731 news()` already sees `pendingNews` turn `'linked'` (`joining.ts:246`). Emit a tail event `{type:'take'}`.
- `mod/deliver.ts`: on `take`, run the shim `join` with empty args and the session's nonce (the same path as `command.run`, `:437-477`). Then `submitWake` a shown line, "You're in room X as NAME", with the reply's mechanics block in `wakeContexts`. The prompt holds no secret, which keeps the invariant in `joining.ts:2-6`.
- Mid-turn: append the wake, as other wakes do. Session closed: the bare `/sub-human` fallback still works, and the "linked" text (`hosting.ts:324`) says so only on that path.
- Covers both step 2 (right PIN) and step 4 (card).

### 4. No PIN knocks (M, additive hello param)
- `invites.ts:117`: when the hello carries `knock:true` and no PIN, create the `'asked'` admission instead of answering `PIN_NEEDED`. That reuses the card, the lapse and `/sub-human admit`.
- It has to be an explicit `knock`, because an old joiner's first hello never carries a PIN and must still get `PIN_NEEDED`. An old host ignores `knock`, so the new joiner falls back to asking for the PIN. No version bump.
- Knocks don't use up PIN tries. Throttle per machine (reuse `sources`). One open knock per invite.
- Joiner copy: "Asked tristan to let you in. If they gave you a PIN: /sub-human join PIN."

### 5. Click to copy the line (M)
Never overwrite the clipboard without asking: it may be holding something the person needs. The invite answer is a `secret` that the model never sees (`lib/commands/invite.ts`), so the card follows the admit card's pattern. Claude only ever handles an opaque reference; the hooks build the card and do the copy.
- After `invite` answers, the module submits a wake (`$.prompt.submit`, the same way `lib/tail.ts:611` raises the admit card): "call AskUserQuestion with the question `copy invite REF`". REF is the invite's ref, not the secret.
- `hooks/consent.ts preAsk`: fill the card. The question is "Copy the invite line to your clipboard? (the PIN is not copied)", with options **Copy** and **Skip**.
- `postAsk` → a new `postCopy`, next to `postAdmit`. On Copy, look up the open invite by ref and write **the line only, never the PIN**, using `pbcopy` (macOS), `wl-copy`/`xclip -selection clipboard` (Linux) or `clip.exe` (WSL). Best-effort, short timeout, no dependencies.
  - Report back "Copied. Say the PIN separately."
  - When no clipboard tool is found, report "No clipboard tool found; the line is pinned on your status line."
- Skip, AFK or an edited card copies nothing.
- If the invite was used or expired before the card is answered, refuse with "that invite is gone, run /sub-human invite again".
- No card when the session isn't interactive (`-p`, the room session) or with `/sub-human invite --no-card`. The line stays pinned on the status line either way.
- Cost: one small model turn per invite. Add the card's question pattern to the consent tests next to the admit card.

### 6. Discoverable invite modes (S)
- `invite.ts:27-35`: with no flag, use the tailnet (`hostWeb({funnel:false})`) when `ts().bin()` and `ts().self()` succeed; otherwise use ssh as today.
- Never turn on Funnel without being asked: the hostname goes into public certificate transparency logs (`CT_WARNING`). The invite output names `--public` instead ("off your tailnet? /sub-human invite --public").
- Joiner timeout hint: when `WS_CONNECT_MS` expires on a ts.net URL, say "the host may need `/sub-human invite --public`".

### 7. Copy and docs
- README lines 46-65: the new two-line flow first, the old forms later on.
- `skills/sub-human/SKILL.md:4` argument-hint: `join URL[#SECRET] [PIN]`.
- The admit wake text (`lib/tail.ts:611`): it now appears only for knocks.
- `CLAUDE.md`: the join description in the intro paragraph and in the Demo section.
- Demo:
  - `scripts/demo.sh` S2 and S11 type the line, the separate PIN, the card's Let in and the bare `/sub-human` (`demo-lib join-pin`, `admit-card`). Switch them to line + PIN.
  - Keep one scene on the knock path so the card stays covered.
- `docs/ARCHITECTURE.md`: run `npm run docs` after the header changes.
- Bump `version` in plugin.json and add a CHANGELOG entry.

## Verify

- Unit tests per step, as above.
- Live, two machines, following the release plan's live-verify recipe:
  - a `--public` invite with line + PIN → the joiner is seated with no further typing, and the host sees the joined line;
  - the line only → card → Let in → seated automatically;
  - a wrong PIN ×5 → the invite burns, and no card ever appears;
  - a second machine reuses the line → `INVITE_USED` plus a warning.
- Lab: `npm run test:remote-docker` (the security and skew scenarios). A proto-4 joiner from the previous release, whose line and PIN arrive separately, must still work.
- Success measure: from invite to seat is 1 host command + 1 joiner command, against 5 steps on 2026-10-17.

## Out of scope (later)

- **Tailnet identity auto-admit.** On `--web`, trust `Tailscale-User-Login` for the host's own login or an allowlist (proposal 2). This is the natural next step.
- **Multi-use group invites** (`--for N`). Only safe as knock-only, and it needs its own security review.
- **A single spoken code** (Wormhole-style, using a PAKE).
