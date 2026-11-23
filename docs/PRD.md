# sub-human v2: Product Requirements

Status: draft, 2026-11-22. Covers the rebuild of the 0.8.1 proof of concept.

## 1. Summary

sub-human lets you work in Claude Code as you normally do while your colleagues are kept up to date, in real time, with what your session learns, decides and changes. Their Claudes are kept up to date too. Several people work on related tasks. Each keeps their own terminal, repo, login and Claude. The information flows between sessions without anyone stopping to write a status update or copy and paste between chats.

Chat is not the point: people already have many ways to talk to each other. The value is that the work itself is shared as it happens.

The 0.8.1 proof of concept showed that this is valuable. These parts held up in every live scenario run:
- one Claude asking another a factual question without interrupting its person;
- shared plans that only people can agree to, and that each Claude then acts on;
- a shared task list with a claim lock;
- posts queued while offline.

Where it fell short was the core: it shared little of the work automatically. Nobody knew who was touching which files, finished tasks notified nobody, and the POC rated itself 1/5 on keeping people in sync.

It also showed what to avoid:
- 101 dependencies on Claude Code internals, 71 of them undocumented;
- fallbacks stacked on fallbacks;
- agreement wired into plan mode's internals (plan-file swapping, mode restoring), which caused most of the visible bugs;
- far more on-screen text than the budget allowed;
- four remote transports, three of them in front of people;
- roughly 31k lines of runtime code under 40k lines of tests and harness.

v2 rebuilds the product on the parts that worked and documented surfaces, with a fraction of the code and concepts.

## 2. Problem

