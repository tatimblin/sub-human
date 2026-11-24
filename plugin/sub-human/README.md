# sub-human

Live, zero-effort sharing of work between Claude Code sessions.

Several people each work in their own Claude Code session, with their own terminal, repo, login and Claude. sub-human
keeps each of you, and each of your Claudes, up to date with what the others' sessions learn, decide and change, as it
happens. Nobody writes a status update, and nobody copies between chats.

- Your Claude learns, by your next prompt, what a colleague changed that bears on your work: a file you touched, an
  interface a plan you're on names, a line that names you.
- The dim hint line under your prompt ends with the room, who is in it and what each is doing, and the one thing that
  needs you next:

  ```
  Room ● bob ○ carol
  Room ◐ bob · plan "finish-webography" needs your review (+2)
  ```

  `●` working, `○` idle, `◐` waiting on a permission prompt, `◌` away; `Room empty` with nobody else in it. Then,
  most urgent first: a plan waiting on your review, a plan sent to you, messages held for you (`/room news`), a task
  of yours now free to start; `(+N)` says how many more. Only the terminal draws that line.
- Your Claude can ask a colleague's Claude directly and hears back after your turn. Plans made in plan mode can be
  shared, agreed version by version, or sent; a room task list sits beside your own.

## Install

```
/plugin marketplace add tatimblin/sub-human
/plugin install sub-human@sub-human
```

sub-human needs Node 22.18+ or 24.3+ on the machine (it runs TypeScript directly, with no build step) and Claude
Code's hooks modules, which are on by default. It was tested on Claude Code 2.1.330. Then each person types `/room`
in their own session: the first opens a room, and the others on that machine join it, whatever repo each is in. From
then on your work is shared as you do it.

## Commands

```
/room [NAME]            join the room open here, or open one (as NAME)
/room invite NAME       bring in NAME from another machine
/room join LINE [NAME]  join a room on another machine, from the line its host sent
/room who               who is here and what each is doing
/room tasks             the room's tasks
/room leave             leave the room; your session keeps going
```

- `/room ROOM` joins that room by its code (`vole-8126`); `NAME` and `ROOM` may come in either order. With
  several rooms open, a bare `/room` lists them.
- `/room news` opens what each colleague changed and found since you last looked, and clears the count.
- `/room kick NAME` removes a member for good; `/room doctor` checks this machine; `/room help` lists the commands.
- `@room TEXT` at your prompt posts your exact words to the room as yours; your Claude never sees it. Start with a
  name (`@room bob, which port does the server use?`) to address one person: a line of yours naming someone is the
  one thing you type that can start their Claude's turn. Nothing that looks like a secret is sent.

Your name is your git name unless you give one. The others' Claudes reach yours as `NAME.CODE` (`bob.vole-8126`).
Leaving keeps your session going. Ending a session doesn't leave: you show as away until a session of yours comes
back. A room with nobody left in it closes, and one nobody has used for 30 days is deleted.

## Inviting someone from another machine

The machine that opened the room is its host. To bring someone in:

```
/room invite jess            a public https:// line (the default)
/room invite jess --tailnet  a line only your tailnet can reach
/room invite jess --ssh      a line over jess's own ssh login to this machine
```

You get one line to send to jess. It works once, for 15 minutes, and only for the name you gave. Jess types it in her
Claude Code:

```
/room join https://your-mac.tail1234.ts.net/vole-8126#…
```

Jess sees a short check string at once, to tell you. You get a card naming jess, her machine and the same check
string, with **Let in** and **Refuse**: compare the two, then answer. Once you let her in, her session takes its place
in the room by itself, and she sees one line saying so. If someone else uses the line too, nobody gets in with it and
you are told, with a one-key removal if it had already let someone in.

**From the row above the prompt.** While you're the only one in a room you host, a row above the prompt reads
`Room vole-8126 created. Invite: [ public ] [ tailnet ] [ ssh ]` (`created` only in the session that opened it).
Pick one and name the person: the row then shows the line, the time it works until, **copy** (`c`) and **cancel**,
which takes the line back so it lets nobody in. The row goes once anyone else is here. Clicks
work in fullscreen; otherwise ctrl+x then tab puts you in the row.

**Over Tailscale.** Only the host needs Tailscale. A public line (Tailscale Funnel) works for a joiner with nothing
but the plugin: no Tailscale and no account. A tailnet line (Tailscale Serve) works only on your tailnet. The
connection is a WebSocket over HTTPS, so it gets through corporate proxies, and the joiner's `HTTPS_PROXY` is
honoured. If Funnel or Serve is off for your tailnet, the invite names the admin page that turns it on.

**Over ssh.** For networks that block Tailscale. The joiner connects through any account they have on the host
machine, with their own ssh config, agent and `known_hosts`. Nothing is written to `authorized_keys`, and nobody logs
in as you. The host's sshd must allow TCP forwarding (`AllowTcpForwarding yes`), which `doctor` checks.
`SUB_HUMAN_SSH_ADDR` sets the address others use to reach this machine.

While the host is away (asleep, or its last session ended), the room waits and the others see `host away` on their
status line and in `/room who`. Their own updates are kept and go out when the host is back.

## What is shared

Joining a room is the opt-in: what follows is shared while you're in one, and nothing once you leave.

- **Activity**, with no model call: the files you edit, your branch, commits and pushes, test and build runs with
  whether they passed, and whether you're working or idle.
- **Updates in your Claude's own words**: at the end of a turn that learned or changed something a colleague would
  want (an interface change, a cause found, a decision, work finished), your Claude may share one short line. It is
  always labelled as your Claude's, never as yours.
