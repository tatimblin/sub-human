# Room protocol (v2)

The room is an append-only log, `demo/.room/log.jsonl` (override with `ROOM_DIR`). Every write goes through `demo/lib/room.js`. Every human, the host included, types into `demo/bin/chat`; nobody types into the orchestrator, which runs unattended. The orchestrator and hooks use `demo/bin/room`, and seats use `room-mcp`. Identity comes from the channel: `from` is always `$ROOM_USER`, set by the launcher, and `via` is set by the binary. Nobody types their own name.

## Envelope (one JSON line)

| Field | Notes |
| --- | --- |
| `id`, `at` | Assigned by the writer under a lockfile. Ids are monotonic. |
| `from` | `$ROOM_USER`. Never an argument. |
| `via` | `human` (`chat` only) or `agent` (`room`, `room-mcp`, hooks). `from=alice, via=agent` reads as "alice's Claude". |
| `agent_id` | Optional. Set only on a seat's `via=agent` posts. |
| `kind` | `say` `ask` `proposal` `objection` `question` `signoff` `revoke` `plan_rev` `directive` `status` `done` `decision` `seat_up` `shutdown` |
| `to` | `room` (default), `all`, or a seat/human name. |
| `refs` | Ids this entry acts on. Cite human words by id; never re-type them. |
| `plan_hash` | 12-hex sha256 of the plan file bytes. |
| `text` | Byte-exact. Must not be empty after trimming. |
| `evidence` | `{pass, total, failed}`. Only on `done`, attached by the test run. |
| `prev` | 12-hex sha256 of the previous line, which forms a tamper-evident chain. |

Rules:
- `signoff` and `revoke` need `via=human` and a `plan_hash`.
- `plan_rev` is written only by the plan hook.
- `done` is written only after a green `npm test`.
- A sign-off counts only if it has `kind=signoff`, `via=human`, `from` in `$ROOM_HUMANS`, and a hash equal to the latest `plan_rev`, with no later `revoke` of that hash. Editing the plan voids every sign-off.

Legacy entries (`agree`, `concern`, no `via`) still read. They display as `agree` and `objection`, and they never count as consent.

## `demo/bin/room` (writes `via=agent`)

| Command | What it does |
| --- | --- |
| `room post --kind K [--to X] [--refs 1,2] [--plan-hash H] [text]` | Post an entry. With no text argument, the text is read from stdin (only the final newline is dropped). `--kind done` is rejected. |
| `room done [note]` | Run `npm test`. Post `done` with evidence only if the tests pass; exit 1 otherwise. |
| `room read --id N[,M] [--json]` | Print those entries in full. |
| `room read [--all]` | Print unread entries (per-user cursor) or the whole log. |
| `room wait [--timeout S]` | Block until someone else posts. |
| `room tail --for NAME [--after N] [--max-seconds S]` | Print one notice per new entry, at most 240 chars each. Skips NAME's own entries and asks addressed to seats. This is what the Monitor runs. It resumes after the saved cursor `<room dir>/tail-NAME.cursor` (else from the end of the log) and advances it only once a notice is flushed, so a re-armed tail loses nothing posted between two watches. `--after N` overrides the start. `--max-seconds S` exits cleanly after S seconds. |
| `room digest` | Print the compaction digest, at most 9,500 chars: the humans, each seat's agent id and state (`live`, or `STOPPED` with the reason), plan with the sign-off matrix, open objections and questions, decisions, the last 10 human entries. |
| `room watch` | Colored live feed. Shows `alice` versus `alice's Claude`. |

Exit code 2 means a usage or validation error, or a missing `$ROOM_USER`.

## `demo/bin/chat` (writes `via=human`)

- Plain text is posted as `say` to the room.
- `/ask <text>` asks your own seat (`to=<you>`).
- `/proposal`, `/question` and `/object <text>`. `/object` is bound to the current plan hash.
- `/plan` shows the current plan. `/signoff [note]` signs the current plan, and `/revoke [note]` withdraws your sign-off. The client fills in the hash, and `/signoff` refuses when there is no plan.
- `/paste [ask|proposal|question|object]` starts a multi-line block. A line containing only `/end` posts it, and `/cancel` drops it.
- `/test` runs the tests. `/done [text]` posts `done` with test evidence. `/status` shows the sign-off matrix, open items and decisions. `/help` lists the commands.

## Orchestrator feed and seat state

- The orchestrator arms `Monitor({command: "demo/bin/room tail --for orch --max-seconds 1790", timeout_ms: 1800000})`. A Monitor lasts at most 30 minutes and has no persistent option. On expiry it re-arms with the same command, and the saved cursor makes the hand-off lossless.
- A `live` seat is parked in `await_human`, and a `directive` wakes it. A `STOPPED` seat has no `await_human` running: the orchestrator posts the directive, then sends `SendMessage` to the seat's agent id, which resumes it from its transcript. If that fails, it respawns the seat.
- `demo/bin/room post` works in plan mode: the allowlist passes it, and it writes only the log. MCP tools are refused in plan mode ("Cannot call … while in plan mode"), so the orchestrator posts with the CLI, not with an MCP tool.
