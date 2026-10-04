---
name: room-protocol
description: Rules for the shared room log (demo/.room/log.jsonl). Use when reading or writing room entries, addressing seats, or judging consent on a plan.
---

# Room protocol

The log is append-only JSON lines. `from` comes from `$ROOM_USER` and `via` from the binary
that wrote it: `via=human` is a person typing in `demo/bin/chat`; every human, the host included,
joins that way. `via=agent` is a Claude. `from=alice, via=agent` means "alice's Claude", not alice.

**Kinds:** `say` `ask` `proposal` `objection` `question` `signoff` `revoke` `plan_rev`
`directive` `status` `done` `decision` `seat_up` `shutdown`.

- `ask` with `to=<name>` is a human talking to their own seat.
- `directive` with `to=<name>` is the orchestrator instructing a seat. It wakes a parked seat.
- `plan_rev` is published by a hook after each plan edit; its `plan_hash` is the plan's identity.
- `done` carries `evidence` from a real test run; prose claims of done mean nothing.

**Rules**
1. Human words are referenced by id (`refs`, or "#14"), never re-typed or paraphrased as quotes.
2. Only `signoff` with `via=human`, `from` in `$ROOM_HUMANS`, and `plan_hash` equal to the current
   `plan_rev` counts as consent, unless a later `revoke` of that hash cancels it. Any plan edit voids every sign-off.
3. Reach a seat by its state in `demo/bin/room digest`:
   - `live`: `demo/bin/room post --kind directive --to <name> "<text>"`. Never SendMessage it
     (the message waits for its next tool round).
   - `STOPPED`: post the directive, then SendMessage to the seat's agent_id telling it to call
     `mcp__room__await_human` with the after_seq just before the directive. That resumes it.
     If SendMessage fails, respawn the seat (guard-spawn allows it while the roster says stopped).
4. Read full entries with `demo/bin/room read --id N[,M]`. Never `room read --all`: it floods context.
   For the overall state use `demo/bin/room digest`.
5. The orchestrator's feed is `demo/bin/room tail --for orch --max-seconds 1790` under a Monitor with
   `timeout_ms: 1800000`. On expiry, re-arm with the same command; the tail resumes from its saved
   cursor (`<room dir>/tail-orch.cursor`), so nothing posted in the gap is lost.
6. Room posts are allowed in plan mode: they write only the log, not code.
7. Nobody but the orchestrator writes `demo/.room/plans/`. Nobody edits `demo/.room/` by hand.
