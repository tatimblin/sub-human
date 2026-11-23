# sub-human

Live, zero-effort sharing of work between Claude Code sessions.

Several people each work in their own Claude Code session, with their own terminal, repo, login and Claude. sub-human
keeps each of you, and each of your Claudes, up to date with what the others' sessions learn, decide and change, as it
happens. Nobody writes a status update, and nobody copies between chats.

- Your Claude learns, by your next prompt, what a colleague changed that bears on your work: a file you touched, an
  interface a plan you're on names, a line that names you.
- Your status line shows who is here, what each is working on, your open room tasks, and how many updates came in.
- Your Claude can ask a colleague's Claude a question directly; the answer comes back after your turn, not in the
  middle of it.
- Plans you write in plan mode can be shared, agreed version by version, or sent to someone.
- A room task list, with claims, sits beside your own native task list.

## Install

In Claude Code:

```
/plugin marketplace add tatimblin/sub-human
/plugin install sub-human@sub-human
```

sub-human needs Node 22.18+ or 24.3+ on the machine (it runs TypeScript directly, with no build step) and Claude
Code's hooks modules, which are on by default. It was tested on Claude Code 2.1.330.

## Commands

```
/sub-human [NAME]    join the room open here, or open one (as NAME)
/sub-human invite    bring in someone from another machine
/sub-human who       who is here and what each is doing
/sub-human tasks     the room's tasks
/sub-human leave     leave the room; your session keeps going
```

Also:
- `/sub-human ROOM` joins that room by its code (`vole-8126`); `NAME` and `ROOM` may come in either order. With
  several rooms open, a bare `/sub-human` lists them.
- `/sub-human join LINE` joins a room on another machine, from the line its host sent you.
- `/sub-human news` opens what each colleague changed and found since you last looked, and clears the count.
- `/sub-human kick NAME` removes a member for good; `/sub-human doctor` checks this machine; `/sub-human help` lists
  the commands.
- `@room TEXT` at your prompt posts your exact words to the room as yours; your Claude never sees it, and one line
  says it went. Start with a name (`@room bob, which port does the server use?`) to address one person: a line of
  yours naming someone is the one thing you type that can start their Claude's turn. Nothing that looks like a secret
  is sent.

Your name is your git name unless you give one. The others' Claudes reach yours as `NAME.CODE` (`bob.vole-8126`).
Leaving keeps your session going. Ending a session doesn't leave: you show as away until a session of yours comes
back. A room with nobody left in it closes, and one nobody has used for 30 days is deleted.

## Working together on one machine

Each person types `/sub-human` in their own session. The first opens a room; the others join it, whatever repo each
is in. That's all: from then on your work is shared as you do it.

## Inviting someone from another machine

The machine that opened the room is its host. To bring someone in:

```
/sub-human invite jess            a public https:// line (the default)
/sub-human invite jess --tailnet  a line only your tailnet can reach
/sub-human invite jess --ssh      a line over jess's own ssh login to this machine
```

You get one line to send to jess. It works once, for 15 minutes, and only for the name you gave. Jess types it in her
Claude Code:

```
/sub-human join https://your-mac.tail1234.ts.net/vole-8126#…
```

Jess sees a short check string at once, to tell you. You get a card naming jess, her machine and the same check
string, with **Let in** and **Refuse**: compare the two, then answer. Once you let her in, her session takes its place
in the room by itself, and she sees one line saying so. If someone
else uses the line too, nobody gets in with it and you are told, with a one-key removal if it had already let someone
in.

**Over Tailscale.** Only the host needs Tailscale. A public line (Tailscale Funnel) works for a joiner with nothing
but the plugin: no Tailscale and no account. A tailnet line (Tailscale Serve) works only on your tailnet. The
connection is a WebSocket over HTTPS, so it gets through corporate proxies, and the joiner's `HTTPS_PROXY` is
honoured. If Funnel or Serve is off for your tailnet, the invite names the admin page that turns it on.

**Over ssh.** For networks that block Tailscale. The joiner connects through any account they have on the host
machine, with their own ssh config, agent and `known_hosts`. Nothing is written to `authorized_keys`, and nobody logs
in as you. The host's sshd must allow TCP forwarding (`AllowTcpForwarding yes`), which `doctor` checks.
`SUB_HUMAN_SSH_ADDR` sets the address others use to reach this machine.

While the host is away (asleep, or its last session ended), the room waits and the others see `host away` on their
status line and in `/sub-human who`. Their own updates are kept and go out when the host is back.

## What is shared

Joining a room is the opt-in: what follows is shared while you're in one, and nothing once you leave.

- **Activity**, with no model call: the files you edit, your branch, commits and pushes, test and build runs with
  whether they passed, and whether you're working or idle.
- **Updates in your Claude's own words**: at the end of a turn that learned or changed something a colleague would
  want (an interface change, a cause found, a decision, work finished), your Claude may share one short line. It is
  always labelled as your Claude's, never as yours.
- **Your focus**: one line your Claude keeps current, shown in `who`.
- **Plans** you choose to share, and **room tasks**.

What is never shared:

- anything that looks like a secret (a curated pattern list, from gitleaks), and secret-holding files (`.env*`,
  `*.pem`, keys, credentials);
