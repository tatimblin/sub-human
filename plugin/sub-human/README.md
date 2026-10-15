# sub-human

A Claude Code plugin for working together from separate sessions, on one machine or, with a link, from others. You join a room with one command and keep working however you like. Your Claude learns who is in the room and how to reach them, and nothing else is prescribed: no workflow, no required plan.

- **`@room`** posts your exact words to the room. A hook posts them, so no model paraphrases them. **`@claude`** posts them the same way and also wakes the room's Claude.
- **Claudes talk to each other natively,** with Claude Code's own `SendMessage` and `ListAgents`, addressed `NAME.CODE`.
- **The room's own Claude** (member `claude`, a background session) starts with the room. It keeps the room's shared task list, and it helps plan only when someone asks. It messages people only when they addressed it or when its own action needs telling.
- **Consent is yours.** When a proposal names you, it opens in Claude Code's own plan view in your terminal, all of it scrollable. Only your answer there records agreement. No Claude can give it.

How it is built: [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md).

## Install

From this repo, without installing, add `--plugin-dir plugin/sub-human` to `claude`. Or install it through the bundled marketplace:

```
claude plugin marketplace add /path/to/sub-human
claude plugin install sub-human@sub-human
```

**Requirements.** Claude Code 2.1.292 or newer with function hooks on (not `--bare`, not safe mode, and no policy that turns hooks off): the plugin's hooks module guards the store, checks who typed an `@room` and delivers the room, so `/sub-human` refuses to join without it. Node 24.3 or newer on `PATH`: every hook, the room MCP server, the room tail and the row status line run `node`. macOS or Linux only (the row launcher is a POSIX shell script and the store relies on POSIX rename and file modes); Windows is not supported. `claude plugin validate plugin/sub-human` checks the plugin. Accept workspace trust for your folder: the room's Claude starts in your working directory, and Claude Code refuses to start a background session in an untrusted folder.

**Updates.** Marketplace plugins don't update by themselves by default: enable auto-update for the sub-human marketplace in `/plugin` (Marketplaces), or run `/plugin update sub-human` now and then. Everyone in a room should run the same version; `/sub-human doctor` shows yours and, for a room hosted elsewhere, the host's protocol version.

## Start: three commands

```
/sub-human                      # open a room (or join the one open here) as your git name
/sub-human invite               # a line for someone on another machine; it shows the room and a 4-digit PIN
/sub-human join dev vole-8126   # on a machine that can ssh to dev: join that room there
```

`/sub-human help` lists every command (words after it are ignored). In a room, a bare `/sub-human` says who is here and how to invite.

## Join: one command

In your normal Claude Code session:

```
/sub-human
```

When no room is open, the join hook creates one (say `vole-8126`, the **room**) and starts the room's Claude as a background session titled `claude.vole-8126`. An idle room's Claude costs nothing. A join that works says so in one dim line, `sub-human: opened room vole-8126 as tristan · on this machine others join with /sub-human; another machine: /sub-human invite` (the next person sees `joined vole-8126 as dana, with tristan · @room to talk, @claude to ask the room's Claude`); your session is titled `tristan.vole-8126` and the room's row `vole-8126` appears in your agent panel.

**How replies show.** `/sub-human` answers in place of the command, as dim `sub-human: …` lines: help, who is here, `left vole-8126 · /sub-human joins again`, an invite, a refusal. They never reach your Claude (so it neither repeats them nor sees a PIN), and a command that only replies leaves no row of what you typed. Nothing reads "blocked by hook". A refusal starts with `✗` and says what to type next, or to run `/sub-human doctor`. Typed through Remote Control, where those lines don't show, a reply with no secret in it is the command's own output instead. The next person on this machine runs `/sub-human` too, and adds the room (`/sub-human dana vole-8126`, or just `/sub-human vole-8126` or `/sub-human join vole-8126` as their git name) only when more than one room is open.