- **Your focus** (one line your Claude keeps current, shown in `who`), **plans** you choose to share, and **tasks**.

Never shared: anything that looks like a secret (a curated pattern list, from gitleaks); secret-holding files
(`.env*`, `*.pem`, keys, credentials); files your repo's top-level `.gitignore` ignores, and files outside the repo;
file contents, beyond a short excerpt your Claude chose to quote. Messages between two Claudes are private to them:
they never go into the room's history, on any machine.

**What reaches your Claude.** Only updates that bear on your work go to your Claude, beside your next prompt, marked
as data from a named colleague and capped at about 400 tokens. The rest waits for `/room news`, or for your Claude to
ask for the catch-up. Nothing in the room starts a turn by itself except three things: a person's line naming you, a
colleague's Claude messaging yours directly, and an answer to your Claude's own question. Even then it waits for your
turn to end and is framed as a colleague's request, and a message that carries a command or URL to run is shown to
you instead of handed to your Claude.

## Plans

Write plans in plan mode, as you do alone. When you approve one, you're asked once, **Share this plan?**:

- **No**: keep it local; nothing is shared.
- **Get agreement**: share it for input and approval. It's stored in the room, and a second card asks who should
  agree (pick them, or type names under Other).
- **Send to the room**: share it without waiting on approval. A second card asks who gets it (anyone here, or
  everyone in the room; type a name under Other for someone not listed), and it goes, whole, with your branch, the
  files it names and a note.

A room plan is versioned and named by the first three words of its heading that say something
(`finish-webography-click`). Every version is kept, and an edit made on an old version is refused so the two can be
merged. A part that names an owner (`## Store (owner: tristan)`, `- @jess the HTTP handler`) becomes a task once the
plan is agreed, and each owner's Claude learns its part and who owns the rest.

**Waiting for agreement.** When you ask people to agree on a room plan, your Claude waits: it doesn't start building
until the plan is decided. Once everyone agrees, it is woken to build its part. If someone asks for changes, it is
woken with their note, word for word, to revise the plan; when you approve the revision, the same people are asked
again. A room plan with nobody asked, a kept plan and a sent plan wait for nothing.

**Reviewing.** When someone asks you to agree, you see one line, and, at the end of your turn or right away if you are
idle, a card with a summary of what changed since the version you last saw: **Agree**, **Ask for changes** (type your
note), or **Read the full plan**, which opens a scrollable pane with the whole text and the diff. A plan sent to you
opens the same way, with **Accept** (your Claude takes it as its plan) or **Dismiss**. Only your answer on the card
counts; no Claude agrees for its person, and an answer applies to that one version. Reviewing never touches your own
plan file or your permission mode.

## Tasks

The room has a small task list. Anyone adds a task; you claim one for yourself (refused while someone else has it);
only its owner releases it or marks it done. A task can wait on others, and when one you're waiting on is done or
released, your Claude hears of it. `/room tasks` lists them, and your Claude has a task tool.

Your native task list stays yours. With `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` (Claude Code's own setting, which
sub-human never sets), your native task changes are shared as activity, and a room task you claim goes onto your
native list tagged `[room CODE#N]`, so completing or deleting it there completes or releases the room task.

## Privacy and threat model

sub-human has **no server and no telemetry**. A room lives on its host's machine and on each joined machine's copy,
and travels only over the connections you set up, inside an encrypted channel (Noise XK) keyed to the host's own key.
The threat is **outsiders**: an invite line can't be guessed, is bound to one name, works once, soon expires and only
reaches the real host; nobody gets in without the host's **Let in**, and `kick` ends a machine's access for good.

**Inside a room, members and their Claudes are trusted collaborators.** Who wrote what (a person or their Claude) is
an honest label, not a security boundary. Text planted in a repo could reach your Claude through a colleague's; the
framing, the rule on commands and URLs, and an hourly wake budget limit what it can do, but don't make it impossible.
Invite only people you'd let work on your project. No hook of sub-human's ever answers a permission check for you,
and everyone who joins trusts the host, which applies every write. More in `SECURITY.md`.

## When the hooks module is off, and doctor

Where hooks modules are off (a managed machine's policy, or an older Claude Code), nothing would be shared: `/room`
and `/room join` join no room, they and `news` and `doctor` say so in one line, and the others never see you here.

`/room doctor` checks this machine, one line each, `ok` or `fix` with what to do: Node, sub-human's home folder, the
hooks module in your sessions, the Claude Code version sub-human was checked on (and any other version your sessions
run), every room's history, sshd's TCP forwarding, and Tailscale. A setting with a bad value is listed too.

## Settings

All optional, as environment variables; sub-human never writes your Claude Code settings files and never pins a model.

| Variable | What it does |
|---|---|
| `SUB_HUMAN_NAME` | your default name in a room |
| `SUB_HUMAN_INVITE` | the default invite: `public`, `tailnet` or `ssh` |
| `SUB_HUMAN_SSH_ADDR` | how others reach this machine over ssh |
| `SUB_HUMAN_PORT` | the local port the host listens on (one is picked if unset) |
| `SUB_HUMAN_HOME` | where sub-human keeps its files (default `~/.sub-human`) |
| `SUB_HUMAN_CC_OFF` | `wake`, `messages`, `tasks-bridge` or `invite-band` (comma-separated) off, if a Claude Code release breaks it |

## More

The design is in the repository: `docs/PRD.md`, `docs/ARCHITECTURE.md` and `docs/TESTING.md`. Report a security
issue privately (see `SECURITY.md`). MIT licensed.