- files your repo ignores (its top-level `.gitignore`), and files outside the repo;
- file contents, beyond a short excerpt your Claude chose to quote.

Messages between two Claudes are private to them: they never go into the room's history, on any machine.

**What reaches your Claude.** Only updates that bear on your work go to your Claude, beside your next prompt, marked
as data from a named colleague and capped at about 400 tokens. The rest is counted on your status line and waits for
`/sub-human news`, or for your Claude to ask for the catch-up. Nothing in the room starts a turn by itself except
three things: a person's line naming you, a colleague's Claude messaging yours directly, and an answer to your
Claude's own question. Even then it waits for your turn to end and is framed as a colleague's request, and a message
that carries a command or URL to run is shown to you instead of handed to your Claude.

## Plans

Write plans in plan mode, as you do alone. When you approve one, you're asked once:

- **Keep it**: it stays yours, and nothing is shared.
- **Room plan**: it's stored in the room, and you pick who should agree.
- **Send to NAME** (or the room): it goes, whole, to that person, with your branch, the files it names and a note.

A room plan is versioned. Every version is kept, and an edit made on an old version is refused so the two can be
merged. A part that names an owner (`## Store (owner: tristan)`, `- @jess the HTTP handler`) becomes a task once the
plan is agreed, and each owner's Claude learns its part and who owns the rest.

**Reviewing.** When someone asks you to agree, you see one line, and at the end of your turn a card with a summary of
what changed since the version you last saw: **Agree**, **Ask for changes** (type your note), or **Read the full
plan**, which opens a scrollable pane with the whole text and the diff. A plan sent to you opens the same way, with
**Accept** (your Claude takes it as its plan) or **Dismiss**. Only your answer on the card counts; no Claude agrees
for its person, and an answer applies to that one version. Reviewing never touches your own plan file or your
permission mode.

## Tasks

The room has a small task list. Anyone adds a task; you claim one for yourself (refused while someone else has it);
only its owner releases it or marks it done. A task can wait on others, and when one you're waiting on is done or released,
your Claude hears of it. `/sub-human tasks` lists them, and your Claude has a task tool.

Your own native task list stays yours and works as it does alone. If you launch Claude Code with
`CLAUDE_CODE_ENABLE_TODO_TOOLS=1` (Claude Code's own setting, which sub-human never sets), two more things happen: your
native task changes are shared as activity, and a room task you claim goes onto your native list tagged
`[room CODE#N]`, so completing or deleting it there completes or releases the room task. Without that variable the
room list works on its own.

## Privacy and threat model

sub-human has **no server and no telemetry**. A room lives on its host's machine and on each joined machine's copy,
and travels only over the connections you set up (Tailscale or ssh), inside an encrypted channel (Noise XK) keyed to
the host's own key.

The threat is **outsiders**: someone not in the room reading it, writing to it, or pretending to be the host. An
invite line can't be guessed, is bound to one name, works once, soon expires, and only reaches the real host. Nobody
gets in without the host's **Let in**. Each machine that joins proves a key of its own, and `kick` ends its access for
good.

**Inside a room, members and their Claudes are trusted collaborators.** sub-human labels who wrote what (a person or
their Claude) honestly, but that is a label, not a security boundary. Text planted in a repo could reach your Claude
through a colleague's; the framing, the rule on commands and URLs, and an hourly wake budget limit what it can do,
but don't make it impossible. Invite only people you'd let work on your project. No hook of sub-human's ever answers a
permission check for you: every permission decision stays yours.

The host holds the room's history and applies every write, so everyone who joins trusts the host.

## When the hooks module is off

sub-human runs as a Claude Code hooks module. Where hooks modules are off (a managed machine's policy, or an older
Claude Code), nothing would be shared, so `/sub-human` and `/sub-human join` join no room and say so in one line, and
`/sub-human news` and `/sub-human doctor` say so too. The others never see such a session as here.

## Doctor

`/sub-human doctor` checks this machine, one line each, `ok` or `fix` with what to do: Node, sub-human's home folder,
the hooks module in your sessions, the Claude Code version sub-human was checked on (and any other version your
sessions run), every room's history, sshd's TCP forwarding, and Tailscale. A setting with a bad value is listed too.

## Settings

All optional, as environment variables:

| Variable | What it does |
|---|---|
| `SUB_HUMAN_NAME` | your default name in a room |
| `SUB_HUMAN_INVITE` | the default invite: `public`, `tailnet` or `ssh` |
| `SUB_HUMAN_SSH_ADDR` | how others reach this machine over ssh |
| `SUB_HUMAN_PORT` | the local port the host listens on (one is picked if unset) |
| `SUB_HUMAN_HOME` | where sub-human keeps its files (default `~/.sub-human`) |
| `SUB_HUMAN_CC_OFF` | `wake`, `messages` or `tasks-bridge` (comma-separated) off, if a Claude Code release breaks it |

sub-human never writes your Claude Code settings files and never pins a model.

## More

The design is in the repository: `docs/PRD.md`, `docs/ARCHITECTURE.md` and `docs/TESTING.md`. Report a security
issue privately (see `SECURITY.md`). MIT licensed.
