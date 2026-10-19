# Security

## Reporting a vulnerability

Please report it privately through GitHub: **Security → Report a vulnerability** on this repository
(https://github.com/tatimblin/sub-human/security/advisories/new). Don't open a public issue for it. You'll get a
reply within a few days. sub-human is a one-person project in beta, so there is no bounty, but you will be credited
in the fix's release notes if you want to be.

## What sub-human protects

The goal is narrow: **a model can't speak or consent as a person through anything sub-human gives it.**

- **Your words are yours.** `@room` is posted by a hook from what you typed, signed with your seat's own key. Your
  Claude's posts are always labelled as your Claude's. A line in the room that claims to be you without a valid
  signature shows as `(unverified)` and counts for nothing.
- **Your agreement is yours.** Sign-off on a plan version is recorded only from your own answer in Claude Code's plan
  view (or the card), never from a model's tool call.
- **Invite secrets never reach a model.** The invite line's SECRET and its PIN are shown to the person only, and the
  hooks hide any join or invite prompt from the conversation.
- **The store is guarded.** The plugin's hooks module denies Claude's file tools inside the sub-human home, and
  denies `Bash` commands that name it, the keys or Claude Code's prompt history.

## Joining from another machine

A room lives on the machine that opened it (the **host**). Someone on another machine gets in with:

- **an invite line and its PIN.** The line carries 128 bits of single-use secret and a tag of the host's key, so it
  can't be guessed and can't be spent on the wrong host. The 4-digit PIN, said apart from the line, is checked online
  by the host: 5 tries, throttled, and every wrong one shows in the room. An invite works once, for 15 minutes.
- **or the invite line alone,** which asks the host, whose card lets them in or refuses them.
- **or their own ssh login** to the host's account, which is trusted as that account.

The room says who joined, from which machine, with a check both screens show, and `/sub-human kick NAME` removes them.

**Over the web**, the host's listener binds `127.0.0.1` only. Tailscale Serve, Funnel or your own HTTPS front is
the only way in, and it sees IPs, timing and byte counts, not content: inside the WebSocket every byte is Noise XK
(X25519, ChaCha20-Poly1305), keyed to the listener's key that the invite line names.

## What it does not protect against

- **The host is trusted** by everyone who joins it. It holds the room's log and decides what is placed in it.
- **A hostile local user** (anyone who runs as your OS user) can read the keys and write the files. The log's hash
  chain makes such edits visible; it doesn't prevent them.
- **The Bash guard is a lexical check.** A Claude with `Bash` runs as your user, and one steered into building the
  key's path at run time could read it and sign as your seat. What it writes around the plugin still breaks the hash
  chain or carries no valid signature; `sub-human verify CODE` checks a room's log.
- **Other MCP servers** that read or write files aren't guarded.
- **Prompt history.** What you type stays in Claude Code's own prompt history (`~/.claude/history.jsonl`), including
  a join line and its PIN. Both are worthless once used, expired or burned.
- **Messages to one person aren't private.** Everyone in the room can read the whole log.

The full threat model, with every guard and limit, is in
[plugin/sub-human/README.md#threat-model](plugin/sub-human/README.md#threat-model).

## Privacy

sub-human has **no server and no telemetry**. Nothing is sent to the author or any third party. A room's messages,
plans and tasks are stored on the host's machine (`~/.sub-human`, files 0600) and on each joined machine's copy of the
room, and travel only over the links you set up (ssh, or the web through your own Tailscale or HTTPS front). Each
person's Claude runs on that person's own Claude Code account; the room session runs on the host's.