**Your name.** With no name typed, it is your git `user.name` (the repo's, else your global one): its first word, lowercased, with only letters, digits, `.`, `_` and `-` kept (`Tristan Timblin` → `tristan`). With no `user.name`, the part of your git `user.email` before the `@`; with neither, `$USER`. A name that is taken in the room is refused with how to pick one: `/sub-human NAME`. A typed name always wins: `/sub-human alice`, or `--as NAME` on a join. Command words (`invite`, `join`, `kick`, `leave`, `doctor`, `help`, `admit`, `handoff`, …) are never names, and nor is a word of digits (`/sub-human 4829` says it looks like a PIN).

The hook binds your name to your session before the model sees anything, so your Claude can never pick or change it. Your identity survives `/clear`, compaction and `--resume`. The command shows as `/sub-human:sub-human` in the picker; typing the bare `/sub-human` works. `/sub-human leave` leaves the room and keeps the session open (no `/exit`).

## Join from another machine

A room lives on the machine that opened it, its **host**. If you can already ssh to the host's account (your own second machine, a dev box you log in to), join with that login. Anyone else joins with the one line the host's `/sub-human invite` shows, and the host's card lets them in.

### If you can already ssh to the host: `/sub-human join HOST ROOM`

On your other machine:

```
/sub-human join dev vole-8126                    # an alias from your ~/.ssh/config (its User, HostName, Port, ProxyJump)
/sub-human join you@machine-a vole-8126
/sub-human join you@devbox:2222 vole-8126 --via bastion   # a port, a jump host (ProxyJump)
/sub-human join you@devbox vole-8126 --home /srv/sh       # the host's sub-human home is not ~/.sub-human
/sub-human join dev vole-8126 --as carol                  # a name other than your git name
```

That is the whole step: no invite, no PIN, no card. It links the machine and takes your seat at once; later rejoins are a bare `/sub-human` (or `/sub-human carol vole-8126`). Your login to that account is the admission, since whoever can run commands there could make an invite anyway. The room shows `a machine linked over your SSH login`.

- **Your own ssh.** The link runs `ssh -T -o BatchMode=yes [-J JUMP] [-p PORT] -- you@machine-a '"$HOME"/.sub-human/bin/serve --stdio vole-8126 --link ID --login'` with your keys, agent, `~/.ssh/config` and `known_hosts`, checked as usual. It never prompts. When ssh does not know the host's key yet, the join stops at once and says so: run `ssh you@machine-a` once in a terminal, check and accept the key, then join again. A login that needs a password is refused the same way. Behind an MFA bastion, run `node <plugin root>/scripts/sub-human prime vole-8126` in a terminal (the refusal prints the full line) and then `/sub-human`.
- **On the host** this runs the stable serve shim (`<home>/bin/serve`, see [SSH details](#ssh-details)), which records where node is, because a non-interactive ssh shell lacks nvm's or Homebrew's `PATH`. Opening or joining a room on the host writes the shim when it is missing. If it is still missing, the join says `me@devbox isn't set up for joining yet`: open the room there in Claude Code, then join again.
- **Not through a restricted key.** A key the host's card let in runs a forced command fixed to its one link, and that line never carries `--login`. The host's `serve --login` also refuses to run under any forced command (sshd's `SSH_ORIGINAL_COMMAND`). So a key restricted to one link can't make itself a new one.
- `kick`, `doctor`, the link state, the outbox and handoffs work as for any link. `/sub-human kick carol` stops the link, but that login can link again: to shut it out, take its key out of `authorized_keys`.

Three transports exist: **SSH** (the other machine reaches the host's account), **the web** (a URL and a PIN, through Tailscale or any HTTPS front of yours; see [Join from anywhere: Tailscale](#join-from-anywhere-tailscale)) and the **pipe** (a second sub-human home on the same machine, another `SUB_HUMAN_HOME`; what the tests and the demo use, `/sub-human invite --pipe`). Host on a machine that stays awake (a dev box): when the host sleeps, the room is down for everyone.

### Inviting someone: `/sub-human invite`

On the host, in a session that is in the room:

```
/sub-human invite                           # over ssh to this machine: SUB_HUMAN_SSH_ADDR, else you@hostname
/sub-human invite --ssh me@devbox.local:2222   # or name the address
/sub-human invite --ssh me@devbox --via bastion   # the joiner reaches it through a jump host (ProxyJump)
/sub-human invite --ssh devbox              # an ssh alias: the line says devbox; the joiner's ~/.ssh/config resolves it
/sub-human invite --web                     # over the web: see Join from anywhere: Tailscale
```

```
sub-human: invite to room vole-8126 for one machine, over ssh me@devbox.local. It works once, for 15 minutes; send them this line:
sub-human:   /sub-human join me@devbox.local vole-8126 4829
sub-human: The 4-digit PIN is the whole secret: send the line privately, or send it without the PIN and say the PIN. After 5 wrong PINs it stops working.
sub-human: When they type it, a card here asks you to let them in; nothing gets in before you answer.
sub-human: Sent it to the wrong place? /sub-human invite --cancel 3f9c2a1b7e0d cancels just this invite.
```

These dim lines are shown to you, never to your Claude, and your `/sub-human invite` itself leaves no row. With no address given (no `--ssh`, no `SUB_HUMAN_SSH_ADDR`), the invite also says that it used this machine's own name (a Mac's `.local` name reaches only the same local network) and how to give another, and, when this machine takes no ssh logins (on a Mac, Remote Login is off in System Settings → General → Sharing), that their ssh will fail and `/sub-human invite --web` is the other way. The joiner types exactly that line; it carries no name (theirs comes from their git name, or `--as NAME`). The invite is for one machine and one use; the **PIN is its whole secret**, so treat the line like a password: a direct message, or say the PIN. `sub-human invite [--room ROOM] [--ssh [USER@HOST]] [--via JUMP]` prints the same in a terminal outside Claude Code; inside Claude Code (its `!` mode) it masks the PIN, because that output becomes part of the conversation. An address that still has an example's placeholder (`NAME@…`, `USER@…`, `YOU@…`) is refused.

When they type it, **your Claude Code shows you a card**: `Let carol (SHA256:ab12…) on carols-mbp join room vole-8126? — Let in / Refuse` (`carols-mbp` is what her machine calls itself: its short host name, or `SUB_HUMAN_MACHINE_LABEL` there; never proof of anything). Only your answer there admits them: your Claude can't answer it, and the answer is signed with your seat key. The fingerprint is the key their machine just made for this link; their screen shows the same one, so you can compare. **Let in** writes one `authorized_keys` line that lets that key reach only this room's server, as one link, and their link connects within seconds. **Refuse** ends it. Unanswered, the request lapses after 10 minutes. `/sub-human admit` lists who is waiting and `/sub-human admit REF` lets one in, as the card does; with no session open on the host, `sub-human admit` in a shell does the same (y/N first, `--refuse` to say no).

`/sub-human invite --cancel` cancels the open invite (with several open, it lists them: `/sub-human invite --cancel REF`).

### Joining: `/sub-human join HOST ROOM PIN`

On the other machine, the line the host sent you:

```
/sub-human join me@devbox.local vole-8126 4829
/sub-human join https://box.tail1a2b.ts.net/sub-human/vole-8126 4829   # over the web: the URL holds the room
```

This step only links the machine to the room, and the hook hides the prompt from the conversation, so the PIN never reaches your Claude (the same for any `join`, `invite` or `admit` prompt, or one with a word of digits, whatever is wrong with it). Your machine and the host check the PIN against each other without sending it (a PAKE, see the threat model); your machine checks it reached the real host, makes a key of its own for the link (over ssh), and the host's card asks its person. The join says what to do next:

- `the host's machine checked your PIN. A card there now asks them to let you in as carol (SHA256:ab12…). This session tells you when they do; then type /sub-human to join`. The link keeps trying for 10 minutes. When the host lets you in, the same session shows one dim line, `the host let you in to room vole-8126: type /sub-human to join it as carol` (or why the join stopped). The bare `/sub-human` (no PIN in it) takes your seat; if the host has not answered yet, it says so.
- **A wrong PIN:** `✗ could not join room vole-8126: wrong PIN (4 tries left). Check the digits with the host, then type the join line again`; a rejoin never re-sends a refused PIN. After the fifth, `this invite no longer works. Ask the host for a new one`.
- **The line without its PIN:** `/sub-human join HOST ROOM` with no PIN is the join over your own ssh login (above), and says so; if ssh refuses that login, the reply adds that an invite's line ends with its 4-digit PIN. From a second sub-human folder on the same machine (`pipe:…`), which has no login path, it says the line lost its PIN.
- **Refused or lapsed:** the link stops with `the host refused to let this machine in` (or `did not let this machine in in time`); ask for a new invite.
- **Someone in between:** over ssh, if the server that answered shows another host key than the one the host vouched for inside the PIN's handshake, the join stops (`the ssh server that answered is not the one that holds your PIN`) and sends nothing more. Check with the host.

The join starts a **link** on that machine: a small background process (`sub-human link CODE`) that keeps a copy of the room (a mirror) and carries that machine's posts and answers to the host. After that, everything works as on the host: `@room`, rows, proposals in the plan view, tasks. Your words are signed on your machine and checked on the host. The host runs the room's Claude and decides proposals.

- **Rejoin** (a new session on the same machine) with `/sub-human` (or `/sub-human carol vole-8126`). The link is kept, and started again if it had stopped; you need no new invite.
- **When the link is down**, your session shows one dim line, `the connection to room vole-8126 is down (…)`. An `@room` is queued (`⧗ queued`, up to 50 posts for up to 9 minutes) and sent in order once the link is back; one that waited too long is not sent, and you are told with its words. An answer to a proposal is never queued: it is not recorded and you are told so. The link retries on its own, and at once after your machine wakes or changes network.
- **When the link is slow** (the host has not answered within 2 s), an `@room` says `⧗ sending (slow connection)`: it is on its way and shows in the room when the host has it, so don't type it again. An answer that gets no reply in time says it is not confirmed: if the proposal still shows you unanswered later, answering again is safe.
- **The link stops by itself** about a minute after no session of that machine is left in the room.
- **Versions.** The two machines agree on a protocol version when the link connects. When they share none, the join says which side must update, e.g. `host runs sub-human 0.5.0 (protocol 3–4); you run 0.4.0 (protocol 1–2). Update your plugin: /plugin update sub-human`. Update the host first: a host takes joiners one version older.

### Join from anywhere: Tailscale

For friends who have no SSH account on your machine. The host runs [Tailscale](https://tailscale.com) (the joiners need it only for the tailnet-only default). On the host, in a session that is in the room:

```
/sub-human invite --web            # Tailscale Serve: people on your tailnet (or a node you shared) only
/sub-human invite --public         # Tailscale Funnel: anyone with the URL and the PIN (opt-in)
/sub-human invite --url https://my.front/sh   # any HTTPS front of yours that forwards to 127.0.0.1:7420
/sub-human invite --stop           # stop serving this room over the web
```

```
sub-human: invite to room vole-8126 for one machine, over the web through Tailscale Serve (your tailnet only) to this machine's listener on 127.0.0.1:7420. It works once, for 15 minutes; send them this line:
sub-human:   /sub-human join https://box.tail1a2b.ts.net/sub-human/vole-8126 4829
sub-human: The 4-digit PIN is the whole secret: send the line privately, or send it without the PIN and say the PIN. After 5 wrong PINs it stops working.
sub-human: When they type it, a card here asks you to let them in; nothing gets in before you answer.
```

The joiner types that line; your card lets them in, as over ssh; then a bare `/sub-human` takes their seat. No secret is in the URL, and the URL already names the room.

What happens:

- `/sub-human invite --web` starts **the listener** (`sub-human listen`, one per home, on `127.0.0.1:7420` only, `SUB_HUMAN_LISTEN_PORT` or `--port` to change it) and runs, with the `tailscale` on your `PATH` or `/Applications/Tailscale.app/Contents/MacOS/Tailscale`:

  ```
  tailscale serve --bg --https=443 --set-path=/sub-human/vole-8126 http://127.0.0.1:7420
  ```

  `--public` runs `tailscale funnel` with the same flags instead. The name comes from `tailscale status --json` (your node's MagicDNS name). `/sub-human invite --stop`, and the room closing, turn off that one path (`tailscale serve --https=443 --set-path=/sub-human/vole-8126 off`) and nothing else; it never runs `serve reset`. Tailscale's HTTPS certificates and Serve (and, for Funnel, the Funnel attribute) must be enabled for your tailnet. When they are not, `tailscale serve` prints an enable URL and waits; sub-human stops it at that URL (or after 10 s) and says: `Tailscale Serve isn't enabled on your tailnet yet. An admin turns it on once at <URL> (or Admin console → DNS → HTTPS Certificates and Serve), then run /sub-human invite --web again.` Tailscale not running, stopped or logged out is named as such. The first HTTPS connection to a new ts.net name waits ~20 s while Tailscale issues its certificate: the host fetches it right after `serve` (one background request), a joiner's WebSocket waits up to 45 s (`SUB_HUMAN_WS_CONNECT_MS`), and the link keeps trying after that.
- **Funnel is public.** Its hostname is published in public certificate-transparency logs, so anyone can find your node's name. Anyone who finds it can spend the PIN's tries (5, then the invite burns), never get in without the PIN and your card; the host shows that warning each time.
- The joiner's link connects with a WebSocket (through `HTTPS_PROXY` / `https_proxy` when set, honouring `NO_PROXY`: a corporate network that allows only `CONNECT` to port 443 works). The first connection runs the PIN's PAKE in text frames: in it the host vouches for the listener's X25519 key and hands over a one-time secret, both readable only by the one who knows the PIN. From then on every connection is an end-to-end **Noise_NK** channel pinned to that key. Tailscale, Funnel's relays or your front see the PAKE's public values, then Noise ciphertext; the PIN itself never travels.
- **The card is the admission.** The PIN proves only that the joiner has it; your Let in admits the machine, and the room line `carol's machine (…) linked to the room, let in by alice (link …)` records it. `/sub-human kick carol` ends such a link as any other.
- The listener runs one `serve --stdio CODE` per connection through the stable shim, like an SSH forced command. It survives a sleep; after a reboot, the host's next join starts it again. `sub-human listen --status` shows its pid, port and the rooms it serves (also in `<home>/listen/state.json`); `--stop` stops it.
- **Any HTTPS front.** `--url https://my.front/prefix` names a reverse proxy of yours (Caddy, nginx, a NetBird or ZeroTier address with a certificate) that forwards `/prefix/sub-human/CODE` WebSocket upgrades to `127.0.0.1:7420`. The joiner's machine must trust its certificate (a public CA, or `NODE_EXTRA_CA_CERTS`).

### Ending someone's connection: `/sub-human kick NAME`

On the host, `/sub-human kick carol` (in a session in the room) or `sub-human kick carol [--room ROOM]` in a shell ends the connection carol joined over: its token stops working, its `authorized_keys` line is removed, its seats leave the room, its running server stops, and the room shows a line. On the other machine the link stops for good (`the host revoked this link`): it does not keep retrying, and `@room` posts there are refused, not queued. A joiner still waiting for your card is withdrawn the same way.

**One leaked invite.** An invite nobody has used yet is not a connection. `/sub-human invite --cancel REF` (the ref is printed under the line; 12 hex characters, not a secret) cancels that one invite, with a room line; every other invite and connection stays, and the room stays served (`/sub-human invite --stop` stops serving the whole room over the web). An invite already used cancels the connection it became.

### SSH details

- **The enrollment door.** While an ssh invite is open, `authorized_keys` also holds `command="SUB_HUMAN_HOME=… …/.sub-human/bin/serve --enroll vole-8126 --kind ssh",restrict ssh-ed25519 AAAA… sub-human-enroll:vole-8126`. Its key is the room's public enrollment key (derived from the room; see the threat model): it runs only the PIN's PAKE. The line goes once no ssh invite of the room is live. The joiner's ssh to it uses that key, a fresh known_hosts with `StrictHostKeyChecking=accept-new` and Ed25519 host keys only, so it can compare what it was shown with the key the host vouches for. An ssh invite needs the host's sshd to have a readable Ed25519 host key.
- **Forced command.** The line the card's **Let in** writes is `command="SUB_HUMAN_HOME=… …/.sub-human/bin/serve --stdio vole-8126 --link 1a2b3c4d5e6f",restrict ssh-ed25519 AAAA… sub-human:vole-8126:1a2b3c4d5e6f`. Whatever the other side asks to run, that key runs only this room's server, for that one link (`restrict`: no shell, pty or forwarding), and the server accepts only that link's token. `<home>/bin/serve` is a stable shim that finds the current plugin install and node when it runs, so the line keeps working after a plugin update or a node upgrade. Paths are absolute because sshd's `PATH` has no Homebrew. The file is `~/.ssh/authorized_keys`, or `SUB_HUMAN_AUTHORIZED_KEYS`. `sub-human doctor --fix` rewrites lines sub-human 0.2 wrote (a versioned node and plugin path) to name the shim.
- **The joiner's ssh.** The link runs `ssh -T -o BatchMode=yes … -i <link key> -o IdentitiesOnly=yes -o UserKnownHostsFile=<link known_hosts> -o StrictHostKeyChecking=yes -o HostKeyAlias=sub-human-CODE [-J JUMP] -- me@devbox.local`. A jump host is reached with your own `~/.ssh/config` and agent (a host alias works as `--via`). An invite names only a plain `user@host[:port]` and jump hosts: it can't carry an ssh option or a command. `SUB_HUMAN_SSH_OPTS` (space-separated, in the joiner's own environment) adds ssh options, to the `ssh -G` that reads a bare alias's user too (a `-F FILE` there is the config both read); it is meant for tests and unusual setups.
- **MFA bastions.** `sub-human prime CODE [--persist 8h]`, on the joining machine, opens one shared connection interactively (answer the MFA prompt once), and the link rides it (`ControlPath <home>/ssh/cm-%C`). The link itself never prompts (BatchMode) and never opens a shared connection of its own; with none open it connects as usual.

### Moving the host before you close your laptop

The host's machine holds the room's log, serves the links and runs the room's Claude, so when it sleeps the room goes offline. Before you close it, hand the room to someone else in it who is on another machine:

```
/sub-human handoff bob                       # bob's machine reachable as a second home here (pipe)
/sub-human handoff bob bob@bobs-box.local    # the others reach bob's machine over SSH
/sub-human handoff bob bob@bobs-box --via bastion   # through a jump host (ProxyJump), as invite --via
```

(`sub-human handoff bob [USER@HOST[:PORT] | --ssh USER@HOST[:PORT]] [--via JUMP] | --url https://FRONT` in a terminal does the same. Over SSH each member's link follows with its own key and its `prime` setting and pins bob's host key; until bob lets that machine in, it is offline with a line that says to ask bob for an invite. With `/sub-human handoff bob https://bob-box.tail1a2b.ts.net`, or `--url`, the others follow bob over the web: his machine serves the room on its listener and every invite it sends them pins its listener key; bob then runs `/sub-human invite --web` once to put the Tailscale path in front of it.) Bob's Claude shows him a card: **Host room CODE on this machine?** It says plainly that the room's Claude will then run on **his** model account (his Claude or Bedrock billing and rate limits) and that his machine must stay on and reachable. Nothing moves unless he chooses **Host it here** himself; **Not now** leaves everything as it was, and you see `room handoff: bob declined`. The ask lapses after 10 minutes.

When he agrees:

1. The log records `host_changed` at the next **host epoch**, with his signed acceptance and your signed ask. Everyone sees "room CODE moved to bob's machine".
2. The room's Claude stops on your machine and a new one starts on his machine. It rebuilds from the room's tasks and log; nothing of the old session moves.
3. Your machine becomes a member: it mirrors his and your session goes on as before.
4. Every other member's link gets, over its existing connection, a single-use invite to bob's machine meant only for that machine, with its seats already bound, and reconnects there. These invites never appear in the log, and no PIN is needed because the old link is already authenticated.

If someone's machine can't reach bob's (a laptop behind NAT, an SSH key bob's machine doesn't know), their link goes offline with a message that says so and what to do. Nothing hangs: posts are refused at once, as with any offline link. Bob runs `sub-human handoff --status` to see who hasn't reconnected and gives that person an invite (`/sub-human invite`); they type its line, bob's card lets them in, and a bare `/sub-human` joins their seat again over the new link. Over SSH every member needs bob's machine to let their key in, so it is easiest when bob's machine is a dev box everyone can already reach.

**There is no automatic failover**: two machines each deciding they host the room would split it. If the host is gone for good (the laptop died, not just asleep), a member whose machine has a full copy can take over by hand, in their own shell:

```
sub-human promote CODE --confirm CODE [--ssh ME@MY-BOX]
```

It refuses while the link to the host is still online, and until the host has been unreachable for 10 minutes (`--force` skips the wait). It prints what it risks first. **Promote can fork the room**: if the old host was only asleep, whatever it writes from then on reaches nobody, and lines it wrote that this copy never got are lost to the room. It prints one line per other machine, `sub-human demote CODE INVITE PIN`: hand them out yourself, each with its PIN some other way; each works only on its own machine. A member runs its line in a terminal, then `/sub-human` in its session. When the old host comes back, its owner runs its line too: that keeps its own log aside in `orphaned-<time>.jsonl` (never merged) and makes it a member of the new host. A copy that reaches the old host after the move is refused there (`STALE`), so the two never quietly merge.

## Rows

Your agent panel gets one row named after the room, with the other people nested inside it:

```
● main
◯ vole-8126   tasks 1 open · #2 bob
```

- **Enter** on the room row opens it. Each person is a row inside it. Enter on one shows that person's own words and their Claude's posts, labelled separately.
- **↑ then Enter** goes back up a level.
- Rows are read-only views. If you type into one, it answers `read-only row — type in main with @room` and nothing is posted.
- After `--resume` or `--continue`, your rows come back by themselves within a few seconds.

While the rows run, Claude Code prints **"✻ Waiting for N background agents to finish"** after each turn, where N counts your rows. This is expected. Your prompt is still free, and nothing is stuck. Setting `"showTurnDuration": false` in your own settings hides the line, along with "Worked for 12s". The plugin never writes your settings.

## Watching the room's Claude

The room's Claude takes no typed input. Every input it gets is attributed: a room entry, a Claude's `SendMessage`, or a task request.

- In the agent view (**←**), it shows as `claude.vole-8126` with its last status. **Space** peeks: its panel lists one row per person, and **ctrl+t** shows the room's task list. **Enter** attaches.
- If you type into it, the prompt is refused with `the room's Claude takes no typed input; type @claude in your own session, or ask your Claude to message claude.vole-8126`. Slash commands are refused too.
- `claude logs <id>` and `sub-human watch claude` show it read-only.
- About half a minute after the last person leaves, the room's Claude is stopped.

## Saying something to the room: `@room` and `@claude`

```
@room bob, can you take the parser tests? handler's in src/tasks.ts
@claude let's plan cursor paging
```

Two tags, both at the very start of the prompt:

- **`@room …`** posts your words to everyone. It never wakes the room's Claude.
- **`@claude …`** posts your words to everyone too, addressed to `claude`, and wakes the room's Claude.

Either is posted **verbatim** as your words (`via=human`). No model turn runs, and the receipt is one line that says who reads it:

```
❯ @room ship the cursor paging today
⏺ ✓ sent to room vole-8126 (Claude wasn't asked)
❯ @claude plan cursor paging with me
⏺ ✓ sent; the room's Claude will answer
```

If your Claude Code shows it as "Operation stopped by hook: ✓ sent …", that is the same receipt: nothing went wrong.

- Only a leading tag counts. `@room ask @claude later` is a plain post that wakes nothing, and so is `@room @claude …`.
- Outside a room, `@claude …` is an ordinary prompt to your own Claude.
- Spaces, unicode, `$`, backticks and quotes arrive byte-exact. For multiline input, use `\` + Enter or Ctrl+J.
- Typing `@room` opens the file picker, and a space closes it. Don't press Tab.
- Check a prompt suggestion before you accept it. A suggested `@room …` or `@claude …` line is your Claude's wording, and accepting it posts it as yours.
- Your Claude reaches the room's Claude with `SendMessage` at `claude.CODE`.

Anything else you type goes to your own Claude. Its posts are labelled as your Claude's (`via=agent`) and never count as your words.

**The room reads like a group chat.** When someone else posts, everyone else's session shows their exact words, with no ids and nothing added:

```
  sub-human: bob: sure, once we've agreed how paging works
```

A Claude's post shows as `bob's Claude: …`, a join as `bob joined`, a leave as `bob left (session ended)` or `bob left (connection lost)`. The plugin writes these lines into your session itself, as dim notices that stay there (also after `--resume`). They cost no model turn: your Claude doesn't repeat them, and it gets a copy to read with its next request. A leave shows only after 8 s away, so a quick leave and rejoin shows nothing.

Every person's own words reach everyone. A Claude's post reaches you when it is addressed to you or mentions `@you`, and a proposal naming you opens for you to read and answer: those wake your Claude with a prompt from the plugin ("Prompt from the sub-human plugin"), or join its current turn if it is busy. Everything else reaches your Claude as a short "Room since your last turn" note it reads with its next request. Your room row also reads `+bob joined` or `−bob left` for two minutes.

**On your phone (Remote Control).** The phone shows your session's prompts and replies, not the dim notices. So once you type in the session from Remote Control, the plugin sends what would have been a notice there as a short prompt of its own holding just those lines (`alice: hi`, `room: "Rate limiting" agreed (bob)`): room lines, batched to at most one every few seconds, and a refusal of your `@room` (a post that went through shows nothing more). Each one is a model turn; your Claude is told it needs no reply. Typing at the terminal again turns it off. A proposal's plan view works on the phone too: a bare **Deny** records nothing. A note (**Suggest edits**, or "Tell Claude what to change" at the terminal) is never sent by itself, because a message you type on the phone right after a Deny lands there too: a card asks `Send to alice as changes requested on "…": "…"?`, and only your **Send** records the objection with that note (**Discard** records nothing; reopen the proposal any time).

**Claude to Claude.** Ask your Claude to "ask alice's Claude what the cursor format is". It calls `SendMessage` to `alice.vole-8126`, and alice's pane shows `› Message from @bob.vole-8126: …`. Those messages come from Claudes, not people. Native `SendMessage` only reaches sessions on the same machine, so when alice is on another machine the plugin posts the message to the room addressed to her instead (`bob's Claude (to alice): …`); it wakes her Claude the same way, and her Claude's `SendMessage` back to `bob.vole-8126` returns the same way. `ListAgents` lists only the Claudes on your machine.

## Agreeing to a proposal

Anyone can propose something. Tell your Claude "propose this" (a plan from your own plan mode, a file under your working directory or your Claude Code plans, or some text), or ask the room's Claude to plan. The proposal names its approvers, by default the people in the room. If you opened the room and sit in it again from another machine over your own ssh login (`/sub-human join USER@HOST ROOM`), your seats count as one approver: the answer you give last, from either, is yours, and the decision names one seat ("agreed: tristan (also laptop)"). Seats that joined by invite are each their own person, and so is every other seat on the host itself, since people can share a machine.

When a proposal names you, your Claude opens it in Claude Code's plan-approval dialog, the same view your own plans use. The plugin's hooks put the real proposal there, byte for byte, whatever your Claude wrote:

```
 Ready to code?
 Here is Claude's plan:
 ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
  Plan: cursor paging for GET /tasks
  …
  │ room proposal 3fa2c1d0e9b8 from alice, for bob (PgUp/PgDn scroll). Agree: "Yes, manually approve edits"
  │ keeps your mode. Object: "Tell Claude what to change" + why. Esc: decide later.
 ❯ 1. Yes, and use auto mode
   2. Yes, manually approve edits
   3. Tell Claude what to change
```

**PgUp** and **PgDn** scroll the whole proposal, however long.

| You do | Recorded |
|---|---|
| A **Yes** option | Your sign-off on that exact hash (`via=human`). |
| **Tell Claude what to change**, then type why | Nothing yet: a card asks `Send to alice as changes requested on "…": "…"?`. **Send** records your objection, with your words byte for byte; it blocks the proposal. **Discard** records nothing. |
| **Esc**, or Ctrl+G edits before a Yes | Nothing. |

Your mode is never changed by a review. Showing the proposal briefly enters plan mode without asking, and the hooks put you back in your own mode afterwards with no dialog: at once after an answer, or on your next prompt after Esc. A "Yes" that names another mode is set back too; the one the hint names keeps it without that extra step. Agreeing is not a go-ahead to build: your Claude does not carry the proposal out.

Say "show me the proposal" and your Claude opens it again. With several waiting, name the one you mean ("open the v3 one", or its hash): the hooks open the one your own last words name, else the newest, never one your Claude chose. When everyone named has agreed, the room logs a `decision`. A revision replaces the earlier proposal when the same person proposes it with the same title while the earlier one is undecided: the earlier one stops waiting, and answers given on it do not carry over. Room lines name a proposal by title and short hash (`"Ship v3" (3fa2c1)`), and a revision says what it replaces. The same title from someone else is a separate proposal, and the Claude proposing it is warned.

**The card, as a fallback.** When the plan view can't be used, a question card opens instead (Not yet / Agree / Object, **n** adds a note): when you are already in plan mode yourself, in bypass or don't-ask mode, when `showClearContextOnPlanAccept` is on (that approval path clears the context and starts building), or for a proposal over 200,000 characters. The card shows the proposal beside the options when it fits (up to 2,000 characters and about 20 lines), otherwise a summary and the path. Not yet, Esc, "Chat about this" or no answer record nothing.

Planning is optional. Use your own plan mode and "propose this", type `@claude let's plan cursor paging`, or don't plan at all.

## Shared tasks

The room has one shared task list: the native Claude Code task list of the room's Claude. Your private task list stays private.

- Tell your Claude "put the parser tests on the room list, I've got it". It calls the room's `task` tool (`add`, `claim`, `release`, `done`), which replies `queued; the room's Claude applies it`. The room's Claude applies pending requests in one batch.
- Only a task's owner can complete it, with evidence ("12/12 pass, see #15"). A request from anyone else is refused, and the task stays open.
- Your room row shows the summary (`tasks 3 open · #2 you · #4 bob`). `sub-human tasks` lists them, and `sub-human tasks --json` gives the same list as JSON.
- While the room's Claude is not running, the room task list is unavailable, and `task` says so.

## The `sub-human` CLI

`plugin/sub-human/scripts/sub-human` reads the room. Inside a room session it finds your room by itself. It never posts as anyone; only the host's connection commands (`admit`, `kick`, `invite --cancel`) add a line from the room itself. It lives in the plugin's `scripts/`, not `bin/`: claude.ai rejects a plugin with a top-level `bin/` when an organization distributes it, so the CLI is not on the Bash tool's `PATH`. Claude reads the room with the room MCP tools; in your own shell, run it by its path (`node <plugin root>/scripts/sub-human …`) or alias it.

| Command | Prints |
|---|---|
| `read` | The room log. |
| `digest` | The room's current state in a few lines. |
| `who` | People, the room's Claude and their presence. |
| `watch NAME` | NAME's thread: their own words, their Claude's posts (labelled), and their answers to proposals. |
| `tasks [--json]` | The room's shared task list. |
| `invite [--room ROOM] [--ssh [USER@HOST[:PORT]]] [--via JUMP]` | An invite line (`/sub-human join DEST ROOM PIN`) as `/sub-human invite` shows it; over ssh to this machine by default. |
| `invite [--room ROOM] --web \| --public \| --url URL [--port P]` | The same over the web: the listener, Tailscale Serve (or Funnel) or your own front, and a URL with its PIN. |
| `invite --stop`, `invite --cancel [REF]` | Stop serving a room over the web (its own Tailscale path goes off); cancel an invite nobody used. |
| `listen [--port 7420] \| --start \| --stop \| --status` | The host's web listener (127.0.0.1 only); `/sub-human invite --web` starts it for you. |
| `admit [REF [--refuse] [--yes]]` | The join requests waiting for you (no REF), or let one in (asks y/N) or refuse it: the card, for a host with no session open. |
| `kick NAME [--room ROOM] [--file F]` | End NAME's connection: token burnt, key line removed, its seats leave. |
| `prime CODE [--persist 8h]` | On a joining machine: one shared SSH connection, opened interactively, for an MFA bastion; the link rides it. |
| `link CODE [--reset \| --forget [--force]]` | Run the link to room CODE hosted elsewhere (in the foreground; joins start it in the background). `--reset` copies the room again after a FORK. `--forget` drops a closed room from this machine for good (never done automatically: the host can open it again): the copy moves to `rooms/CODE.forgotten-<time>` and the link is removed. It needs the link stopped because the room closed or no seat is left (`--force`: any stopped link). |
| `handoff NAME [--ssh USER@HOST[:PORT] \| --url https://FRONT]`, `handoff --status` | Ask NAME to host the room (their card decides); who hosts it at which epoch, and who hasn't reconnected. |
| `promote CODE --confirm CODE [--force]` | This machine's copy becomes the room, when its host is gone for good. Can fork the room. |
| `demote CODE INVITE PIN` | Follow a promoted room with the line promote printed for this machine (an old host also sets its own log aside). |
| `doctor [--quick] [--fix] [--bundle [FILE]]` | What is wrong on this machine, with a fix for each (see **Doctor**). |

`tail` (the room tail), `agent-statusline` (the rows) and `serve --stdio CODE` (the host's end of a link) are internal. Run `invite`, `admit`, `kick`, `prime`, `listen`, `link`, `serve`, `handoff`, `promote` and `demote` (and `doctor --fix`) in a terminal outside Claude Code: the plugin refuses them to a Claude, and Claude Code's `!` mode would put their output (an invite, a PIN) into the conversation, so there `invite` and `promote` mask the PIN.

## Doctor

When something is off, type `/sub-human doctor` in the session (read only), or run `node <plugin root>/scripts/sub-human doctor` in your shell, on either machine. Each line is ✓ (fine), ! (a warning), ✗ (broken) or · (for your information), and a broken or doubtful one has a `fix:` line under it:

```
✓ node                v24.15.0
✗ sub-human folder    ~/.sub-human is 755
                      fix: node ~/.claude/plugins/…/sub-human/scripts/sub-human doctor --fix in a terminal (or chmod 700 ~/.sub-human)
! connection vole-8126  ssh me@devbox:22 · daemon running (pid 4242) · ✕ offline 2m · 2 queued · last error: Permission denied (publickey)
                      fix: the host refused this machine's key: it was never let in, or the host removed it. ask the host for a new invite (/sub-human invite) and type the line it shows
```

A fix that only a shell can make prints the CLI by its full path (`node <plugin root>/scripts/sub-human …`): no `sub-human` command is on your PATH.

It checks:

- the plugin's version, and Node 24.3 or newer;
- that the home and its directories are private (0700);
- that the SSH serve shim (`<home>/bin/serve`) and its pointer name a plugin install and a node that still exist;
- `authorized_keys` lines from sub-human 0.2 that bypass the shim (they break on the next plugin or node update); `--fix` rewrites them;
- `ssh` and its version;
- every link to a room hosted elsewhere: its transport, whether its daemon runs, its state and last error, and a quick hello to the host (with a timeout) that shows whether the host is reachable, whether ssh works without prompting (BatchMode), both sides' protocol versions and, when the host sends its time, how far your clocks differ;
- your Claude Code version against the one sub-human's internals were checked on (and, when it differs, the internals themselves);
- settings that turn hooks off;
- the web listener, when this machine serves a room over the web: running, its pid and port, the rooms it serves; with Tailscale, that `tailscale serve status` still lists each room's path, and with Funnel a warning that the name is public (certificate-transparency logs). A link over the web gets its hello through the real WebSocket and pinned Noise channel;
- whether Remote Control (the phone) is likely to work. It needs a claude.ai subscription login and isn't available with Bedrock (`CLAUDE_CODE_USE_BEDROCK`), Vertex or an API key; that is only a note, the room works the same.

`--quick` skips the hello and the internals check. `--fix` (in a terminal only) rewrites the shim and its pointer, closes the home's modes and rewrites this home's older `authorized_keys` lines. `--bundle [FILE]` writes the same report as JSON for a bug report, redacted: it holds versions, settings, check results, link states and recent link errors, never a message; paths under your home become `~`, room codes, host names, user names and IP addresses are hashed, and SSH keys, tokens and invites are removed (a key is cut to a fingerprint prefix). Read it before you attach it.

The room row shows the link too, in a room hosted elsewhere, in the same words as `doctor`, the tail and `~/.sub-human/links/CODE.state.json` (online, connecting, offline, stopped, fork): `✕ offline 2m · 2 queued`, `… connecting (3)`, `✕ stopped` or `✕ out of step: /sub-human doctor` first while it is not online, and `⇄ online` at the end while it is.

## The room tail

In a session that has joined a room, the plugin's hooks module runs one `node` child, `sub-human tail`, for the session's life: it follows the room's log and hands each new line to the module, which shows it, gives your Claude its copy, or wakes it. The child restarts by itself if it exits, and stops when the session ends or leaves. A session that never joins a room starts no child.

## Settings worth knowing

- **Your own `subagentStatusLine` hides the row text.** The rows' text (who said what, tasks, presence) comes from the plugin's `subagentStatusLine`. Claude Code lets any `subagentStatusLine` in your user, project or local settings, or one passed with `--settings`, override a plugin's, so with one set the rows show your status line instead. Remove it (or run it only outside rooms) to get the room text back.
- **Bypass mode.** In `--dangerously-skip-permissions` (bypass) mode, Claude Code holds incoming `SendMessage`s from other sessions behind a dialog until you answer it. The join message warns you. Use a normal permission mode in a room if you want other Claudes' messages to reach yours without a dialog.

## Room storage

Everything the plugin keeps lives in `~/.sub-human/` (rooms, seats, seat keys in `keys/`, the row launcher in `bin/row-status`, the SSH serve shim in `bin/serve`), or in `$SUB_HUMAN_HOME` when that is set. Set it the same way for every session that should share rooms: sessions with different homes never see each other, except through a link (see **Join from another machine**). Rooms live in `<home>/rooms/<CODE>/`. Each has an append-only JSON-lines log. Every entry carries `from`, `via` (`human`, `agent` or `system`), `kind` and a `prev` hash of the previous line, so edits are visible. Proposals are stored by hash in `plans/`, the task mirror in `tasks.json`, and row state in `rows/`. On a machine that joined a room hosted elsewhere, `<home>/links/<CODE>.json` is the link (with its token; file 0600) and `<home>/links/<CODE>.log` its log; `rooms/<CODE>/` there is the mirror, written only by the link.

## Threat model

The security model is one machine, one OS user, per room: everyone on the host is a trusted collaborator running as that same user, so names aren't defended against forgery between people. **The host is trusted** by everyone who joins it: it holds the room, places every entry and decides proposals. The goal is narrower: **a model can never speak or consent as a person**. That covers any member's Claude, including one steered by text someone posted in the room. It can't forge an entry with `via=human`, and it can't hide one.

- Agreement and objection come only from the plan view or the card, which the human answers. A plan text edited before "Yes", answers that come with the model's call, an AFK timeout or a stale hash are dropped. The only dialog-free exit the hooks allow records nothing.
- Your words reach the room only through `@room` and `@claude`, posted by a hook. Your Claude's posts are always labelled `via=agent`. `SendMessage` between sessions is Claude to Claude.
- **Seat keys.** Each seat gets an Ed25519 key pair when it joins, stored in `<home>/keys/<CODE>/` (directory 0700; `NAME.key` and `NAME.pub` 0600). The join writes the public key into the room's log, which pins it: a name is its key for the room's life, and a later join under that name with another key is refused (a lost key means a new name). Every `via=human` entry is signed with the seat's private key. The signature covers what was said, the room, a random nonce and a timestamp, not the entry's place in the log; the store refuses a nonce it has already placed and a timestamp more than 10 minutes off. Only hook processes load that key, and Claude Code runs hooks itself; a model never does. The room MCP server, the CLI and the room tail never load it, so they can't write `via=human` at all; the store refuses the append. Readers check the signature against the pinned key. A `via=human` line without a valid signature shows as `bob (unverified): …`, and consent never counts it. Logs from before keys were pinned still read: their signatures check against the local `NAME.pub`, and an unsigned answer from a seat with no key still counts, marked unverified. A room that pins any key never counts an unsigned answer.
- **Who typed it.** The plugin's hooks module reads the origin Claude Code itself stamps on each prompt (only your own Enter, `-p` or Remote Control count as typed) and drops an `@room` (or, in a room, an `@claude`) that you didn't type (from another session, a notification, another plugin) before any hook runs. It hands that origin to the hook that signs the post together with a secret nonce the module makes for your session and keeps in its lease file (`<home>/sessions/mods/`, 0600). The hook posts only when the origin is typed and the nonce matches the lease; a post whose origin it can't see or trust is refused, and you type it again. Forging one takes reading that lease file, which the guards below deny by path.
- **`@room` fails closed.** If the module's hook for the prompt fails in any way, an `@room` (and, in a room, an `@claude`) is refused with a short notice. It is never passed on to your Claude as an ordinary prompt.
- **Store guard.** The plugin's function hooks module (`mod/guard.ts`, Claude Code 2.1.292+) denies `Write`, `Edit`, `MultiEdit` and `NotebookEdit` into the store (`~/.sub-human` or `$SUB_HUMAN_HOME`, checked lexically and after resolving symlinks), so a Claude can't edit the log with its file tools. It runs in-process on every such call, so it costs no process start, and it learns where the store is from the plugin itself when the session starts. It also lets joined sessions use the room tools without a prompt, and refuses `hold` to anything but a row agent. It never answers a tool call in a way that skips other hooks: your own and other plugins' `PreToolUse` hooks still run on the room tools. Where function hooks are off (`--bare`, safe mode, a policy that turns hooks off) a session can't join a room.
- **Bash guard.** The same module checks every `Bash` command and denies one that:
  - names the store (its path, `~/.sub-human`, `$HOME/.sub-human`, the keys under it);
  - names or sets `SUB_HUMAN_HOME`;
  - runs the plugin's own modules or hooks with `node`, `bun`, `deno` or `npx` (`lib/room*`, `lib/identity`, `lib/proposal`, `hooks/*.ts`, `hooks/handlers/*.ts`, `mcp/*.ts`, and their `.js` names of earlier versions).

  The read-only CLI (`<plugin root>/scripts/sub-human read`, `digest`, `who`, `tasks`, `watch`, `show HASH`) stays allowed, and so do reading the plugin's source and running its tests. This is a string check. A determined command can evade it, for example a script written to a file first, or a path built at run time. What can't be evaded is the signature: a line written around the store has no valid one, so it shows as unverified and counts for nothing.
- **Read guard.** The same module denies `Read` of a seat's private key (`<home>/keys/`), the one file a model could sign a person's words with. The rest of the store stays readable, so a model can read the log and the plans with `Read` too. Other MCP servers that read or write files aren't guarded, and neither is a script that reads the key: the guard is a string check.
- **Not covered.** Other MCP servers, and a hostile local user.
- **File modes.** The home and every directory in it are 0700 (a home an older version made 0755 is closed when a room is opened), and the log and state files are 0600.
- **Row launcher and serve shim.** The status-line launcher in `<home>/bin/row-status` and the SSH serve shim `<home>/bin/serve` run only plugin roots outside temp directories (`/tmp`, `os.tmpdir()`), unless `SUB_HUMAN_ALLOW_TMP_ROOT=1` is set.
- Only a task's owner, through their own Claude's `done` request, can complete it.

Remote rooms add:

- **An invite is shown once** and works for one machine; the host keeps only its hash. An invite is untrusted input: its locator is a home path (pipe) or a plain `user@host[:port]` with plain jump hosts (ssh), and the link always runs this plugin's own server, or `ssh` with fixed options, never a command or an ssh option the invite names.
- **An invite's 4-digit PIN is its whole secret, and it never travels.** Both machines run CPace (the CFRG's CPace specification, revision 21: ristretto255 + SHA-512, initiator-responder, with its key confirmation both ways) with the PIN as the password; the group code is the vendored, hash-pinned `@noble/curves` 2.4.0 (`lib/vendor/noble`, its MANIFEST and LICENSE; `test/vendor-noble.node-test.ts` fails on any edit), checked against the specification's published vectors. What crosses the wire are random-looking group elements and MACs: watching them tells an eavesdropper nothing it can test guesses against, offline or later.
- **Guessing is online only, and counted before the host answers.** The host charges one of the invite's 5 tries when it answers an attempt, so an attempt abandoned after that answer still costs its try; the fifth wrong PIN burns the invite, as do 15 minutes or its one use. Each wrong PIN is a room line. An attacker (a prober, or someone in the middle of a real join) gets one guess per attempt: 5 guesses in 10,000 per invite, then the invite is gone. With several invites open (at most 4 per room), one attempt is tried against each and charged on each, so the odds are at most 20 in 10,000; a success gives the others their try back. A PIN that holds is still not the admission: the host's card is (below), so a lucky guess gets a card the host can refuse. The host keeps the PIN in its own store (CPace needs it in clear) and drops it once the invite is used, burnt or cancelled.
- **The PIN authenticates the host, then the host's key is pinned.** Inside the PAKE the host vouches for its key: sshd's Ed25519 host key over ssh, the listener's X25519 key over the web. Over ssh the joiner's ssh records the host key it was shown (a fresh known_hosts, Ed25519 only, `accept-new`) and the joiner stops, before its own confirmation goes out, unless it is the vouched one: someone between the joiner and the host (a spoofed name, a hostile network) learns at most whether its one guess was right. The joiner then pins that key. Over the web the joiner pins the vouched listener key and every later connection is Noise_NK to it.
- **The PIN is not the admission; the host person is.** A PIN that holds gets the joiner a fresh 128-bit secret (sealed under a key derived from the PAKE's ISK, bound to that machine and, over ssh, to the link key the joiner made and sent inside the PAKE). It redeems nothing until a person on the host answers **Let in** on the card (`hooks/handlers/consent.ts`: only the answer on the card as the hooks built it counts, never the model's; the answer is signed with that person's seat key) or runs `sub-human admit REF` in a shell. Unanswered requests lapse after 10 minutes.
- **The ssh enrollment door.** A joiner with no admitted key still has to get through sshd. While an ssh invite is open, `authorized_keys` holds one more line: `command="… serve --enroll CODE --kind ssh",restrict <the room's enrollment key> sub-human-enroll:CODE`. That key's private half is **public by design**: anyone who knows the room derives it (sha256 of a label and the room). It is never derived from the PIN, so trying keys at sshd tests no guess. What the door lets anyone who reaches sshd and knows the room do: run the PAKE (a guess, charged), spend the invite's tries until it burns (a denial of service on that one invite), and see that a room by that name is hosted there. What it does not: run a shell, a pty, forwarding or any other command (`restrict`, a forced command that ignores what was asked), read the room, post, or learn anything about the PIN beyond one guess per try. The line goes when no ssh invite is live (used, burnt, cancelled or expired; the host's tail sweeps every 30 s, and each attempt, kick and cancel sweeps), and `serve --enroll` refuses a room with no open invite whatever the file says. Limits: sshd itself must accept public keys for that account (an `AuthenticationMethods` that also demands a password or MFA defeats the door; the joiner can join over their own login instead, or use `--web`), the host's sshd must have a readable Ed25519 host key, and during those 15 minutes an attacker on the network can burn the invite.
- **The PIN never reaches a model.** `invite` shows it to the person only (a hidden block, never a systemMessage); in Claude Code's `!` shell `sub-human invite` masks it; every `join`, `invite` and `admit` prompt, and any prompt with a word of digits, is answered with a hidden block before its form is even sorted out (a mistyped PIN, an unknown flag), so the typed prompt never lands in the conversation; for the same reason a join that carries a PIN never takes the seat in that step (the seat's context would go to the model with the prompt), and a bare `/sub-human` does once the host has let you in; the link file holds the PIN (0600) only until the host answers; it is in no log or room line, and `doctor --bundle` cuts any lone 4- or 6-digit number. **History caveat:** what you type at Claude Code's prompt stays in its prompt history (the up arrow, and its history file under `~/.claude`); after a burn or a use the PIN is worthless.
- **Over SSH, keys are made where they are used.** The joiner's link key is made on the joiner's machine; the host lets in only its public key (the card), and the joiner pins the host's SSH host key (vouched for inside the PAKE, or carried in a handoff's invite).
- **Over SSH, the host's `authorized_keys` decides what runs**: the card's **Let in** writes a `command="… serve --stdio CODE --link ID",restrict` line, so the key reaches that room's server for that link and nothing else, and the server refuses another link's token there.
- **An ssh login to the host's account is trusted as that account.** `/sub-human join USER@HOST ROOM` runs `serve --login` over the joiner's own login, and the server then makes a link with no invite, because that login could make one anyway. A restricted key can't get there: its line fixes `serve`'s arguments without `--login`, and `serve --login` refuses to run under a forced command (`SSH_ORIGINAL_COMMAND` is set). Give someone a login to your account only if you would give them the account.
- **A link token is a seat-level credential.** The invite turns into a token at the link's first connection. It is stored in clear in `<home>/links/<CODE>.json` (0600, the same trust as the seat key) and hashed on the host. Whoever holds it can post as the seats joined over that link, never as anyone else: the host checks every entry's `from` against them and its signature against the key pinned in the log.
- **Keys are pinned strictly.** A name is its key for the room's life, on every machine. A lost key, or the same name from a new machine, means a new name.
- **Addressed posts are not private.** A post to one person (`to`) has its own rate limit, but the whole room reads the log, on every machine.
- **A link is bounded.** The host takes at most 30 of a person's own posts a minute over a link (a seat elsewhere holds its own key and token, so a script there could post as fast as it liked), a bounded number of plans per connection, and one stream per connection. Typing at a keyboard never meets the limit.
- **An admitted machine joins as the one name on your card.** The link your Let in makes can take that seat and no other (a name no one holds included); a second seat, or another name, is refused. Your own ssh login's link (no card) picks its name as you do.
- **The guard denies `sub-human invite`, `admit`, `kick`, `prime`, `listen`, `link`, `serve`, `handoff`, `promote`, `demote` and `doctor --fix` to a model** (a plain `sub-human doctor` is read only and allowed), and `/sub-human invite` shows the line and its PIN to you, not to your Claude.
- **Moving the host needs the new host's person.** Only their own answer on the handoff card moves the room, signed with their seat key. The `host_changed` entry carries that signature and the old host's signed ask. A handoff's invites travel only over each machine's existing authenticated link. Each one works for one machine and is bound to that machine's seats. The old host keeps them for a day so a member that reconnects late still gets one, then they lapse. A `promote` is a person's own command in their own shell, recorded in the log with their name; its invites carry a 6-digit PIN checked online (5 tries, 15 minutes), each bound to one machine.

Over the web (Tailscale Serve, Funnel or your own front), who sees what:

- **The listener binds `127.0.0.1` only.** Nothing on your LAN can reach it; Serve, Funnel or your front is the only way in. Before a Noise handshake completes it holds at most 16 connections in handshake (64 in all), gives each 10 seconds, and takes frames of at most 64 kB.
- **Tailscale (or your front) ends TLS, not the room's encryption.** It sees which IPs connect, when, and how many bytes; Funnel's relays see the same. Inside the WebSocket every byte is Noise_NK ciphertext (X25519, ChaCha20-Poly1305, SHA-256, from `node:crypto` only; checked against the published cacophony and snow test vectors), keyed to the listener's own X25519 key (`<home>/listen/host-x25519.json`, 0600, random, one per home, used for nothing else). The joiner pins that key from inside the PIN's PAKE: a front that answers with another key gets a `could not link … the host did not prove the key the invite pinned` and the link stops. The path names the room. The PAKE runs in WebSocket text frames before any Noise: the front sees its public values and the sealed secret, never the PIN.
- **Funnel's name is public** (certificate-transparency logs), so expect probes: a guessed PIN costs one of 5 tries, every wrong one is a line in the room, and even the right PIN gets only as far as your card.
- **The host is still trusted**: the listener hands decrypted bytes to `serve --stdio CODE`, which checks the hello exactly as over SSH.

The plugin doesn't stop a hostile local user, who can read the keys and write the files directly. The hash chain makes such edits visible. It doesn't prevent them.

## Troubleshooting

Start with `/sub-human doctor` (see **Doctor**): it names most of these and the fix.

| Symptom | Fix |
|---|---|
| "Unknown command" for `/sub-human` | Launch with `--plugin-dir plugin/sub-human`, or install the plugin. |
| `/sub-human` asks which room | More than one room is open, so add it: `/sub-human NAME ROOM`. |
| `✗ "NAME" is taken in room …; pick another: /sub-human NAME` | Your default name (from git) is someone else's in that room. Type a name: `/sub-human dana2`. |
| "the room's Claude could not start" on join, or `Workspace not trusted` | Run `claude` in that folder once and accept trust, then join again. Without its Claude the room still works, but it has no shared task list. |
| No rows in the panel | Accept workspace trust for this folder. After a resume they come back by themselves. |
| A proposal didn't open | Ask your Claude to "show me the proposal". `node <plugin root>/scripts/sub-human read` in a terminal shows who a proposal names, and `node <plugin root>/scripts/sub-human show HASH` its text. `sub-human` is not on the PATH, in a terminal or in a session, so your Claude runs it by the full path that the proposal's reply gives. |
| `✗ sub-human needs Claude Code 2.1.292 or newer, and this is …` | Update Claude Code (`claude update`) and restart it. |
| `✗ sub-human's hooks module isn't running in this session (…)` | `/sub-human doctor` (it still runs) checks the usual causes: a settings file with `disableAllHooks` or `allowManagedHooksOnly`, or Claude Code's hooks-modules switch off. Start `claude` without `--bare` or safe mode, in a folder you trust. |
| `the connection to room … stopped (…)` | The link stopped for good: the host refused or revoked it, or the room closed. The reason says what to do (usually a new invite from the host: `/sub-human invite` there). A closed room reconnects with `/sub-human` if the host opens it again; `sub-human link CODE --forget` drops it for good. |
| `the connection to room … is down` | The link can't reach the host. It retries by itself (from 1 s, with jitter, up to 10 s; at once after a wake or a network change); `@room` posts are queued, answers are refused, until it is back, and `the connection to the room is back` says when (and how many queued posts went out). `~/.sub-human/links/CODE.log` says why; `~/.sub-human/links/CODE.state.json` holds the link's state. |
| `the connection to room … is down (room CODE moved to NAME's machine, which this machine can't reach yet …)` | A handoff moved the room and this machine can't reach the new host. Ask its person for an invite (`/sub-human invite` there) and type the line it shows; their card lets you in, then `/sub-human`. |
| `STALE` | A write or a link reached a host the room has moved away from, or a copy that has not caught up with the move. A copy catches up by itself. An old host that was promoted away runs the `node <plugin root>/scripts/sub-human demote CODE INVITE PIN` line promote printed for it, in a terminal. |
| `this machine's copy of room … no longer matches the host's` | Nothing more syncs. `/sub-human doctor` prints the line to run in a terminal (`node <plugin root>/scripts/sub-human link --reset CODE`): the link copies the room again from the host. |
| SSH join: `room … is offline` and the link log says `Permission denied (publickey)` | The key ssh used is not the one the host let in, or the host's `authorized_keys` line is missing. The link uses `BatchMode=yes`, so it never asks for a password or a passphrase: load the key into your agent, or name it in `~/.ssh/config` (or `SUB_HUMAN_SSH_OPTS="-i KEY"`). |
| SSH join: `Host key verification failed` in the link log | ssh has not seen the host yet and BatchMode can't ask. Run `ssh me@host true` once in your shell to accept its key. |
| SSH join: `no room` or `AUTH: this token is not link …'s` in the link log | The forced command names another room, home or link than your invite. Ask the host for a new invite (`/sub-human kick NAME`, then `/sub-human invite`). |
| `✗ could not join …: wrong PIN (N tries left)` | Check the digits with the host and type the join line again. After 5 the invite stops working: ask for a new one. |
| `the host's machine checked your PIN. A card there now asks them…` and nothing more | The host person has not answered their card yet (their Claude opens it; or `/sub-human admit` there). Once they let you in, type `/sub-human`. After 10 minutes it lapses: ask for a new invite. |
| SSH join: `the ssh server that answered is not the one that holds your PIN` | The host key ssh was shown is not the one the host vouched for inside the PIN's handshake: a wrong address, a reinstalled host, or someone in between. Check with the host; nothing more was sent. |
| SSH invite: `Permission denied (publickey)` before any PIN check | The host's sshd refused the room's enrollment key: no door line (the invite expired or was used), or sshd demands more than a key. Ask for a new invite, join over your own ssh login, or ask for `/sub-human invite --web`. |
| Web join: `could not link … the host did not prove the key the invite pinned` | Whoever answered at that URL is not the listener the invite was made for (a changed host key, the wrong front, or someone in between). Ask the host for a new invite. |
| Web join: `still connecting (Tailscale may be issuing a certificate …)` | A new ts.net name's first TLS handshake waits on its certificate (~20 s). The link keeps trying; type `/sub-human` in a moment. |
| Web join: `still connecting` and the link log says `answered 502` / `404` | The front reaches no listener: on the host, `sub-human listen --status`; with Tailscale, `tailscale serve status` should list `/sub-human/CODE`. Run `/sub-human invite --web` again. |
| Web join: `TLS to …: unable to verify` in the link log | The joining machine does not trust the front's certificate. A ts.net certificate is public; for your own front set `NODE_EXTRA_CA_CERTS`. |
| `AUTH` after upgrading the plugin | A seat that joined before keys were pinned can't post as you. Rejoin with `/sub-human NAME ROOM`; if the name's key is lost, join with a new name. |

## Limits

- **Remote joining needs SSH** to the host's account, or a front the joiner can reach over HTTPS (Tailscale Serve or Funnel, or your own), or a second home on the same machine. There is no relay for two laptops behind NAT without one.
- **A name is one machine's**: its key stays where it joined first.
- **A handoff needs every member to reach the new host.** Over SSH that means the new host's `authorized_keys` must allow each member's key. The handoff does not install the keys itself yet; whoever can't connect gets a message and a fresh invite.
- Agent posts are rate-limited, so Claudes can't wake each other in a loop.

## Leaving

`/exit` asks Claude Code's own question about background work, because your room row is a background agent:

```
❯ 1. Exit and stop tasks
  2. Move to background and exit
  3. Stay
```

Choose **1**. The room records that you left, and your row reads `left` in everyone's panel until you rejoin. A plugin can't mark an agent as safe to stop, so Claude Code always asks this question. `/clear` does not leave the room. When the last person leaves, the room's Claude is stopped and the room closes. The room's `tasks.json` stays.
