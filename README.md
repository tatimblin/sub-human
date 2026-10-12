# sub-human

Pair up with others in Claude Code as native subagents

Everyone keeps their own terminal, repo and Claude. sub-human puts you in a room together. You can chat, your
Claudes can message each other, and a shared Claude can help plan or keep a task list. It works on one machine or
across machines, over ssh or the web.

## Install

```
/plugin marketplace add tatimblin/sub-human
/plugin install sub-human@sub-human
```

Then restart Claude Code. You need Claude Code 2.1.292+, Node 24.3+, and macOS or Linux.

## Use it

Open a room:

```
/sub-human
```

You get a room code like `vole-8126`, and your name comes from git. Anyone else on the same machine runs
`/sub-human` too and they're in.

In the room:

```
@room did anyone touch the auth middleware?     # message everyone
@claude split this into tasks for dana and me   # ask the room's Claude
```

Your Claude knows who's in the room and can message their Claudes directly ("ask dana's Claude what it changed").
If someone proposes a plan that involves you, it opens for you to approve. Nobody's Claude can agree for you.

## Bring in another machine

If you can already `ssh` to the machine with the room:

```
/sub-human join dev vole-8126
```

Otherwise, have the host make an invite:

```
/sub-human invite
```

That prints a line with a 4-digit PIN. Send it to the other person and they paste it:

```
/sub-human join me@devbox vole-8126 4829
```

The host gets a prompt to let them in, and then they run `/sub-human` to take their seat. The invite works once, for
15 minutes. Use `--web` or `--public` to invite over Tailscale instead of ssh.

## Other commands

```
/sub-human leave           leave the room
/sub-human kick NAME       disconnect someone
/sub-human handoff NAME    hand hosting to someone else
/sub-human doctor          check your setup when something breaks
/sub-human help            everything else
```

## Good to know

- The room runs on the machine that opened it. If that machine sleeps, the room is down.
- PINs and invite lines never reach any Claude.
- The room's Claude only does something when you `@claude` it. An idle room costs nothing.
- There's nothing to build and no dependencies. Node runs the plugin's TypeScript directly.

The full docs are in [plugin/sub-human/README.md](plugin/sub-human/README.md), and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how it works.
