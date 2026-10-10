# Command review: making sub-human simpler to use (0.5.0-beta.5)

Sources: four read-only reviews on 2026-10-10:
- a newcomer walking through three setups;
- the full command grammar;
- every message users see;
- how comparable tools do it (tmate, upterm, sshx, croc, magic-wormhole, Tailscale, Live Share, Zed, Slack).

## What's wrong today

1. **Too many shapes.**
   - `join` has four forms: short invite, login, sh2 and sh1.
   - `host` means "make an invite", and a bare `host` makes a pipe invite that almost nobody wants.
   - `unhost` only stops the web.
   - `revoke` takes four kinds of identifier.
   - The usage text lists 7 forms, and the skill hint lists 8.
2. **Two steps where one would do.**
   - After a short or web join, people must type `/sub-human NAME CODE` again. The login join already takes the seat by itself.
   - The URL join repeats the room code.
3. **No feedback.**
   - A successful join prints nothing for the person, because its message goes only to the model.
   - Every reply, including good news and the invite itself, shows as "operation blocked by hook".
4. **Dead ends.**
   - Messages point at a `sub-human` CLI that isn't on PATH (`sub-human read`, `sub-human revoke`, `sub-human doctor --fix`, `sub-human prime`).
   - "check the message above" doesn't say what to do.
   - `sub-human: sub-human:` appears doubled.
5. **Jargon in what people see:** sh1/sh2/shk1, LOCATOR, link, seat, epoch, REF, shim, home, BatchMode, origin.
   - "code" means two things: the room (`vole-8126`) and the 6 digits.
6. **Traps.**
   - `/sub-human doctor` and `/sub-human help` open a room as a person named "doctor" or "help".
   - The invite line contains a literal `NAME`, so pasting it unchanged joins as "NAME".
7. **A security bug.** A `join` with a mistyped code (5 or 7 digits, or with `--home`) falls through to `block()` instead of `hidden()`, so the code can stay in the conversation (hooks/join.js:208, 295).

## Proposed commands

```
/sub-human                      in a room: who's here, the room, how to invite. Not in a room: join or open one as you
/sub-human NAME [ROOM]          as today (an explicit name)
/sub-human invite               an invite line for someone else (ssh by default; --web for Tailscale, --public for Funnel)
/sub-human join dev ROOM        you can ssh to dev: one step, your seat taken
/sub-human join dev ROOM 482913 the line from an invite: one step, the host's card lets you in, then you're seated
/sub-human join https://… 482913
/sub-human leave                leave the room (no /exit question)
/sub-human kick NAME            end someone's connection
/sub-human handoff NAME         as today
/sub-human doctor               checks, read only, inside Claude Code
/sub-human help                 the full list; usage messages show one form
@room …   @claude …             as today (drop room:)
```

- **Name defaults.** `/sub-human` and `join` with no name use your git `user.name`, else `$USER`, bound before the model runs. If that name is taken, the refusal says "pick one: /sub-human NAME". Invite lines then carry no `NAME`.
- **Renames.** `host` becomes `invite`; pipe goes behind `--pipe`. `unhost` becomes `invite --stop`. `revoke` splits into `kick NAME` and `invite --cancel`.
- **Old forms.** They are kept as hidden aliases for one minor version: `host`, `unhost`, `revoke`, `room:`, `--long`, sh1/sh2/shk1.
- **Reserved names.** Every new verb joins RESERVED.
- **Words.** "room" means `vole-8126` and "PIN" means the 6 digits, everywhere.
- **Hidden parsing.** Every `join` or `invite` prompt is parsed hidden first, then sorted into a form. This fixes the bug in item 7.

## Messages: 5 rules
1. The output type matches the outcome: a refusal is a block. Success and invites are a plain notice, shown once, never as "blocked by hook". No `sub-human:` inside text that `$.ui.log` already prefixes.
2. Say what happened and why, then give one next step that can be typed right there: a `/sub-human …` command or a plain `ssh` line. Never the bare CLI.
3. No internal words.
4. Usage shows the common form and points to `/sub-human help`.
5. No dead ends: point to `/sub-human doctor`. When the next step is mechanical, such as taking the seat, do it.

The 15 worst messages and their rewrites are in the review notes. Examples:
- `that is not an invite (sh2.CODE.LOCATOR.SECRET.KEY, or sh1)…` → `"X" isn't an invite. Paste the whole line the host sent you.`
- `a room message could not be delivered; sub-human read shows the room` → `A room message didn't arrive here. Run /sub-human doctor.`

## Must not regress
- PINs and invites never reach the model: hidden blocks, the guard, masking in `!` mode.
- Consent stays human-only: the card or the typed admit, signed with the seat key. No auto-admit.
- Seating is done by the hook in the person's own session, never by the daemon or the model.
- The host always sees whether an invite goes over ssh or public Funnel.

## Open decisions
1. **Default name from git/OS user:** yes or no?
2. **`host` → `invite`, `revoke` → `kick`, add `leave`:** yes or no?
3. **The PIN format.** Keep 6 digits, or use words (`7-crossover-clockwork`, as magic-wormhole does)? Words are easier to say aloud, but longer to type.
4. **Old forms.** Hidden aliases for one minor version, or remove them now? It's a private beta, so few people depend on them.
