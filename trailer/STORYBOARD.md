# Trailer storyboard (v2, ~68 s)

From the demo research of 2026-10-11:
- Lead with the result, not a logo.
- State the problem.
- Make Claude asking Claude the moment that lands.
- Show consent as one beat.
- Keep both people on screen.
- End with one call to action.

| s | Beat | On-screen text |
|---|---|---|
| 0–3 | Cold open, split screen: alice's and bob's tests turn green together | Two people. Two Claudes. One plan. |
| 3–7 | Static split: two terminals with name plates (a name and a colour each) | Pairing usually means one of you gives up your session. |
| 7–9 | Title over the split | sub-human: pair up without giving up your own Claude. |
| 9–15 | alice runs /sub-human and bob joins (2×). The agent panel opens and shows the room's members. | Open a room. Everyone joins from their own terminal. |
| 15–20 | `@room bob, can you take the parser tests` lands in bob's pane | @room: talk to everyone. |
| 20–30 | bob asks alice's Claude. A tag flies from bob's pane to alice's, alice's Claude reads the code, and the answer flies back. alice's prompt is never touched. | Your Claude can ask theirs. alice isn't interrupted. |
| 30–36 | `@claude let's plan…`. The room's Claude thinks (8×), then the plan opens in both panes. | Ask the room's Claude for a plan. It opens for both of you. |
| 36–46 | bob says no with "must 400, not 500". The revised plan shows his note, then both say yes. | Each person approves. No Claude can say yes for you. |
| 46–52 | Split screen: the plan becomes two tasks. Each Claude writes its half (6×). The subagent row shows in a panel. | Each Claude builds its half, in its own checkout. |
| 52–58 | Both npm test runs pass, side by side | Tests pass for both. |
| 58–62 | (Optional, only with an honest ssh take) `/sub-human join dev vole-8126` | Same room, across machines over ssh. |
| 62–68 | End card | Pair up in Claude Code. · the two /plugin lines · Then run /sub-human. · repo URL |

Rules:
- The split screen is the default. Zoom within each half, and never cut to a single pane for long.
- alice, bob and the room's Claude each keep the same name and colour throughout.
- An animated tag marks every message that crosses between panes.
- Show the speed badge only over model time.
- Cut process noise: a self-inflicted test failure, a duplicate test run, every separate agree.
- Hooks to try: "Your Claude, meet their Claude." · "Two developers. Two Claudes. Nobody gives up the keyboard."
- 15 s social cut, about 4 s each: green split, Claude asks Claude, plan plus both approve, install line.
- README GIF, about 8 s loop: the Claude-to-Claude exchange in the split, with name plates only.