When two or more people each work with their own Claude on related tasks, context does not flow between them:
- Each Claude knows only its own person's session. Questions like "which port does the server listen on?" or "what shape did you give `listTasks`?" get answered by a person copying and pasting between chats, or by interrupting a teammate.
- Decisions that affect several people (an API shape, a split of work) are made in one session and relayed by hand, with no record of who agreed to which version.
- Nobody can see what the others are doing right now, which files they are touching, or when a piece they depend on is done.
- What one session discovers (a bug's cause, a constraint, an interface change, a failing test) stays in that session until its person remembers to tell someone.

Existing options are:
- one shared session: there is a single driver, so everyone else waits;
- exporting context by hand: it is stale at once;
- a chat tool beside the terminal: it depends on people writing updates, and the Claudes can't see it.

## 3. Goals

1. **Your work keeps your colleagues updated, live, without you thinking about it.** What your session learns, decides and changes reaches your colleagues and their Claudes within seconds. Sharing is on from the moment you join. There's no command to share, no status to write, and no approval per update. Each Claude can also ask the others directly.
2. **Use Claude exactly as normal.** Joining a room changes nothing about a person's own session except that others are present. Nobody's work is held up by anyone else's.
3. **Quiet and native.** The plugin adds few lines, uses Claude Code's own UI, and keeps its machinery out of sight.
4. **Durable to Claude Code updates.** v2 relies on documented extension points. A Claude Code release should not break it.

## 4. Non-goals (v1 of the rebuild)

- **A room-level Claude or background job.** That means no `claude --bg` room session, and nothing written under Claude Code's config dir: no task files, no lock protocol.
- **A required workflow.** Planning and sign-off are optional tools, not a pipeline. The product must work as well for "pair on a bug, no plan" and for non-code work.
- **An agent-panel room row** of any kind: no typed chat in a row, no keeper children, no synthesized `turn.step` replies, no row hand-back suppression. Who's here and unread lines live on the status line.
- **Cosmetic redraws of Claude Code frames.** Native frames are accepted as they are.
- **More than two cross-machine pathways.** v2.0 has Tailscale (Funnel or Serve) and ssh (R29). `--forward` and hosted relays are out.
- **Host failover or moving the host.** If the host is away, the room waits.
- **Pinning a model** anywhere, and **writing user settings files** or symlinking into `~/.claude`.
- **Watching, steering or taking over another person's Claude.**

## 5. Users and use cases

| Persona | Situation | What they need |
|---|---|---|
| Pair | Two developers on one feature, split across store and handler | Agree the interface once; ask the other's Claude about the code; know when the other side has landed |
| Loose team | Coworkers on related branches in one repo | See who is touching what; get a heads-up when someone changes a shared file or interface |
| Across repos | A front-end dev in the web repo and a back-end dev in the API repo | One room spanning both repos. The front-end Claude learns of an API change as it lands, and can ask the back-end Claude about an endpoint |
| Friend on another machine | Joining from anywhere. Few people can ssh into a friend's machine | Open one URL the host sent and be in. Nothing to install beyond the plugin; only the host runs Tailscale (Funnel) |
| Coworker on a corporate network | Tailscale is blocked, but ssh to the host works | The same one-line join over their own ssh login |
| Solo, two machines | One person on a laptop and a dev box | The same room across both, counted as one person for agreement |
| Non-code collaborators | Writing a doc, planning, research | Nothing in the flow assumes code ("Ready to code?", evidence on done) |

**Core stories:**
- **S-Join.** I type `/sub-human` and I'm in a room with whoever else on this machine has done the same, whatever repo each of us is in. To bring someone from another machine, I run `/sub-human invite`, they type one line, and they're in.
- **S-Live.** I work with my Claude as usual. When my session learns, decides or changes something that matters to a colleague, their Claude has it by their next turn, and they see a count on their status line. Examples: I change the shape of `listTasks`; we find the flaky test is a timezone bug; I push the store half. I typed nothing extra.
- **S-Relevant.** My Claude gets what bears on my work, not everything. A colleague's change to a file or interface I'm using, or a plan I'm part of, reaches me first and in full. The rest stays one short line, or waits in the catch-up.
- **S-Ask.** My Claude needs a fact the other person's Claude has, and it asks directly. The other Claude is woken at the end of its current turn, and its person sees one line. It answers if it is sure; otherwise the question waits for its person. Likewise, when my session changes something bob's side depends on, my Claude tells his directly, and his updates its side on its own. Nobody's turn is interrupted.
- **S-Aware.** At a glance, without asking, I can see who is here, whether each person is working or idle, and what each is working on.
- **S-Plan together.** We write one shared plan in plan mode, as we normally would, and it says who does what. Each named person agrees or asks for changes in their own session, and the room records the decision for that exact version. Each person's Claude then knows its own part.
- **S-Send a plan.** I make my own plan in plan mode, as usual. When it's ready I send it to the room or to one person. Their session receives it whole, and their Claude can act on it once they accept it.
- **S-Split.** We put tasks on a shared list. Anyone can add, people claim their own, and when a task I'm waiting on is done, my Claude hears about it.
- **S-Leave.** I leave and my session keeps going. When the last person leaves, the room closes and is cleaned up later.

## 6. Requirements

Priority: **P0** = v2.0 ships with it; **P1** = v2.0 if cheap, else v2.1; **P2** = later.

### 6.1 Rooms and membership
- **R1 (P0)** **A room is not tied to a repo or directory.** Members may be in different repos (front end and back end), or in none.
  - `/sub-human` with no arguments joins the one room open on this machine, or opens one if none is open.
  - If several rooms are open, it asks which.
  - `/sub-human ROOM` names one; an invite line joins from another machine.
  - The default name is the git name; `/sub-human NAME` picks another.
  - Each member's activity (R12) carries their repo and branch, so others know where it happened.
- **R2 (P0)** A room has a short human-readable code (e.g. `vole-8126`). Each member is addressed `NAME.CODE`.
- **R3 (P0)** `/sub-human leave` leaves the room and keeps the session. Ending the session leaves the room too. A room with nobody left closes, and its data is deleted after a fixed retention period.
- **R4 (P0)** `/sub-human who` lists the members, their machines and their state. `/sub-human help` lists every command.
- **R5 (P1)** One person seated from two sessions or two machines counts once for agreement.

### 6.2 Live updates from the work
This is the product. Everything else supports it. The POC scored itself 1/5 here.

**What is shared, automatically, with no extra step from the person**
- **R12 (P0)** **Activity:** each member's session publishes, as it works:
  - the facts the plugin can see without a model call: branch, files edited, commits made or pushed, test and build runs with pass or fail;
  - presence: working or idle. "Waiting on a permission prompt" is best-effort only: the one documented signal, the `Notification` hook, arrives about 6 s late.

  File edits and presence are coalesced into each member's **latest-wins documents**, not one log entry per tool call. Discrete events (a commit, a push, a test result, a task change) are log entries. While the host is away, a member's documents keep updating locally and are re-sent on reconnect, so no activity is lost when the host sleeps. None of this ever wakes anyone.
- **R13 (P0)** **Findings:** at the end of a turn that changed or learned something others may need, the member's own Claude may publish one short update in its own words. Examples: an interface change, a discovered cause or constraint, a decision the person made, a piece of work finished. It is labelled as that Claude's, never the person's. A turn with nothing worth sharing publishes nothing. This is in the injected mechanics: share what a colleague would want to know, never narrate. See Q9 for the cost.
- **R14 (P0)** **Working-on:** each member has a current focus, one line kept up to date by their Claude, plus the branch and files from R12. It is shown in `who`, in the catch-up and in other Claudes' context.
- **R14a (P0)** **Sharing is on whenever you're in a room.** Joining a room is the opt-in: if you don't want to share, you don't join one, or you leave. There is no per-update approval, pause or per-room mode. Two safeguards stay:
  - nothing matching common secret patterns, or `.env`-style files, is ever shared;
  - updates never contain file contents beyond a short excerpt the Claude chose to quote.

**How it reaches colleagues**
- **R15 (P0)** **Real time:** an update reaches every member's machine within 5 s on one machine, and within 10 s across machines while the link is up.
- **R15a (P0)** **To their Claude, as context, pushed only when relevant:**
  - Only updates that bear on the member's work (R15c) and overlaps (R15d) are pushed.
  - They are attached as context to the member's next submitted prompt, through the `prompt.submit` hook's `context`. So they arrive when the person next types, not in the middle of a long tool loop.
  - There is a hard cap of about 400 tokens per turn.
  - Everything else is pulled on demand: the Claude calls `read` (R16), and the person runs `/sub-human news`.
  - Colleagues' content is datamarked: clearly delimited and labelled as data from a named colleague's Claude, never carrying commands. The mechanics tell the Claude to use it only if it bears on the current task and never to mention it unprompted.
  - Updates never start a turn on their own (R10).
- **R15b (P0)** **To the person, ambiently:** one status line, e.g. `vole-8126 · bob (working on paging), carol here · 3 updates`. An update that bears on the person's own work (R15c) is drawn as one dim line; everything else is only counted. `/sub-human news` shows what each member changed and found since the person last looked, drawn by the module with no model call, and clears the count.
- **R15c (P0)** **Relevance:** an update bears on a member when it touches a file they have edited or opened, a plan or task they are part of, or names them. Across repos, file paths rarely match, so the interfaces a plan names count as well (an endpoint, a type, a schema). Those come first and in full. Others are summarised in one line or left to the catch-up.
- **R15d (P0)** **Overlap heads-up**, the main push signal (Q15): when two members edit the same file, or one changes a file named in an agreed plan, both get one dim line. This is never a wake.
- **R16 (P0)** **Catch-up:** a Claude can read a short summary of the room on demand: who is working on what, recent updates and findings, open plans and their state, open tasks and recent decisions. It is bounded in size and framed as content.
- **R16a (P2)** Subagents in a member's session show in their activity and are attributed to that member's Claude.

### 6.3 Asking and messages
Talking is secondary. People have chat already; these exist so the Claudes can talk to each other, and so a person can address the room when it is easiest.
- **R6 (P0)** Claude-to-Claude questions use native `SendMessage` addressed `NAME.CODE`. This is how S-Ask works.
  - **Native delivery isn't used for room members.** It would wake an idle recipient at once and interrupt a busy one mid-turn, and the recipient's `session.receive` carries no sender name.
  - So the module catches the message at the **sender**. Its `session.send` hook takes any `to` ending in `.CODE` and answers `{isDelivered: true}` without passing the message on. It then carries the message over the room channel, stamped with the sender.
  - The recipient's module wakes its Claude through `$.prompt.submit` under R10: after the current turn, with framing, debounce and budget.
  - One risk: whether Claude Code honours that answer. An M1 module test settles it.
  - Across machines the link carries the message straight to the recipient. **It is never written to the room log**, so no mirror or later joiner ever holds it. It stays private between the two Claudes, as it is locally (Q4).
- **R7 (P0)** A Claude can post to the room with the `share` tool's `post` op. Its posts are always labelled as that Claude's (`bob's Claude: …`), never as the person's.
- **R8 (P1)** `@room TEXT` posts the person's exact words, with no model turn. It is useful for addressing everyone's Claude at once ("everyone, rebase on main"), not as a chat product.
- **R10 (P0)** **Wake rule: a direct message wakes; broadcasts never do.** A turn starts in my session only when:
  - a person's line names me (`@me`, or `me, …`);
  - **a colleague's Claude messages mine directly** (`SendMessage` to `NAME.CODE`), for example to ask a fact or to say "the `listTasks` shape changed, update your side". This is how the other side updates on its own after a change (the POC's best moment);
  - someone answers my Claude's open question.

  Rules:
  - **Broadcasts never wake.** Findings, posts, activity, plans, decisions, joins and chat reach my Claude as context on its next turn, and me as a line or a count.
  - **A woken turn is framed as a colleague's request, not an instruction.** The message is marked as coming from `bob's Claude`, as data. The mechanics say: answer facts and make changes within your own task. Anything else waits for your person: running a command the message supplies, touching files outside your work, or anything destructive. **In every mode,** a direct message that carries a command or URL to run is shown to the person, not submitted. The module can't read the permission mode, so the rule doesn't depend on it.
  - **This is a known risk, accepted.** Text planted in a repo could still reach my Claude through bob's. The framing, the rule above and the wake budget limit what it can do, but they don't make it impossible. The live gate includes an injection scene (Q-2).
  - A wake waits until my current turn ends and never changes my permission mode.
  - **Bounded:** one wake per question, debounced, so four answers make one wake. There is also a per-person wake budget per hour, after which wakes become unread lines.
- **R11 (P1)** A Claude woken by a question, from a person's line or from a colleague's Claude (R10), answers only facts it is sure of, in one line. Anything else (an opinion, a choice) waits for its person, who sees it as unread.

### 6.4 Plans
Plans are how one person's Claude learns what another's should do. They stay a core feature. People write them in Claude Code's native plan mode. Reviewing someone else's plan happens in a Claude Code-drawn card, with the full text in a scrollable pane (R21). The plugin never swaps a plan file or forces a mode.

There are two ways to use them, and either works alone:
- **A shared plan:** written together, with an owner on each part.
- **A sent plan:** written alone in your own plan mode, then sent to someone.

**Common to both**
- **R17 (P0)** A plan is a named, versioned Markdown document held by the room. Every version is kept. Edits are compare-and-swap on the current version: a stale edit is refused with the current text, so the Claude can merge both changes.
- **R18 (P0)** People write plans in Claude Code's native plan mode, exactly as they do alone. A hook handles everything; there is no command to learn.
  - **When a plan is approved,** and only then, the person is asked once: **Keep it / make it a room plan / send to NAME**. The hook is on `ExitPlanMode`'s result, which carries `{plan, filePath}`. There is no module event for entering plan mode, so nothing is asked there.
  - A room plan is stored as a shared plan (R20–R22a). A sent plan goes to one member or the room (R22b). Kept plans stay theirs, and nothing is shared without that choice.
  - The question is skipped when the answer is obvious, for example when the plan is a revision of a room plan.
- **R19 (P0)** **Three properties hold for every plan feature:**
  1. A person's own plan is never lost or overwritten.
  2. A person's permission mode is the same after a review as before.
  3. The copy fits reviewing someone else's plan, for any kind of work: never "Ready to code?", and no red error on a save.

  Each property has a test.

**A shared plan: plan together, say who does what**
- **R20 (P0)** A shared plan can mark parts with an owner, e.g. a `@jess` line, or an owner on a step. Owned parts become tasks (R23) linked to the plan version, so the list and the plan never disagree.
- **R21 (P0)** Asking for agreement names the people and one exact version. Each person answers in their own session, on a Claude Code-drawn card (`$.ui.ask`, the native question card; Q8):
  - The card shows a short summary of what changed since the last version they saw.
  - The answers are **Agree**, **Ask for changes** (the note typed through Other), and **Read the full plan**.
  - **Read the full plan** opens a **scrollable module pane** (`$.ui.open`) with the whole text and the diff, because a card can't scroll. It opens from that choice, not unasked, since an unasked pane only places on terminals at least 144 columns wide.

  The room records a decision when everyone named has answered.
- **R22 (P0)** Answers apply to one version only. A newer version supersedes open requests on older ones. An "ask for changes" note reaches the author's Claude word for word, and it may draft the next version.
- **R22a (P0)** Once a version is agreed, each owner's Claude gets its part as context: the agreed text, its part, and who owns the rest. This is how each Claude knows what to do.

**A sent plan: pack it up and hand it over**
- **R22b (P0)** Sending packs the plan with what the recipient's Claude needs to act on it: the plan text, the sender's branch and the files it names, and an optional note. It goes to one person or the room.
- **R22c (P0)** The recipient sees one line (`jess sent you plan api-store v1`) and opens it on the same card, with the full text in the scrollable pane (R21). There they **accept** it, so their Claude takes it as its plan and context; **ask for changes** with a note back to the sender's Claude; or **dismiss** it. It never starts a turn by itself.
- **R22d (P1)** A sent plan can be agreed instead of merely accepted: the sender asks, and the decision is recorded as in R21.
- **R22e (P1)** Two people can each send their own plan for the same piece of work, and either Claude can merge the two into one shared plan (R17), which keeps both histories.

### 6.5 Tasks
**Principle:** each person's own native task list stays theirs and works exactly as it does alone. The room mirrors it; it does not replace it. The task list is just more work that keeps colleagues updated without anyone thinking about it (Goal 1).

**Why not the POC's approach.** Claude Code picks a session's list at launch (`CLAUDE_CODE_TASK_LIST_ID`, else the session id). A running session can't be moved onto a room list, so the POC needed:
- a headless `claude --bg` per room to hold the list;
- task files written by hand into the config dir, relying on 21 contract entries: the schema, lockfile, high-water mark, auto-reset (worked around with a hidden task #1) and retention;
- a projection per machine.

None of that is needed if the room reads the native list instead of writing it.

**Two layers**
1. **Personal tasks are native and mirrored, read-only.** The person's native Task tools (TaskCreate/TaskUpdate, once they have enabled them, R23a) work untouched; TodoWrite is best-effort (R23c). The hooks module's tool-result event on those tools (C1) reads the tool's input and result and publishes each change as an activity update (R12): `bob: started "paging handler" (2 of 5)`.
   - No files are read or written under the config dir, and the plugin sets no env var and needs no launcher.
   - It works mid-session and on every machine, because it rides the room log.
2. **Room tasks are for work handed between people,** with a small room list held by the host:
   - anyone can add a task;
   - a claim is for oneself only, and is refused while someone else owns the task;
   - only the owner can release a task or mark it done.

   When I claim or am handed a room task, **my own Claude adds it to my native list** with its normal task tool, tagged with the room task's id (e.g. `[room vole-8126#3]` in the subject, or task metadata where available). From then on I track it natively like any other task. When my Claude marks it done or in progress natively, the same hook (layer 1) carries the change back to the room task.

   The bridge is the model's own documented tool calls plus a documented hook: no file is shared, and no file format is parsed.

**Requirements**
- **R23 (P0)** Personal native task changes are mirrored to the room as activity, from the module's `tool.call` results on the native task tools only. Nothing under Claude Code's config dir is read or written. It is on whenever the member is in a room (R14a) and the session has the Task tools (R23a).
- **R24 (P0)** The room task list: add; claim, for oneself only, refused while someone else owns the task; release; and done, owner only. The host applies each change immediately. Reached by the `task` tool, `/sub-human tasks`, the catch-up, and a count on the status line.
- **R24a (P0)** **Bridge into the native list:** a room task I claim or am handed is added to my native list by my own Claude, carrying the room task id. Native status changes on a tagged task update the room task through R23's hook. If the person's session has no native task tool, the room list still works on its own.
- **R25 (P1)** A room task can depend on others (`blockedBy`). When a task is done or released, the members who depend on it, or who suggested it, get it as context and one dim line.
- **R26 (P1)** "Done" takes an optional note, not required evidence.
- **R27 (P2)** A task can be handed to someone, with their acceptance. On acceptance it goes onto their native list (R24a).
- **R27a (P2)** A person can promote one of their personal tasks to a room task ("put this on the room list"), and it keeps its native entry.

**Spike results (Q11, Claude Code 2.1.296, default model Opus 5.5).**

*Availability.* On current models, a session has no native task tool unless the person launches Claude Code with `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`. That variable gives TaskCreate, TaskUpdate, TaskList and TaskGet; adding `CLAUDE_CODE_ENABLE_TASKS=0` gives TodoWrite instead. The plugin can't turn the tools on itself, because the variable is read at launch and user settings are off-limits.

*Mirroring.* The tools themselves mirror cleanly:
- `tool.call` plus `next(e)` returns typed results, `{task:{id,subject}}` and `{taskId, updatedFields, statusChange:{from,to}}`, and fires for subagents too (with `agentId`).
- The `[room CODE#N]` subject tag survives byte for byte.
- TaskCreate's `metadata` is kept by Claude Code but is not echoed back in results.

These findings change the requirements as follows:
- **R23a (P0)** **The room list never depends on native tools.** Room tasks (R24) work in every session. The native bridge and mirroring are on only when the session has the Task tools, detected with `$.tool.list`. README documents `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` as the person's own choice.
- **R23b (P0)** **Mirror from TaskCreate and TaskUpdate.**
  - Keep a map of id → {subject, room tag} per (session, taskId), because update results carry neither. Fill it from creates and from rename inputs.
  - **Persist the map** in the plugin home. After a `/clear`, resume or restart, re-derive it from tagged subjects with `TaskList`.
  - Read status from `statusChange.to`, including `deleted`.
  - Tag both the subject (`[room CODE#N]`) and `metadata.room`/`roomTask`.
  - A reopen (pending ↔ in progress) is no change, so it never releases owned work. Only `deleted` or an explicit `task release` releases a task.
  - Never rely on seeing a deletion, because auto-reset and retention delete tasks without any tool event.
- **R23c (P2)** TodoWrite, best-effort: a positional diff of `oldTodos`/`newTodos`, with the tag in `content`. It has no ids.
- **Contract.** The tool gate is internal: the env var, the model list and `--tools` opt-in. It goes in `contract.json` as one entry. All the shapes the mirror reads are typed API.

### 6.6 Across machines
- **R28 (P0)** One host per room holds the authoritative log. Other machines keep a mirror that syncs from it, reads locally, and sends every write to the host. A joiner or a reconnecting mirror syncs from **a snapshot plus the entries after it**, never by replaying the whole log, and the cursor is a host-assigned sequence number. While any of the host's links is live, the host holds a sleep assertion (`caffeinate -i -w PID` on macOS, `systemd-inhibit` on Linux).
- **R29 (P0)** **Two pathways behind one transport layer.** Every pathway gives the room the same thing: a byte stream to the host, with the host proven by its key. Pathways differ only in how they dial. Invites, sync, reconnect, kick and the protocol never know which pathway is in use. Adding a pathway means adding one dialer and one invite-line form.
- **R29a (P0)** **Tailscale, the default.** Only the host needs Tailscale. The host's listener stays on loopback and is published by the plugin.
  - With **Funnel**, the invite is a public `https://` URL. The joiner needs nothing but the plugin: no Tailscale and no account.
  - With **Serve**, the URL is reachable only on the host's tailnet.
  - The host picks with one flag (public by default, or tailnet-only), and the invite line has the same shape either way.
  - The wire is **WebSocket over HTTPS**, using the `ws` package. That gets through corporate proxies, and the joiner's dialer honours `HTTPS_PROXY`. Raw TLS-terminated TCP was spiked; proxies that inspect TLS drop it and Node's `tls.connect` ignores proxies, so the spike branch stays unmerged.
  - **Funnel hardening:**
    - `--proxy-protocol=2` is mandatory and parsed, so per-source limits see real addresses rather than one loopback source.
    - The host-key query op is removed.
    - The host refuses before starting any per-connection work unless the handshake's third message carries a known link key, or a MAC derived from an open invite's secret.
- **R29b (P0)** **ssh, for networks that block Tailscale.** The joiner runs `ssh -W 127.0.0.1:PORT` through any account they have on the host machine. That reaches the same loopback listener Funnel uses, so there is one server path. Because of this:
  - there is no shim in the host's home, and no login as the host;
  - kick works the same as on every other pathway;
  - a dev box where each person has their own account works.

  The cost: sshd must allow TCP forwarding (`AllowTcpForwarding`). That is documented, and `doctor` checks it. The invite line is an `ssh://` form. Nothing is written to `authorized_keys`.
- **R29c (P0)** **One encrypted, key-authenticated channel on every pathway:** Noise XK, using the POC's `noise.ts`, kept.
  - It is built on `node:crypto` primitives, with zero dependencies, and checked against the published cacophony and snow test vectors in CI.
  - The joiner knows the host's key from the invite, so the secret only ever reaches the real host.
  - The joiner proves a key of its own, so a link is a key, not a bearer token.
  - ssh's separate signature proofs are retired in favour of this one handshake.
  - It is a deliberate exception to C6, explained in Q2.
- **R30 (P0)** **Invite and admission: one line, plus the host letting them in.**
  - `/sub-human invite jess` gives the host one command to send, e.g. `/sub-human join https://NODE.ts.net/ROOM#SECRET`. The line carries:
    - a 128-bit, single-use, short-lived secret, sent only inside the Noise channel and compared in constant time;
    - the host's key, so it can't be guessed and only reaches the real host.

    It is our own code (about 20 lines), not `blind-pairing` (Q14).
  - The invite is **bound to the expected name**. A joiner under another name is shown as a mismatch on the host's prompt.
  - The joiner types it and waits, and sees their own check string. The host gets one native prompt, **Let in / Refuse**, showing the joiner's name, machine and the same check string, so the two can compare.
  - **A second dial of a pending or used line refuses both pending dials and alerts the host,** with a one-key kick ("someone else also used this invite"). That defends a leaked line.
  - Nothing is admitted without the host's answer, so the secret doesn't need hiding from models. It does still sit in transcripts, which is acceptable only because the line is single-use and short-lived.
  - There is no PIN and no second thing to pass along. The PIN path, its throttling and the hidden-prompt blocking are dropped.
  - If the host doesn't answer within a few minutes, the joiner is told to ask again. A refused or expired line is dead.
- **R31 (P0)** `/sub-human kick NAME` (host only) ends that person's access immediately and permanently for this room.
- **R32 (P0)** Reconnect is handled by a pure, clock-injected state machine with backoff, heartbeat and sleep/network-change detection. While offline:
  - a member's latest-wins documents (activity, presence, focus) are kept locally and re-sent on reconnect (R12);
  - a person's `@room` posts queue for a bounded time;
  - every other write fails fast.
- **R33 (P0)** The protocol carries a version and capability list. On a version skew, both sides say which side must update.
- **R34 (P1)** The host being away is visible to everyone ("host away") instead of showing up as silent failure. The room is hosted while the host has a session in it. When the host's last session ends, remote members see "host away" until it returns, since failover is a non-goal.

### 6.7 Trust and safety
The threat is outsiders: someone who isn't in the room reading it, writing to it, or impersonating the host. Inside a room, members and their Claudes are trusted collaborators. v2 does not try to stop a member's own Claude from acting for its person. The POC did, with per-person keys only hooks could use and a prompt-origin gate, and v2 drops that machinery.
- **R35 (P0)** **Attribution is honest and plain.** Every entry records the member and machine it came from, and whether the person or their Claude wrote it. A Claude's posts and updates are labelled as that Claude's. This is a labelling rule, not a security boundary.
- **R36 (P0)** The log is append-only and hash-chained, with the host authoritative, so mirrors detect a fork and never silently diverge. On a fork, the mirror discards its copy and resyncs from the host's snapshot (R28). Its queued posts are re-sent under their original ids, and the host drops duplicates.
- **R37 (P0)** Each machine authenticates to the host with its own link key (R29c). The host checks that each write comes from one of that link's members, and refuses system-only kinds from links. Replays are refused.
- **R38 (P0)** **Security never depends on parsing Bash.** Any command guard only advises, and must not deny text that merely mentions a command.
- **R39 (P0)** No hook answers a permission check with allow. A person keeps every permission decision.
- **R40 (P1)** Per-link rate limits on a few write operations, instead of an 11-row quota table.

### 6.8 Quiet and native
- **R41 (P0)** **Line budget:** at most 6 plugin-drawn lines per person per scene in the reference scenes. Receipts, retries and link flaps go to Claude Code's debug log.
- **R42 (P0)** The Claude's injected instructions cover only mechanics, are at most about 1.5k characters, and travel as context: never as red error text or a drawn line.
- **R43 (P0)** One speaker (`sub-human:`), past-tense events, and errors written as "what didn't happen, plus one action".
- **R44 (P0)** **Glossary of at most 10 user-facing terms,** used the same way in code, docs and copy: room, code, host, member, invite, update, plan, version, agree, task.
  - Internal names match the user-facing ones wherever a user-facing one exists.
  - Engineering-only names (mirror, link, pathway, listener) never appear in copy.
  - Findings, focus and activity are all shown to people as "updates".

## 7. Platform constraints and dependency policy

- **C1. Built on the hooks module.** The early-access hooks module (`$` API) is the plugin's foundation. It runs in-process and covers:
  - `tool.call` results, for activity capture (R12), native task mirroring (R23), and the plan-approval question (R18);
  - the `prompt.submit` hook's `context`, for per-turn context. `prompt.context` is not used: it fires once per conversation, and rewriting it breaks the prompt cache;
  - `$.session.append` notes and `tool.call` result `context`, which reach the Claude inside a long tool loop without starting a turn, for the overlap heads-up (R15d);
  - `ui.status`, `ui.log`, `ui.ask` for cards, and `ui.open` panes;
  - `$.prompt.submit` for wakes;
  - `session.send`, caught at the sender, for Claude-to-Claude routing (R6);
  - `$.tool.register` and `tool.run`, for Claude's tools (no MCP server);
  - following the room log by polling a small file every 0.5–1 s with `$.clock.every`, because the module has no file watch.

  Calls in the `$` API's typings count as API, not internals. Behaviour the typings don't promise counts against C2. The surfaces were checked against typings extracted from Claude Code 2.1.330 (Q1).

  **The module has no Node and no `import()`.** It imports only its own files by relative path. So:
  - `ws` and Noise run in node children only;
  - the module talks to them over `$.http.fetch` to loopback, or through files;
  - `$.process.spawn` children die when the module unloads, so a daemon that must outlive the session (the listener, a link daemon) detaches itself.

  **Managed machines.** On Team or Enterprise logins, or wherever managed settings exist, Claude Code's guard never runs a user-installed module's `classic.*`, `prompt.context`, `prompt.attachment` or `session.compact` hooks. Policy can also turn modules off entirely. So the hooks v2 can't lose are command hooks in `hooks.json`, which the guard leaves alone:
  - the `/sub-human` expansion;
  - `SessionEnd`;
  - `SessionStart` with `sessionTitle`, for `NAME.CODE`;
  - `Notification`, for permission waits.

  If the module is off, the person is told in one line.

  Other surfaces: skills, and `SendMessage` addressed `NAME.CODE`. Early-access calls change, so the committed typings snapshot is refreshed to 2.1.330 in M0 (it is from 2.1.296), and the canary (Q-4) diffs the typings on every release.
- **C2. An internals budget.** At most 10 entries in `contract.json` may depend on undocumented behaviour. Each has a named reason, a single fallback that is plain degradation (never another internal), a probe, and a filed feature request.
  - After the Q1 check, the estimate is about 2–4 undocumented entries:
    - firm: the task-tool gate and the wake prompt's frame;
    - possible: honouring a `session.send` answer without passing the message on, and uniqueness of `sessionTitle` names.
  - The POC had 101 entries in total. With the typed and documented ones counted, v2 will have about 18–22.
- **C3. No fallback chains.** A feature either works or degrades straight to "not available" with one line to the person.
- **C4. Runtime.** The module runs in Claude Code's own runtime. Node-side code (link, listener, Noise, ws, command hooks) needs Node 22.18+ with type stripping. Neither side has a build step.
- **C5. Process count.** Per session there is one piece: the module, in-process, which does the following, delivery, the status line and Claude's tools. There is no MCP server and no tail child. Node children run only for the link, listener, Noise and ws work.

  Per machine, only for rooms that span machines:
  - the **listener**, on the host, while it hosts such a room;
  - one **link daemon** per room, on each mirror.

  Nothing else is started.
- **C6. Open-source dependencies for solved problems.**
  - **The rule:** where a small, maintained open-source package solves a problem, v2 uses it instead of writing its own. The POC's no-dependency rule is dropped. The chosen set covers validation, ignore-pattern matching, plan diffs and the Funnel WebSocket wire (ARCHITECTURE §2a). Locks and crash-safe writes come from `node:fs`; the candidate packages failed the maintenance rule or the Node range.
  - **Deliberate exceptions,** each weighed and recorded: the Noise channel (Q2), the log (Q14) and invites (Q14) stay ours, because the packaged alternatives cost far more than the code they would replace.
  - **What a dependency needs:** active maintenance, a permissive licence, a real user base, and a pinned version. Native addons are allowed when they ship prebuilt binaries for macOS (arm64, x64) and Linux (x64, arm64).
  - **What v2 writes itself:** the product (relevance, wakes, plans, tasks, activity capture, the Claude Code adapter) and the exceptions above.
  - **How dependencies reach the user:** they are vendored as ESM files, committed in the plugin, and imported by relative path (Q13).

## 8. Architecture direction (keep / change / drop)

| Keep (proven) | Change | Drop |
|---|---|---|
| Append-only, hash-chained log as the single source of truth, with pure folds for consent and tasks (per-person seat keys, hook-only signing and the `@room` prompt-origin gate are dropped) | Delivery keeps its four outcomes (none, context, notice, wake), but broadcasts never wake: only a person naming me, a Claude's direct message, or an answer to my Claude's question (R10), and context is pushed only when relevant, under a cap (R15a) | The room session (`claude --bg`), its watchdog and reaper, and native task-file projection |
| The `RoomStore` seam: filesystem, mirror and memory backends | The mid-turn wake becomes "submit at turn end, else hold until the next turn starts"; sync becomes a snapshot plus the entries after it | Plan-file backup, restore and swap, YES_GUARD and keep-mode, which make up most of `review.ts` (740 lines) and `hooks/consent.ts` (616 lines) |
| Plan compare-and-swap, per-version sign-off, native plan mode as the place plans are written | Review moves to a `ui.ask` card with a summary, plus a scrollable pane for the full plan and diff; the plan question moves to approval; adds sent plans and owners on parts | Room rows of every kind: chat rows, keepers, `hold`-kept rows |
| Pure link state machine with an injected clock; the loopback listener behind Tailscale Funnel/Serve; WebSocket over HTTPS as the Funnel wire; the transport registry | Invites: one name-bound secret plus the host's Let in (the PIN, its backoff and hidden-prompt blocking are dropped); one Noise XK handshake on every pathway; ssh becomes `ssh -W` to the listener (no shim); Funnel hardened (R29a) | `--forward`, the ssh shim and login-as-host, CPace history, legacy signatures, the old protocol |
| Native `SendMessage` with `NAME.CODE` addressing | Env knobs: about 55 now, at most 10 user-facing; test timings injected, not read from env | The 804-line lexical Bash guard as a security boundary |
| Offline queue for human posts only | Tail child moves into the in-process follower | Cosmetic `ui.render` redraws, and transcript parsing for fork rebinding |

## 9. Quality and verification

- **Q-1. Deterministic scenes.** Each reference scene (join, live update reaching a colleague's Claude, relevance, overlap heads-up, ask and Claude-to-Claude wake, plan and agree, send a plan, split, leave, remote join) runs without a live model, against the memory store and a fake clock, in CI.
- **Q-2. Small live gate.** One named live run per release, at a known cost, across the three permission modes. It covers at least three workflows: no-plan pairing, plan-then-build, and non-code writing. It also includes an injection scene: a planted instruction travels through one Claude's direct message, and it must not lead the recipient to run anything unattended.
- **Q-3. Test-to-runtime ratio** of at most 1:1. Remote end-to-end tests are deterministic over the memory and pipe transports. Any Docker lab runs in CI or is deleted.
- **Q-4. Canary.** A nightly probe of the (small) internals list against Claude Code `latest` and `next` stays.
- **Q-5. Docs.** One README of at most about 200 lines, one architecture document, and a CHANGELOG. Commit messages are plain sentences.

## 10. Success metrics

| Metric | POC 0.8.1 | v2.0 target |
|---|---|---|
| Undocumented Claude Code dependencies | 71 | ≤ 10 |
| Sign-off and plan-mode contract entries | 15 (sign-off 13, keep-mode 2) | ≤ 3 |
| Contract entries in total | 101 | ≈ 18–22, under 25 (all but 2–4 typed or documented) |
| Colleague context injected per turn | unbounded | ≤ ~400 tokens (R15a) |
| Runtime LOC (excluding tests and typings) | ~31k | ≤ 10k |
| Plugin lines per person per scene | up to ~17 (68 over 4 sessions) | ≤ 6 |
| Unasked turns from others' activity | yes (reviews, decisions) | only R10 wakes |
| Permission-mode changes caused by the plugin | yes (#34) | 0 |
| User-facing terms | 25+ | ≤ 10 |
| `SUB_HUMAN_*` env knobs | ~55 | ≤ 10 user-facing |
| Transports | 4 (+ pipe) | 2 pathways, Tailscale (Funnel/Serve) and ssh, behind one layer (+ pipe/memory for tests) |
| Claude Code releases that break a P0 feature | several (2.1.300, 2.1.302) | 0 per quarter |
| Time from invite to seated (remote) | — | < 30 s, one typed line |

**Product signals** (from live scenes and early users). The first two are the ones that matter:
- **Zero-effort sharing:** a colleague's Claude acts correctly on something learned in my session, with nobody having typed it to anyone. Example: it uses the new `listTasks` shape I just changed.
- **Live:** median time from a change in one session to it being in a colleague's next-turn context is under 10 s.
- **Sharing effort:** typed share actions per hour are about 0. If people use `@room` or "tell bob…" to pass along work, R12–R14 are failing.
- **Noise:** each person rates updates as useful, not noise. Tracked via a "too much / about right / too little" question on leave.
- A Claude answers another Claude's factual question correctly, with no person interrupted.
- A dependent person learns that a task is done without polling.
- Every agreement is traceable to one person's answer on one version.

## 11. Milestones

1. **M0, Foundations.** Log and snapshot, store seam, schemas, folds, memory store, the scene harness on `claude plugin test`. The typings snapshot is refreshed to 2.1.330 (`npm run typings`). The vendored files and their drift check land (Q13).
2. **M1, Live updates on one machine.** Join and leave, activity and findings (R12–R14a), delivery to Claude, the status line and `/sub-human news` (R15–R16), the overlap heads-up (R15d), `SendMessage` routed at the sender (and its module test), the R10 wake rule, Claude's tools through `$.tool.register`. Covers "work as normal; my colleague is kept up to date" end to end. `@room` (R8) only if it's cheap.
3. **M2, Plans.** Versioned plans, compare-and-swap, the question at plan approval, sent plans, owners on parts, and review on the `ui.ask` card plus the scrollable pane. R19's three properties are tested.
4. **M3, Tasks.** Native-list mirroring (R23, R23b), the room list (R24), the bridge into each person's native list (R24a), dependencies and done notices. (Q11 is answered.)
5. **M4, Remote.** Transport layer; Tailscale pathway (Funnel and Serve, WebSocket over HTTPS, hardened); ssh pathway (`ssh -W`); name-bound invite; mirror with snapshot sync; reconnect engine; kick. Ships with M1–M3 if early users need it first; most will.
6. **M5, Relevance tuning.** Relevance ranking from real use, subagent activity (R16a).
7. **M6, Release.** Live gate, README, migration note. 0.8.x rooms are not migrated: v2 starts clean.

## 12. Decisions and open questions

Still open: only Q12, a feature request to Anthropic. Everything else is decided.

- **Q1. The hooks module. Decided: build on it (C1), surfaces checked (2026-11-22, typings extracted from the Claude Code 2.1.330 binary).**
  - Every P0 surface is typed or documented, except the task-tool gate and the wake prompt's frame.
  - The check changed four things:
    - Claude-to-Claude is routed at the sender's `session.send`, because `session.receive` carries no sender;
    - the command/URL rule applies in every mode, because the module can't read the mode;
    - review uses a `ui.ask` card plus a pane;
    - Claude's tools are registered by the module (`$.tool.register`), so there is no MCP server.
  - Internals: about 2–4 (C2). Table: ARCHITECTURE §9.
  - Still to do in M0: run `npm run typings` on 2.1.330 to commit the snapshot.
- **Q2. The common security layer. Decided: Noise XK on every pathway, using the POC's own `noise.ts` (R29c).**
  - It is a deliberate exception to C6. The code is small (280 lines), and it combines `node:crypto` primitives without implementing any crypto math itself.
  - The Noise spec is frozen, and the published vectors pin its behaviour in CI.
  - Every packaged alternative cost more than it saves:
    - `@hyperswarm/secret-stream` brings 19 MB of sodium-native;
    - Node TLS with pinned keys works, as tested in a scratch folder, but needs certificate generation;
    - `@chainsafe/libp2p-noise` brings 13 libp2p dependencies.

  *What each pathway already gives.*
  - Funnel and Serve: TLS ends on the host's own device, in tailscaled, and Funnel's relays cannot decrypt the traffic. The joiner's Node checks a Let's Encrypt certificate for the host's `ts.net` name. So the host is encrypted to and authenticated by name.
  - ssh: authenticated through `known_hosts` and encrypted.

  *What an inner handshake still adds.*
  - Corporate TLS inspection: proxies with an installed root CA, which Node trusts when `NODE_EXTRA_CA_CERTS` or `--use-system-ca` is set, can read and alter Funnel traffic. An inner channel keyed to the host's own key cannot be read that way.
  - An active man in the middle: a signature-only check, without channel binding, can be relayed, so it doesn't stop one. Channel binding to TLS isn't possible here, because the host side's TLS ends in tailscaled, not in our process.
  - The joiner's per-link key: a link becomes a key, not a bearer token.
  - One code path for auth on every pathway, where today ssh uses signatures and web uses Noise.

  *Options rejected.*
  - Authentication-only, trusting the transport's encryption: fails both of the first two points above.
  - TLS inside the stream with pinned Ed25519 certificates: it works, but `node:crypto` can't make certificates, so it needs `openssl`, a dependency, or a hand-written template.
  - `@hyperswarm/secret-stream`: maintained, but a 19 MB native addon for 280 lines of saving.

  *The wire, closed.* The TLS-terminated-TCP spike worked locally, but it is not adopted. Proxies that inspect TLS drop raw TCP, and Node's `tls.connect` ignores `HTTPS_PROXY`. The Funnel wire stays WebSocket over HTTPS, using the `ws` package (R29a), and the spike branch stays unmerged. Record the tailnet identity in `who` when Serve provides it.
- **Q3. Admission. Decided:** the invite line, which can't be guessed, plus the host's Let in / Refuse (R30). No PIN.
- **Q4. Cross-machine Claude-to-Claude. Decided:** private, as it is locally (R6). Relayed messages are delivered only to the recipient. The owner has no preference; this is the simpler choice and matches native behaviour.
- **Q5. A room row. Dropped:** v2 has no agent-panel row; presence and unread counts live on the status line (§4).
- **Q6. Scope of a room. Decided:** not tied to a repo or directory (R1). The example: a front-end dev in one repo, the back end in another.
- **Q7. Sharing from plan mode. Decided:** a hook (R18), asked once at plan approval: keep, room plan, or send to NAME. The review confirmed there is no module event for entering plan mode. Approval is the typed `ExitPlanMode` result (`{plan, filePath}`); the shape of a rejection is internal.
- **Q8. The reviewer's view. Decided:** a `ui.ask` card (the native question card), plus a scrollable module pane for the full plan, opened from the card (R21).
  - Showing a reviewer someone else's plan in their native plan view has no documented surface. `ExitPlanMode` takes no plan text and shows the session's own plan file, so it would mean the swap again.
  - The owner dislikes cards because they can't scroll. The card holds the summary and the answer; the pane holds the full text and the diff.
  - The plan view stays where people write plans.
- **Q9. Who writes findings, and at what cost. Decided:**
  - Activity (R12) is mechanical, from hooks, and costs no tokens.
  - Findings (R13) only ride a turn that is already running, and never cost one of their own.
  - Tokens per hour are measured in the live gate.
- **Q10. Default on. Decided:** sharing is always on in a room; not joining one is the opt-out (R14a). There is no pause and no per-room mode.
- **Q11. Native task hooks. Answered (spike, 2.1.296):** the events are rich enough to mirror and bridge, but current models get no task tool unless the person sets `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`. So the bridge works for people who enable the Task tools, it stays P0 (Q15), and the room list stands on its own (R23a–R23c).
- **Q12. Ask for native tasks by default?** Should Anthropic be asked to expose the Task tools to plugins (e.g. a plugin-declared opt-in), so the bridge works without a launch env var? This is the feature request C2 calls for.
- **Q13. Shipping dependencies. Decided: vendored files.**
  - **Why vendor:** the hooks module imports only relative plugin files; `claude plugin validate` refuses a bare specifier or `node_modules`. So Claude Code's automatic `npm ci` could never serve it.
  - **Layout:** dependencies ship as ESM files in `plugin/sub-human/vendor/`, committed, and imported by relative path from the module and from node code.
  - **No install step:** the plugin root has no lockfile, so Claude Code's automatic `npm ci` never runs.
  - **Drift check:** the root `package.json` pins each package as an exact devDependency. `scripts/vendor.ts` copies them from `node_modules` and records versions, lockfile integrity and file hashes in `vendor/VENDOR.json`. `npm test` fails on drift.
  - **Size:** about 580 KB.
  - **Dropped:** `proper-lockfile` (no release since 2021) and `write-file-atomic` (its current version excludes Node 22.18–22.22.1). `node:fs` covers both.
- **Q14. Holepunch for invites and connecting. Closed (spike):** keep our own invite code.
  - The log stays ours too. Hypercore and Autobase are not used: one trusted writer needs no peer replication, multiple writers only serve host failover (a non-goal), and Hypercore 11 pulls in about 126 MB of RocksDB.
  - `blind-pairing` works, tested on a local testnet and inside our Noise channel. But inside Noise XK its "blind" property adds nothing, and it brings 19 MB of sodium-native to replace about 100–150 lines. Its last release was October 2024. A 128-bit secret sent inside Noise does the same job in about 20 lines (R30).
  - `hyperswarm` connected in 15–24 ms on the testnet. It is UDP only, so it fails on the networks ssh exists for. It is deferred to P2, as an opt-in "no Tailscale on either side" pathway with Noise inside, at about 13 MB of native code.
- **Q15. The review's open proposals. Decided by the owner (2026-11-22):**
  - **C2, plans:** kept as designed: shared plans with owners and per-version agreement, plus sent plans (R17–R22e).
  - **C3, what is pushed:** only relevant updates, under the ~400-token cap (R15a). The overlap heads-up (R15d) is promoted to P0 as the main push signal and ships in M1.
  - **C4, task bridge:** stays P0 (R23–R24a). It works for anyone who enables the Task tools, and the room list works without them.

## Appendix A. Evidence

These findings come from five parallel surveys of the 0.8.1 tree (2026-11-22). Sources in the repo:
- **Architecture and design:** `docs/archive/ARCHITECTURE-0.8.md`, `plugin/sub-human/README.md`, `plugin/sub-human/lib/cc/contract.json` (101 entries).
- **Adversarial review (2026-11-22):** five reviews (overengineering and prior art, design flaws, platform feasibility, network and security, product and UX) plus the Q11 and Q14 spikes. All applied, with the owner's Q15 decisions.
- **Design reviews:** `docs/next/quiet/{PRINCIPLES,COPY,GOAL-REVIEW,EVALUATION,WORTH}.md`, `docs/next/ROOM-PLAN.md`.
- **Claude Code internals notes:** `docs/internals/cc-2.1.302.md`.
- **Open issues:** #8, #9, #12, #15, #20, #21, #34–#39.
- **Live scenario findings:** the October 2026 orchestration runs. Gaps: no task dependencies, no done notices, invisible subagents, stale plan versions on tasks.
