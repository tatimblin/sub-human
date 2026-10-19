# sub-human

**Subagents, but for humans.** A Claude Code plugin that puts you and the people you work with in one room, each with
your own Claude.

[![CI](https://github.com/tatimblin/sub-human/actions/workflows/ci.yml/badge.svg)](https://github.com/tatimblin/sub-human/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Status: beta](https://img.shields.io/badge/status-beta-orange.svg)

Everyone keeps their own terminal, repo, login and Claude. sub-human joins your sessions into a room: you can talk to
each other, your Claudes can message each other, you can share a task list, and you can work out a plan together that
each of you signs off on yourself. It works on one machine or across machines, over ssh or the web, with no server in
between.

![Two machines in one sub-human room: jess joins tristan's room from her laptop with an invite line and a PIN, her Claude drafts a room plan that she checks first, it opens for tristan in his own plan view, both sign off, and the tests pass for both after each Claude builds its half](docs/media/sub-human-readme-loop.webp)

## Why

Claude Code is great with one person and many agents. But most software is built by a few people, and when each of us
has a Claude, the people and the Claudes still coordinate by copying and pasting between chats. sub-human makes
Claude Code's own subagent machinery (rows in the agent panel, messages between sessions, plan mode, the task list)
work across people.

**How it differs** from other ways to share Claude Code:

- **Not one shared session.** Nobody types into someone else's Claude. Each person keeps their own, with their own
  files, permissions and account.
- **Not a context export.** The room is live: posts, plans and tasks show up as they happen.
- **Only you can agree for you.** A plan version is signed off per person, in that person's own plan view. No Claude
  can sign off, or post your words, for you.
- **No server.** A room lives on the machine that opened it. Other machines reach it over ssh, or over the web through
  your own Tailscale (or HTTPS front). There is no telemetry.

## Install

```
/plugin marketplace add tatimblin/sub-human
/plugin install sub-human@sub-human
```

Then restart Claude Code. You need Claude Code 2.1.292+, Node 22.18+ or 24.3+, and macOS or Linux.

## Try it alone first

Open two Claude Code sessions in the same folder, in two terminals. In the first:

```
/sub-human
```

You get a room code like `vole-8126`, and your name comes from git. In the second, join under another name:

```
/sub-human bob
```

Now `@room hello` in one shows up in the other, and the room's row in the agent panel shows who is in it.

## Use it

```
@room did anyone touch the auth middleware?     # posts your exact words to everyone; no model runs
```

Then just talk to your own Claude:

- "Ask bob's Claude what it changed in the parser." Claudes message each other directly.
- "Let's write a room plan for cursor paging." Your Claude writes it in plan mode. You check it first, then everyone
  is asked to sign off on that version in their own plan view. Edits make new versions, and nothing is overwritten.
- "Put the parser tests on the room list, I've got it." The room has one shared task list, and only a task's owner
  can complete it.

Planning is optional. There's no required workflow: the room just tells your Claude who is here and how to reach them.

## Bring in another machine

On the machine with the room (the host):

```
/sub-human invite
```

It shows an invite line and a 4-digit PIN under your prompt, where your Claude can't see them. Send the line, and
tell them the PIN another way (say it). On their machine, they type the line with the PIN after it:

```
/sub-human join https://box.tail1a2b.ts.net/sub-human/vole-8126#4f9k2m8q… 4829
```

and they're in. Your room shows who joined, from which machine, with a check you can compare, and
`/sub-human kick NAME` if it isn't them. The line without its PIN asks you instead, on a card. An invite works once,
for 15 minutes.

`/sub-human invite` goes over your tailnet when Tailscale is up, else over ssh. `--public` uses Tailscale Funnel for
someone off your tailnet. If they can already ssh to your account, they need no invite: `/sub-human join dev vole-8126`.

## Other commands

```
/sub-human               who is here, and how to invite
/sub-human leave         leave the room (the session stays open)
/sub-human kick NAME     end someone's connection
/sub-human doctor        check your setup when something breaks
/sub-human help          everything else
```

## Good to know

- The room lives on the machine that opened it. If that machine sleeps, the room is down until it's back. Posts from
  other machines queue for a few minutes and go out when it returns.
- The room keeps a small background Claude Code session on the host, which holds the shared task list and the panel
  rows. Its model runs one short turn when the room opens and when someone joins, and is idle otherwise.
- Everyone in a room should run the same sub-human version. `/sub-human doctor` shows yours and the host's.
- Invite lines and PINs never reach any Claude.

## Beta

sub-human works, but it's young. Known limits:

- macOS and Linux only.
- No relay: two laptops behind NAT need Tailscale, or an ssh login to one of them.
- It relies on some Claude Code internals (each listed, and checked nightly against new Claude Code releases), so a
  Claude Code update can break something before a fix ships. `/sub-human doctor` says what.

If something breaks or confuses you, please [open an issue](https://github.com/tatimblin/sub-human/issues/new/choose)
with `/sub-human doctor`'s output. If you want someone to try a room with, ask in
[Discussions](https://github.com/tatimblin/sub-human/discussions).

## More

- [plugin/sub-human/README.md](plugin/sub-human/README.md): the full docs, with every command and option.
- [SECURITY.md](SECURITY.md): what sub-human protects, what it doesn't, and how to report a vulnerability.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how it works.
- [CONTRIBUTING.md](CONTRIBUTING.md).

MIT licensed. See [LICENSE](LICENSE).
