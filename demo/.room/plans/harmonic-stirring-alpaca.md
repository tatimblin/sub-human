# Plan: GET /tasks, paginated, newest first

## Context
alice asked for `GET /tasks` to be paginated, newest first (#4). alice's Claude proposed a cursor design (#7), and alice endorsed it (#12). bob accepted the cursor approach and a default of 20 / max of 100, but needs a total for "Page 3 of 8" (#9). He confirmed the UI only does next/prev, with no jumping, and that an approximate total is fine (#11). alice is OK with an approximate total (#12).

The endpoint is currently a 501 stub at `demo/app/src/server.js:28-31`. `demo/app/src/store.js` is in-memory and stands in for a ~4M-row Postgres table that takes ~30 inserts/s. `seed()` gives some tasks identical `createdAt` values.

## API
`GET /tasks?limit=<n>&cursor=<opaque>` returns 200 with:
```json
{ "tasks": [ ... ], "nextCursor": "string|null", "approxTotal": 237 }
```
- **Order:** `createdAt` desc, then `id` desc as the tiebreaker (#7).
- **limit:** defaults to 20, maximum 100 (#9). A non-integer value or one < 1 returns 400. A value > 100 is clamped to 100.
- **cursor:** base64url JSON `{createdAt, id}` of the last task returned. The next page contains the tasks strictly after that `(createdAt, id)` in sort order. A malformed cursor returns 400 (#7).
- **nextCursor:** `null` when there are no more rows.
- **approxTotal:** an estimated row count, so the UI can show "Page X of ~Y" (#9, #11). In-memory it equals `tasks.length`. In Postgres it would come from `pg_class.reltuples`, not `COUNT(*)`. The UI derives page numbers itself as it moves next and prev.

## Changes
1. `demo/app/src/store.js`: add `listTasks({ limit, after })`. It sorts a copy of `allTasks()` by (createdAt desc, id desc), filters to the rows after the cursor, and slices `limit + 1` rows to detect whether a next page exists. Add `approxCount()`. Keep `allTasks()` unchanged.
2. `demo/app/src/server.js`: replace the TODO. Parse and validate `limit`, decode and validate `cursor` with a small `encodeCursor`/`decodeCursor` helper, call `listTasks`, then build `nextCursor` and `approxTotal`.
3. `demo/app/test/tasks.test.js` (new): use the `node --test` style of `health.test.js`.

## Verification (`cd demo/app && npm test`)
- With `seed()` (237 rows), the first page has 20 tasks ordered newest first, and ties are ordered by id desc.
- Following `nextCursor` to the end visits all 237 ids exactly once, and the last page has `nextCursor: null`.
- A task inserted mid-walk does not cause any duplicates or skips in the rest of the walk.
- `limit=500` returns 100 rows. `limit=0` and `limit=abc` return 400. A garbage cursor returns 400.
- `approxTotal` is 237.
- The existing health test still passes.

## Open for sign-off
- Field name `approxTotal` (vs `total`). Flag it if you prefer the other name.
