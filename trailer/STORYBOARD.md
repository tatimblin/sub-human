# Trailer storyboard (v2, ~68 s)

From the demo research of 2026-10-11:
- Lead with the result, not a logo.
- State the problem.
- Make Claude asking Claude the moment that lands.
- Show consent as one beat.
- Keep both people on screen.
- End with one call to action.

The people are per take (`src/takes.ts`): take6 on (take7 is the default) is **tristan** (opens the room, blue) and **jess** (joins,
violet); take4 and take5 were alice and bob, with bob's Claude writing only the tests. The room's Claude is clay in
every take. The table is take7's.

| s | Beat | On-screen text |
|---|---|---|
| 0–3 | Cold open, split screen: tristan's and jess's tests turn green together | Two people. Two Claudes. One plan. |
| 3–7 | Static split: two terminals with name plates (a name and a colour each) | Pairing usually means one of you gives up your session. |
| 7–9 | Title over the split | sub-human: Pair up with others in Claude Code as native subagents |
| 9–15 | tristan runs /sub-human and jess joins (2×). The agent panel opens and shows the room's members. | Open a room. Everyone joins from their own terminal. |
| 15–20 | `@room jess, can you …` lands in jess's pane | @room: talk to everyone. |
| 20–30 | jess asks tristan's Claude. A tag flies from jess's pane to tristan's, tristan's Claude reads the code, and the answer flies back. tristan's prompt is never touched. | Your Claude can ask theirs. tristan isn't interrupted. |
| 30–36 | `@claude let's plan…`. The room's Claude thinks (8×), then the plan opens in both panes. | Ask the room's Claude for a plan. It opens for both of you. |
| 36–46 | jess says no with "must 400, not 500". The revised plan shows the note, then both say yes. | Each person approves. No Claude can say yes for you. |
| 46–52 | Split screen: the plan becomes two tasks. tristan's Claude writes the store (`src/store.js`: listTasks with an opaque cursor), jess's the HTTP handler (`src/server.js`: `?limit&after`, 400 on a bad cursor), each with its own tests (6×). The subagent row shows in a panel. | Each Claude builds its half: tristan's the store, jess's the API. |
| 52–55 | tristan's Claude pushes and tells jess's Claude (a tag flies); jess's Claude pulls, builds the handler on it, then runs npm test on both halves | Your Claudes keep each other posted. |
| 55–58 | Both npm test runs pass, side by side | Tests pass for both. |
| 58–62 | (Optional, only with an honest ssh take) `/sub-human join dev vole-8126` | Same room, across machines over ssh. |
| 62–68 | End card | Pair up with others in Claude Code as native subagents · the two /plugin lines · Then run /sub-human. · repo URL |

Rules:
- The split screen is the default. Zoom within each half, and never cut to a single pane for long.
- The two people and the room's Claude each keep the same name and colour throughout.
- An animated tag marks every message that crosses between panes.
- Show the speed badge only over model time.
- Cut process noise: a self-inflicted test failure, a duplicate test run, every separate agree.
- Hooks to try: "Your Claude, meet their Claude." · "Two developers. Two Claudes. Nobody gives up the keyboard."
- 15 s social cut, about 4 s each: green split, Claude asks Claude, plan plus both approve, install line.
- README GIF, about 8 s loop: the Claude-to-Claude exchange in the split, with name plates only.
