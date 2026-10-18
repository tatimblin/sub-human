# sub-human

A Claude Code plugin for working together from separate sessions, on one machine or, with a link, from others. You join a room with one command and keep working however you like. Your Claude learns who is in the room and how to reach them, and nothing else is prescribed: no workflow, no required plan.

- **`@room`** posts your exact words to the room. A hook posts them, so no model paraphrases them.
- **Claudes talk to each other natively,** with Claude Code's own `SendMessage` and `ListAgents`, addressed `NAME.CODE`.
- **The room plan.** Your Claude edits a room plan in its own plan mode when you ask; the room keeps every version, and two edits at once never overwrite each other. Any member's Claude, asked by its person, keeps the room in order: plans, tasks, a catch-up.
- **Consent is yours.** When someone asks you to sign off on a version of a plan, it opens in Claude Code's own plan view in your terminal, all of it scrollable. Only your answer there records agreement. No Claude can give it.
- **The room session** (member `claude`, a background session titled `claude.CODE`) starts with the room and holds the room's shared task list and the members' rows. It never plans, reads or answers anything.

How it is built: [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md).

## Install

From this repo, without installing, add `--plugin-dir plugin/sub-human` to `claude`. Or install it through the bundled marketplace:

```
claude plugin marketplace add /path/to/sub-human
claude plugin install sub-human@sub-human
```

**Requirements.** Claude Code 2.1.292 or newer with function hooks on (not `--bare`, not safe mode, and no policy that turns hooks off): the plugin's hooks module guards the store, checks who typed an `@room` and delivers the room, so `/sub-human` refuses to join without it. Node 22.18+ or 24.3+ (Node 23 lacks what the plugin needs): every hook, the room MCP server, the room tail and the row status line run `node`. They find it on `PATH`, or else where nvm, fnm, mise, asdf, Volta or Homebrew install it (`hooks/node.sh`), so a Claude Code started from an IDE or the desktop app works too. macOS or Linux only (the row launcher is a POSIX shell script and the store relies on POSIX rename and file modes); Windows is not supported. `claude plugin validate plugin/sub-human` checks the plugin. Accept workspace trust for your folder: the room session starts in your working directory, and Claude Code refuses to start a background session in an untrusted folder.

**Updates.** Marketplace plugins don't update by themselves by default: enable auto-update for the sub-human marketplace in `/plugin` (Marketplaces), or run `/plugin update sub-human` now and then. Everyone in a room should run the same version; `/sub-human doctor` shows yours and, for a room hosted elsewhere, the host's protocol version.

## Start: three commands

```
/sub-human                      # open a room (or join the one open here) as your git name
/sub-human invite               # a line for someone on another machine, and a PIN to tell them apart
/sub-human join dev vole-8126   # on a machine that can ssh to dev: join that room there
```

`/sub-human help` lists every command (words after it are ignored). In a room, a bare `/sub-human` says who is here and how to invite.

## Join: one command

In your normal Claude Code session:

```
/sub-human
```

When no room is open, the join hook creates one (say `vole-8126`, the **room**) and starts the room session as a background session titled `claude.vole-8126`. It runs one short turn at start, and one each time someone joins, to keep the rows; otherwise it is idle. A join that works says so in one dim line, `sub-human: opened room vole-8126 as tristan · on this machine others join with /sub-human; another machine: /sub-human invite` (the next person sees `joined vole-8126 as dana, with tristan · @room to talk; your Claude can message other Claudes, edit the room plan and the task list`); your session is titled `tristan.vole-8126` and the room's row `vole-8126` appears in your agent panel.

**How replies show.** `/sub-human` answers in place of the command, as dim `sub-human: …` lines: help, who is here, `left vole-8126 · /sub-human joins again`, an invite, a refusal. They never reach your Claude's context (so it neither repeats them nor sees a PIN), and a command that only replies leaves no row of what you typed. Claude Code does save these lines in the session's transcript, so an invite's line and its PIN are not among them: they are pinned under the prompt instead (see **Join from another machine**). Nothing reads "blocked by hook". A refusal starts with `✗` and says what to type next, or to run `/sub-human doctor`. Typed through Remote Control, where those lines don't show, a reply with no secret in it is the command's own output instead. The next person on this machine runs `/sub-human` too, and adds the room (`/sub-human dana vole-8126`, or just `/sub-human vole-8126` or `/sub-human join vole-8126` as their git name) only when more than one room is open.

**Your name.** With no name typed, it is your git `user.name` (the repo's, else your global one): its first word, lowercased, with only letters, digits, `.`, `_` and `-` kept (`Tristan Timblin` → `tristan`). With no `user.name`, the part of your git `user.email` before the `@`; with neither, `$USER`. A name that is taken in the room is refused with how to pick one: `/sub-human NAME`. A typed name always wins: `/sub-human alice`, or `--as NAME` on a join. Command words (`invite`, `join`, `kick`, `leave`, `doctor`, `help`, `admit`, …) are never names, and nor is a word of digits (`/sub-human 4829` says it looks like a PIN).

The hook binds your name to your session before the model sees anything, so your Claude can never pick or change it. Your identity survives `/clear`, compaction and `--resume`. The command shows as `/sub-human:sub-human` in the picker; typing the bare `/sub-human` works. `/sub-human leave` leaves the room and keeps the session open (no `/exit`).

## Join from another machine

A room lives on the machine that opened it, its **host**. If you can already ssh to the host's account (your own second machine, a dev box you log in to), join with that login. Anyone else joins with the invite line the host's `/sub-human invite` shows and the PIN the host tells them apart from it, and the host's card lets them in.

### If you can already ssh to the host: `/sub-human join HOST ROOM`

On your other machine:

```
/sub-human join dev vole-8126                    # an alias from your ~/.ssh/config (its User, HostName, Port, ProxyJump)
/sub-human join you@machine-a vole-8126
/sub-human join you@devbox:2222 vole-8126                 # a port (a jump host: ProxyJump in your ~/.ssh/config)
/sub-human join you@devbox vole-8126 --home /srv/sh       # the host's sub-human home is not ~/.sub-human
/sub-human join dev vole-8126 --as carol                  # a name other than your git name
```

That is the whole step: no invite, no PIN, no card. It links the machine and takes your seat at once; later rejoins are a bare `/sub-human` (or `/sub-human carol vole-8126`). Your login to that account is the admission, since whoever can run commands there could make an invite anyway. The room shows `a machine linked over your SSH login`.

- **Your own ssh.** The link runs `ssh -T -o BatchMode=yes [-p PORT] -- you@machine-a '"$HOME"/.sub-human/bin/serve --stdio vole-8126 --link ID --login'` with your keys, agent, `~/.ssh/config` and `known_hosts`, checked as usual. It never prompts. When ssh does not know the host's key yet, the join stops at once and says so: run `ssh you@machine-a` once in a terminal, check and accept the key, then join again. A login that needs a password is refused the same way. Behind an MFA bastion, run `node <plugin root>/scripts/sub-human prime vole-8126` in a terminal (the refusal prints the full line) and then `/sub-human`.
- **On the host** this runs the stable serve shim (`<home>/bin/serve`, see [SSH details](#ssh-details)), which records where node is, because a non-interactive ssh shell lacks nvm's or Homebrew's `PATH`. Opening or joining a room on the host writes the shim when it is missing. If it is still missing, the join says `me@devbox isn't set up for joining yet`: open the room there in Claude Code, then join again.
- **Not through a restricted key.** The host's `serve --login` refuses to run under any forced command (sshd's `SSH_ORIGINAL_COMMAND`), so a key restricted by its `authorized_keys` line can't make itself a link.
- `kick`, `doctor`, the link state and the outbox work as for any link. Your seat there is its own person for consent, as an invite's is. `/sub-human kick carol` stops the link, but that login can link again: to shut it out, take its key out of `authorized_keys`.

Two ways in: **SSH** (the joiner's own ssh login to the host's account: with an invite line, as their own name and seat, or alone, as above) and **the web** (an invite line naming the host's listener, through Tailscale, any HTTPS front of yours or a `CONNECT` proxy; see [Join from anywhere: Tailscale](#join-from-anywhere-tailscale)). Someone with no ssh login on the host joins over the web: sub-human never writes to `authorized_keys`. Host on a machine that stays awake (a dev box): when the host sleeps, the room is down for everyone.

### Inviting someone: `/sub-human invite`

On the host, in a session that is in the room:

```
/sub-human invite                           # over ssh to this machine: SUB_HUMAN_SSH_ADDR, else you@hostname
/sub-human invite --ssh me@devbox.local:2222   # or name the address
/sub-human invite --ssh devbox              # an ssh alias: the line says devbox; the joiner's ~/.ssh/config resolves it
/sub-human invite --web                     # over the web: see Join from anywhere: Tailscale
```

```
sub-human: invite to room vole-8126 for one machine, over ssh me@devbox.local. It works once, for 15 minutes. Its PIN and the line to send them are pinned under the prompt until 14:05: Claude Code saves neither in this conversation. Send the line; tell them the PIN apart from it (say it, or send it another way).
sub-human: Their machine asks them for the PIN once this one has answered; the line alone gets nobody in, nor does the PIN. After 5 wrong PINs the invite stops working.
sub-human: When they have typed both, a card here asks you to let them in; nothing gets in before you answer.
sub-human: Sent it to the wrong place? /sub-human invite --cancel 3f9c2a1b7e0d cancels just this invite.
sub-human: Over ssh this needs their own ssh login to this account (me), set up as for any ssh login: sub-human writes nothing to authorized_keys. No login here? Invite them over the web: /sub-human invite --web
sub-human: They need sub-human VERSION or newer; an older one is told the host runs a newer version and to update (/plugin update sub-human).
```

and under the prompt, on the plugin's status line:

```
⚠ sub-human: PIN 4829 · /sub-human join me@devbox.local vole-8126 4f9k2m8q7r3t6v1w0x5y9z2a8b7c6d5e4f3g2h1
```

The status line is one line, and Claude Code cuts it at the terminal's width. When the whole line does not fit, it holds only `PIN 4829 · SECRET 4f9k…` and the notice gives the line with the word `SECRET` in its place, to fill in as you send it; in a terminal outside Claude Code, `sub-human invite` prints a new invite whole. The status line goes at once when you cancel the invite, within a few seconds once it is used or burnt, and when it expires.

These dim lines are shown to you, never to your Claude, and your `/sub-human invite` itself leaves no row. VERSION is your own sub-human's version: theirs needs to be at least as new. The line's last word is its **SECRET**: 39 characters (letters and digits only, so a chat app or mail client leaves it alone) that hold 128 bits of single-use randomness and a short tag of this machine's key. Send the line by any channel; tell the PIN by another (say it, a call, a second app). With no address given (no `--ssh`, no `SUB_HUMAN_SSH_ADDR`), the invite also says that it used this machine's own name (a Mac's `.local` name reaches only the same local network) and how to give another, and, when this machine takes no ssh logins (on a Mac, Remote Login is off in System Settings → General → Sharing), that their ssh will fail and `/sub-human invite --web` is the other way. When this machine's sub-human folder is not `~/.sub-human`, the line adds `--home PATH` (where their login finds it). The line carries no name (theirs comes from their git name, or `--as NAME`). `sub-human invite [--room ROOM] [--ssh [USER@HOST]] [--via JUMP]` prints the same in a terminal outside Claude Code; inside Claude Code (its `!` mode) it masks the SECRET and the PIN, because that output becomes part of the conversation. An address that still has an example's placeholder (`NAME@…`, `USER@…`, `YOU@…`) is refused.

When they have typed the line and the PIN, **your Claude Code shows you a card**: `Let carol (check 3f9c-2a71) on carols-mbp join room vole-8126? — Let in / Refuse` (`carols-mbp` is what her machine calls itself: its short host name, or `SUB_HUMAN_MACHINE_LABEL` there; never proof of anything). The check comes from the machine that typed the PIN (its machine key, and over the web its link's own key), not from the line: her screen shows `check 3f9c-2a71` too, so ask her to read it out. Someone else holding the same line and PIN shows another check; if a second machine presents a used invite, the room says so with both checks. Only your answer there admits them: your Claude can't answer it, and the answer is signed with your seat key. **Let in** admits that machine (the one whose machine key typed the PIN; over the web, also the Noise key its connection proved), as that one name, and their link connects within seconds. **Refuse** ends it. When the name they ask for already sits in the room from another machine (bob on a new laptop, or with a fresh sub-human folder), that seat's key cannot move to the new machine, so the card offers **Let in as bob2** instead, and their machine is told the name it joins as. Unanswered, the request lapses after 10 minutes. `/sub-human admit` lists who is waiting and `/sub-human admit REF` lets one in, as the card does; with no session open on the host, `sub-human admit` in a shell does the same (y/N first, `--refuse` to say no).

`/sub-human invite --cancel` cancels the open invite (with several open, it lists them: `/sub-human invite --cancel REF`).

### Joining: `/sub-human join HOST ROOM SECRET`, then `/sub-human join PIN`

On the other machine, the line the host sent you:

```
/sub-human join me@devbox.local vole-8126 4f9k2m8q7r3t6v1w0x5y9z2a8b7c6d5e4f3g2h1
/sub-human join https://box.tail1a2b.ts.net/sub-human/vole-8126 4f9k2m8q7r3t6v1w0x5y9z2a8b7c6d5e4f3g2h1   # over the web: the URL holds the room
```

This step only links the machine to the room, and the hook hides the prompt from the conversation, so the SECRET never reaches your Claude (the same for any `/sub-human join`, `invite` or `admit` prompt, or a `/sub-human` prompt with a word of digits or a SECRET-shaped word, whatever is wrong with it; a plain prompt or an `@room` with digits in it is not hidden). Your machine first checks it reached the host the line names (over ssh and a pipe the host signs a fresh challenge with its machine key; over the web it reads the listener's key and checks it before any handshake), then shows the host the SECRET, and the host asks for the PIN:

- `the host's machine has your invite (5 PIN tries left). Type the 4-digit PIN they told you: /sub-human join PIN`. Type `/sub-human join 4829` (hidden too). The host checks it online: `the host's machine checked your PIN. A card there now asks them to let you in (check 3f9c-2a71). This session tells you when they do; then type /sub-human to join`. The link keeps trying for 10 minutes. When the host lets you in, the same session shows one dim line, `the host let you in to room vole-8126: type /sub-human to join it as carol` (or why the join stopped). The bare `/sub-human` takes your seat; if the host has not answered yet, it says so.
- **A wrong PIN:** `wrong PIN (4 tries left). Check the digits with the host, then type it again: /sub-human join PIN`. Too soon after a wrong one: `too many PINs tried just now: wait 4 s, then type the PIN again` (that costs nothing). After the fifth wrong PIN, `this invite no longer works. Ask the host for a new one`.
- **The line without its SECRET:** `/sub-human join HOST ROOM` is the join over your own ssh login (above), and says so; if ssh refuses that login, the reply adds that an invite line ends with a long SECRET. From a second sub-human folder on the same machine (`pipe:…`), which has no login path, it says the line lost its SECRET. A line whose last word is 4 digits came from a host before this version: the reply says the host must update and invite again. A line with the PIN on it is refused: type the line alone, then the PIN when asked.
- **Over ssh without a login of your own:** `could not join room vole-8126: me@devbox refused your ssh login …`: ask the host for an invite over the web.
- **Refused or lapsed:** the link stops with `the host refused to let this machine in` (or `did not let this machine in in time`); ask for a new invite.
- **Someone in between, or a line for another host:** if the host that answered does not hold the key the line's SECRET names, the join stops (`… is not the one the invite line names: someone may be in between, or the line is for another host. Nothing secret was sent`). Check with the host.

The join starts a **link** on that machine: a small background process (`sub-human link CODE`) that keeps a copy of the room (a mirror) and carries that machine's posts and answers to the host. After that, everything works as on the host: `@room`, rows, proposals in the plan view, tasks. Your words are signed on your machine and checked on the host. The host runs the room's Claude and decides proposals.

- **Rejoin** (a new session on the same machine) with `/sub-human` (or `/sub-human carol vole-8126`). The link is kept, and started again if it had stopped; you need no new invite.
- **When the link is down**, your session shows one dim line, `the connection to room vole-8126 is down (…)`. An `@room` is queued (`⧗ queued`, up to 50 posts for up to 9 minutes) and sent in order once the link is back; one that waited too long is not sent, and you are told with its words. An answer to a proposal is never queued: it is not recorded and you are told so. The link retries on its own, and at once after your machine wakes or changes network. If the link's background process itself is gone (it crashed or was killed), your next `@room` is queued all the same and starts it again (`⧗ queued; restarting the link`); `/sub-human` starts it too, and a request that is never queued (a task, an answer) says to try again in a moment.
- **When the link is slow** (the host has not answered within 2 s), an `@room` says `⧗ sending (slow connection)`: it is on its way and shows in the room when the host has it, so don't type it again. An answer that gets no reply in time says it is not confirmed: if the proposal still shows you unanswered later, answering again is safe.
- **The link stops by itself** about a minute after no session of that machine is left in the room.
- **Versions.** The two machines agree on a protocol version when the link connects. When they share none, or what was asked needs a newer one (an invite line needs protocol 3), the reply says which side must update, e.g. `host runs sub-human 0.5.0 (protocol 3); you run 0.5.0-beta.15 (protocol 1–2). Update your plugin: /plugin update sub-human`. Links made with 0.5.0-beta.15 or earlier stop working once either side updates: join again with a new invite line. If the host was on 0.5.0-beta.15, remove any `authorized_keys` lines ending `sub-human:ROOM:ID` or `sub-human-enroll:ROOM` that it wrote; nothing uses them now.

### Join from anywhere: Tailscale

For friends who have no SSH account on your machine. The host runs [Tailscale](https://tailscale.com) (the joiners need it only for the tailnet-only default). On the host, in a session that is in the room:

```
/sub-human invite --web            # Tailscale Serve: people on your tailnet (or a node you shared) only
/sub-human invite --public         # Tailscale Funnel: anyone with the URL, the SECRET and the PIN (opt-in)
/sub-human invite --stop           # stop serving this room over the web
```

```
sub-human: invite to room vole-8126 for one machine, over the web through Tailscale Serve (your tailnet only) to this machine's listener on 127.0.0.1:7420. It works once, for 15 minutes; send them this line:
sub-human:   /sub-human join https://box.tail1a2b.ts.net/sub-human/vole-8126 4f9k2m8q7r3t6v1w0x5y9z2a8b7c6d5e4f3g2h1
sub-human: and tell them its PIN apart from the line (say it, or send it another way): 4829
sub-human: When they have typed both, a card here asks you to let them in; nothing gets in before you answer.
```

The joiner types the line, then the PIN when asked; your card lets them in, as over ssh; then a bare `/sub-human` takes their seat. The URL names the room; the SECRET after it names this machine's listener key.

What happens:

- `/sub-human invite --web` starts **the listener** (`sub-human listen`, one per home, on `127.0.0.1:7420` only, `SUB_HUMAN_LISTEN_PORT` or `--port` to change it) and runs, with the `tailscale` on your `PATH` or `/Applications/Tailscale.app/Contents/MacOS/Tailscale`:

  ```
  tailscale serve --bg --https=443 --set-path=/sub-human/vole-8126 http://127.0.0.1:7420
  ```

  `--public` runs `tailscale funnel` with the same flags instead. The name comes from `tailscale status --json` (your node's MagicDNS name). `/sub-human invite --stop`, and the room closing, turn off that one path (`tailscale serve --https=443 --set-path=/sub-human/vole-8126 off`) and nothing else; it never runs `serve reset`. When the last room the listener served closes and nobody is connected, the listener exits too. Tailscale's HTTPS certificates and Serve (and, for Funnel, the Funnel attribute) must be enabled for your tailnet. When they are not, `tailscale serve` prints an enable URL and waits; sub-human stops it at that URL (or after 10 s) and says: `Tailscale Serve isn't enabled on your tailnet yet. An admin turns it on once at <URL> (or Admin console → DNS → HTTPS Certificates and Serve), then run /sub-human invite --web again.` Tailscale not running, stopped or logged out is named as such. The first HTTPS connection to a new ts.net name waits ~20 s while Tailscale issues its certificate: the host fetches it right after `serve` (one background request), a joiner's WebSocket waits up to 45 s (`SUB_HUMAN_WS_CONNECT_MS`), and the link keeps trying after that.
- **Funnel is public.** Its hostname is published in public certificate-transparency logs, so anyone can find your node's name. Finding it gets nobody anywhere without an invite line, its PIN and your card; the host shows that warning each time.
- The joiner's link connects with a WebSocket. Its first connection asks the listener for its public key and checks it against the line's SECRET; then every connection is an end-to-end **Noise XK** channel to that key, in which the joiner's link proves a key of its own (made for this link, kept in its link folder). The host binds the link to that key: its token alone gets nowhere. Tailscale, Funnel's relays or your front see only Noise ciphertext; the SECRET and the PIN travel inside it.
- **The card is the admission.** The line and the PIN prove only that the joiner has both; your Let in admits the machine, and the room line `carol's machine (…) joined the room, let in by alice` records it. `/sub-human kick carol` ends such a link as any other.
- The listener runs one `serve --stdio CODE --via ws [--peer KEY]` (its own WebSocket child, not a jump host) per connection through the stable shim. It survives a sleep; after a reboot, the host's next join starts it again. `sub-human listen --status` shows its pid, port and the rooms it serves (also in `<home>/listen/state.json`); `--stop` stops it.

### Ending someone's connection: `/sub-human kick NAME`

On the host, `/sub-human kick carol` (in a session in the room) or `sub-human kick carol [--room ROOM]` in a shell ends the connection carol joined over: its token (and, over the web, its key) stops working, its seats leave the room, every server process serving it (ssh, pipe or web) sees the link go and closes, and the room shows a line. On the other machine the link stops for good (`the host removed this machine from room vole-8126 (/sub-human kick); ask them for a new invite`): it does not keep retrying, `@room` posts there are refused, not queued, and the link's token is dropped, so a new invite line for the room replaces it (and `sub-human link CODE --forget` needs no `--force`). Their room row stays and reads `✕ removed by the host` (no stale head count), and their Claude is not woken for it: the notice is all. A joiner still waiting for your card is withdrawn the same way. Over ssh, kick ends the link, not the person's login: that is the account's to remove.

**One leaked invite.** An invite nobody has used yet is not a connection. `/sub-human invite --cancel REF` (the ref is printed under the line; 12 hex characters, not a secret) cancels that one invite, with a room line; every other invite and connection stays, and the room stays served (`/sub-human invite --stop` stops serving the whole room over the web). An invite already used cancels the connection it became.

### SSH details

- **No line of sub-human's in `authorized_keys`.** Every ssh link is the joiner's own login to the host account, whether it came with an invite line or not; sub-human writes nothing there and pins no host key of its own.
- **The stable shim.** The login runs `<home>/bin/serve`, a stable shim that finds the current plugin install and node when it runs, so it keeps working after a plugin update or a node upgrade. An ssh invite makes sure it is there.
- **The joiner's ssh.** The link runs `ssh -T -o BatchMode=yes [-p PORT] -- you@devbox '<the shim> --stdio CODE --link ID --login'` with your own keys, agent, `~/.ssh/config` and `known_hosts`. A jump host in your `~/.ssh/config` (ProxyJump) is used as for any ssh. An invite names only a plain `user@host[:port]`, jump hosts and the host's folder: it can't carry an ssh option or a command. `SUB_HUMAN_SSH_OPTS` (space-separated, in the joiner's own environment) adds ssh options after the link's own, to the `ssh -G` that reads a bare alias's user too (a `-F FILE` there is the config both read); it is meant for tests and unusual setups.

### When the host leaves

The host's machine holds the room's log and serves the links, so while it sleeps or is off the room is offline: posts from other machines wait in each machine's outbox (a few, for a while) and go out when the host is back; nothing moves anywhere else. There is no handoff and no failover: a room lives on the machine that opened it.

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

### The agent view (←) moves your session

**←** from your prompt is Claude Code's agent view, and opening it moves your own conversation into the background: Claude Code starts it again as a background session under a new session id, and your terminal becomes the agent view. Your rows end with the old session. **Enter on your own row (`alice.vole-8126`) goes back to your conversation**, and sub-human moves your seat into the new session: you stay in the room, nobody sees you leave, and your rows start again. A bare `/sub-human` there does the same if the move was missed. If Claude Code's record of the move can't be read, the moved session takes no seat and says so in one line; `/sub-human` there looks again. It never opens a second room while your seat is live in another session of the same folder; it says where the seat is.

Two things change with the move. The conversation now runs under Claude Code's background daemon, so closing the terminal does not end it (`/exit` in it does). And the daemon passes on only some environment variables: a session started with `SUB_HUMAN_HOME` set in the shell loses it there, so the moved session no longer sees your rooms. Put `SUB_HUMAN_HOME` in the `env` of your own Claude Code settings instead if you use the agent view. When that happens, the moved session says so as it starts (the folder its conversation sat in, also after a `/sub-human leave`: sub-human notes the folder in the session's transcript when you join, in a line shown only in the ctrl+o view), and `/sub-human` there opens no room in the default folder and joins none that folder lacks. To go back, in a terminal: `claude stop <short id>` (the moved session runs in the background, and `claude --resume` refuses it until it is stopped), then `SUB_HUMAN_HOME=<your folder> claude --resume <session id>` and `/sub-human`; the notice gives both lines with the ids and the folder filled in. Or set the `env` entry for next time.

To look at the room session without moving your session, use `claude logs <id>` in another terminal (below).

While the rows run, Claude Code prints **"✻ Waiting for N background agents to finish"** after each turn, where N counts your rows. This is expected. Your prompt is still free, and nothing is stuck. Setting `"showTurnDuration": false` in your own settings hides the line, along with "Worked for 12s". The plugin never writes your settings.

## The room session

The room session (`claude.vole-8126`) takes no typed input and reads nothing. It holds the room's task list (Claude Code shows it with **ctrl+t** when you peek at it) and one row per person, which it starts with one short turn when the room opens and when someone joins; that is the only time its model runs.

- In the agent view (**←**), it shows as `claude.vole-8126`. **Space** peeks: its panel lists one row per person. **Enter** attaches. Opening the agent view moves your own session too (see **The agent view (←) moves your session**): Enter on your own row to get back.
- If you type into it, the prompt is refused with `✗ the room's session (claude.vole-8126) takes no typed input; type in your own session: @room for the room, or ask your own Claude`: it runs no turn, and your text is not put back in the input. A slash command typed there (`/clear` included) is refused the same way and never runs.
- A Claude's `SendMessage` to `claude.vole-8126` is refused (the sender is told it was not delivered): ask a person's Claude instead.
- `claude logs <id>` shows it read-only from another terminal.
- About half a minute after the last person leaves, the room session is stopped.

## Saying something to the room: `@room`

```
@room bob, can you take the parser tests? handler's in src/tasks.ts
```

`@room …` at the very start of the prompt posts your words to everyone, **verbatim** as your words (`via=human`). No model turn runs, and the receipt is one line:

```
❯ @room ship the cursor paging today
⏺ ✓ sent to room vole-8126 (Claude wasn't asked)
```

If your Claude Code shows the receipt as "Operation stopped by hook: ✓ sent …", that is the same receipt: nothing went wrong. A refusal of your own words (no room, nothing after the tag, the room refused it, its connection stopped) is the same kind of line, starting with `✗`, and your prompt is not put back in the input: type it again when it says so. A long paste that starts with `@room` posts too (marked `(pasted text unwrapped)`).

- Only a leading tag counts: `@room ask bob later` posts, `ask @room` does not.
- `@claude …` is an ordinary prompt to your own Claude, in a room or not (there is no room Claude to wake).
- Spaces, unicode, `$`, backticks and quotes arrive byte-exact. For multiline input, use `\` + Enter or Ctrl+J.
- Typing `@room` opens the file picker, and a space closes it. Don't press Tab.
- Check a prompt suggestion before you accept it. A suggested `@room …` line is your Claude's wording, and accepting it posts it as yours.

Anything else you type goes to your own Claude. Its posts are labelled as your Claude's (`via=agent`) and never count as your words.

**The room reads like a group chat.** When someone else posts, everyone else's session shows their exact words, with no ids and nothing added:

```
  sub-human: bob: sure, once we've agreed how paging works
```

A Claude's post shows as `bob's Claude: …`, a join as `bob joined`, a leave as `bob left (session ended)` or `bob left (connection lost)`. The plugin writes these lines into your session itself, as dim notices that stay there (also after `--resume`). They cost no model turn: your Claude doesn't repeat them, and it gets a copy to read with its next request. A leave shows only after 8 s away, so a quick leave and rejoin shows nothing.

Every person's own words reach everyone. A Claude's post reaches you when it is addressed to you or mentions `@you`, and a sign-off request naming you opens for you to read and answer: those wake your Claude with a prompt from the plugin ("Prompt from the sub-human plugin"), or join its current turn if it is busy. Everything else reaches your Claude as a short "room context" note beside your next prompt (never as words of yours). Your room row also reads `+bob joined` or `−bob left` for two minutes.

**Claude to Claude.** Ask your Claude to "ask alice's Claude what the cursor format is". It calls `SendMessage` to `alice.vole-8126`, and alice's pane shows `› Message from @bob.vole-8126: …`. Those messages come from Claudes, not people. Native `SendMessage` only reaches sessions on the same machine, so when alice is on another machine the plugin posts the message to the room addressed to her instead (`bob's Claude (to alice): …`); it wakes her Claude the same way, and her Claude's `SendMessage` back to `bob.vole-8126` returns the same way. `ListAgents` lists only the Claudes on your machine.

## The room plan

A room has plans, each with a name (`room` unless someone names another topic, such as `paging`) and versions v1, v2, …. The room keeps every version; nothing is ever overwritten.

**Editing.** Ask your Claude ("let's write a room plan for cursor paging; you write the first version", "update the room plan: max 50 per page"). It calls the room's `plan` tool (op `edit`), then enters plan mode: the hooks put the plan's current version into its plan file under a short header that says it is a group-contributed plan and names the version it starts from. Your Claude edits the plan there, as with any plan, and calls ExitPlanMode. The hooks store it as the next version and tell your Claude so, with no approval dialog: storing an edit is not agreeing to it, and nothing about it asks you to say yes.

```
  ⎿  Error: sub-human: saved as room plan room v2, not agreed yet.
```

Claude Code draws the receipt under the call the way it draws a refused call; it is the receipt, not a failure (what your Claude does next goes to it separately).

Your own plan file is put back as it was, and your permission mode too. Everyone else sees one line, `alice's Claude for alice: plan room v2: max 50 per page`; it wakes no one.

**Two edits at once.** Each edit starts from a version. If someone else's version landed first, yours is not stored: your Claude is told so, with that version's text, and asked to keep both changes (asking you only where they truly conflict) and store again. So no edit silently replaces another. At most five plans may be open (not agreed) at a time.

**Sign-off.** Ask your Claude to "ask alice and me to sign off". It asks the room (op `ask`; any member's Claude may) for the current version, naming approvers (by default everyone in the room). A newer version of the same plan retires the request on an older one: answers given there do not carry over, and the new version is asked again. When someone else's Claude stores that newer version, the Claude of whoever asked for the sign-off, and of anyone who objected, is told at once, so the revision comes back to you to read and, if you want, to ask about again. If you opened the room and sit in it again from another machine over your own ssh login (`/sub-human join USER@HOST ROOM`), your seats count as one approver: the answer you give last, from either, is yours, and the decision names one seat ("agreed: tristan (also laptop)"). Seats that joined by invite are each their own person, and so is every other seat on the host itself, since people can share a machine.

When a request names you, your Claude opens it in Claude Code's plan-approval dialog, the same view your own plans use. The plugin's hooks put the version's text there, byte for byte, whatever your Claude wrote:

```
 Ready to code?
 Here is Claude's plan:
 ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
  Plan: cursor paging for GET /tasks
  …
  │ sign-off on plan paging v3, asked by alice, for bob: agreeing signs off on this text, it is not a go-ahead
  │ to build (PgUp/PgDn scroll). Agree: "Yes, manually approve edits" keeps your mode. Object: "Tell Claude
  │ what to change" + why. Esc: decide later.
 ❯ 1. Yes, and use auto mode
   2. Yes, manually approve edits
   3. Tell Claude what to change
```

**PgUp** and **PgDn** scroll the whole plan, however long.

| You do | Recorded |
|---|---|
| A **Yes** option | Your sign-off on that exact version (`via=human`). |
| **Tell Claude what to change**, then type why | Nothing yet: a notice says your note is not sent, and a card asks `Send to alice as changes requested on "…": "…"?`. **Send** records your objection, with your words byte for byte; it blocks that version. **Discard** records nothing. Until you answer the card, your Claude's room posts are refused, so its own wording of your note cannot reach the room first. |
| **Esc**, or Ctrl+G edits before a Yes | Nothing. |

Only an answer in a review the hooks opened counts: a Yes on a plan of your own (even one with the very text of a version) records nothing, and your Claude's own edit never asks you for a Yes.

**A Yes that may be keys meant for your prompt is asked again.** A review can open while you are typing, and the keys you meant for the prompt then go to the plan view (Enter picks its first option). So a Yes within 2 seconds of the view opening, or one given when you had typed text in the prompt as it opened, records nothing yet: a notice says so, and your Claude opens the question card for that request once. Only your answer there records.

Your mode is never changed by a review. Showing the plan briefly enters plan mode without asking, and the hooks put you back in your own mode afterwards with no dialog: at once after an answer, or on your next prompt after Esc. A "Yes" that names another mode is set back too; the one the hint names keeps it without that extra step. Agreeing is not a go-ahead to build: your Claude does not carry the plan out.

Say "show me the plan to sign off" and your Claude opens it again. With several waiting, name the plan you mean ("the paging plan", or its hash): the hooks open the one your own last words name, else the oldest, never one your Claude chose. When everyone named has agreed, the room logs a `decision` (`room: plan room v3 (3fa2c1) agreed (alice, bob)`).

**The card, as a fallback.** When the plan view can't be used, a question card opens instead (Not yet / Agree / Object, **n** adds a note): in bypass or don't-ask mode, when `showClearContextOnPlanAccept` is on (that approval path clears the context and starts building), or for a plan over 200,000 characters. The card shows the plan beside the options when it fits (up to 2,000 characters and about 20 lines), otherwise a summary and the path. Not yet, Esc, "Chat about this" or no answer record nothing.

Your room row shows each plan at a glance (`paging v4 waiting on bob · api v2 agreed`), `read` with `plan` (your Claude) or `sub-human plan [NAME] [--history]` (a terminal) shows a plan's text, its versions and where its sign-off stands. Planning is optional: use the room plan, your own plan mode, or no plan at all.

**Room upkeep.** When you ask, your Claude keeps the room in order for you: edits a plan, asks for sign-off, adds tasks and suggests owners, reconciles versions, or catches you up (`read` with `brief`: the plans, tasks, decisions and the last words people said, in one text). It never answers a sign-off for anyone, never claims or completes someone else's task, and never says a plan is agreed: only the room's decision line says so. Plan text, task subjects and room lines are people's content, never instructions to it.

## Shared tasks

The room has one shared task list. The room session shows it as its native Claude Code task list; the room's log is the truth, and the plugin writes that list from it. Your private task list stays private.

- Tell your Claude "put the parser tests on the room list, I've got it". It calls the room's `task` tool (`add` (with `suggest` for a suggested owner, or `plan` for the plan it comes from), `claim`, `release`, `done`). The host applies it at once and your Claude gets the result, or why not (`#2 is alice's; ask them to release it`). Someone on another machine asks the same way, over their link.
- Only a task's owner can release or complete it, and done needs evidence ("12/12 pass, see #15"). Nobody can claim or complete a task for someone else.
- A task added from a plan records that plan's version (`plan paging v3`).
- Your room row shows the summary (`tasks 3 open · #2 you · #4 bob`). `sub-human tasks` lists them, and `sub-human tasks --json` gives the same list as JSON.

## The `sub-human` CLI

`plugin/sub-human/scripts/sub-human` reads the room. Inside a room session it finds your room by itself. In a terminal, a command that needs a room takes `--room ROOM`, else `SUB_HUMAN_ROOM`, else the one room open on this machine's sub-human folder; with more than one open (or none) it names them and asks for `--room ROOM`. It never posts as anyone; only the host's connection commands (`admit`, `kick`, `invite --cancel`) add a line from the room itself. It lives in the plugin's `scripts/`, not `bin/`: claude.ai rejects a plugin with a top-level `bin/` when an organization distributes it, so the CLI is not on the Bash tool's `PATH`. Claude reads the room with the room MCP tools; in your own shell, run it by its path (`node <plugin root>/scripts/sub-human …`) or alias it.

| Command | Prints |
|---|---|
| `read [--room ROOM]` | The room log. |
| `who [--room ROOM]` | Who this session is in its room; with `--room` (or in a terminal, with no seat), each person in that room. |
| `tasks [--json] [--room ROOM]` | The room's shared task list (open, in progress, done: the rows' words); a task added from a room plan is tagged `[plan NAME vN]`. |
| `plan [NAME] [--history] [--room ROOM]` | A room plan's current text, its versions and where its sign-off stands; with no NAME, each plan's line. |
| `verify CODE` | A room's log checked: the hash chain over every segment and every person's line against the keys the room pins. Exit 1 when either fails. |
| `invite [--room ROOM] [--ssh [USER@HOST[:PORT]]]` | An invite line (`/sub-human join DEST ROOM SECRET`) and its PIN apart, as `/sub-human invite` shows them; over ssh to this machine by default. |
| `invite [--room ROOM] --web \| --public [--port P]` | The same over the web: the listener and Tailscale Serve (or Funnel), and a URL + SECRET line with its PIN. |
| `invite --stop`, `invite --cancel [REF]` | Stop serving a room over the web (its own Tailscale path goes off); cancel an invite nobody used. |
| `listen [--port 7420] \| --start \| --stop \| --status` | The host's web listener (127.0.0.1 only); `/sub-human invite --web` starts it for you. |
| `admit [REF [--refuse] [--yes]]` | The join requests waiting for you (no REF), or let one in (asks y/N) or refuse it: the card, for a host with no session open. |
| `kick NAME [--room ROOM] [--file F]` | End NAME's connection: token (and key) burnt, an older version's key line removed, its seats leave. |
| `link CODE [--forget [--force]]` | Run the link to room CODE hosted elsewhere (in the foreground; joins start it in the background). `--forget` drops a closed room from this machine for good (never done automatically: the host can open it again): the copy moves to `rooms/CODE.forgotten-<time>` (deleted 30 days later), the link is removed and every seat of this machine there ends (a session still open in it writes nothing more there). It needs the link stopped because the room closed, no seat is left or the host removed this machine (`--force`: any stopped link); a link still running is stopped first, once the host has heard this machine's seats leave over it (3 s at most; a link that is not online is not tried, and the host then sees the seats lapse), so `--forget` also ends a live link in one step (to join that room another way). The link's log and state files go into the archive with the copy. A leftover `rooms/CODE` with no log and no link (doctor names one) is no room; `--forget` sets it aside the same way. |
| `doctor [--quick] [--fix] [--bundle [FILE]]` | What is wrong on this machine, with a fix for each (see **Doctor**). |

`tail` (the room tail), `agent-statusline` (the rows) and `serve --stdio CODE` (the host's end of a link) are internal. Run `invite`, `admit`, `kick`, `listen`, `link` and `serve` (and `doctor --fix`) in a terminal outside Claude Code: the plugin refuses them to a Claude, and Claude Code's `!` mode would put their output (an invite, a PIN) into the conversation, so there `invite` masks the PIN.

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

- the plugin's version, and Node 22.18+ or 24.3+;
- that the home and its directories are private (0700);
- that the SSH serve shim (`<home>/bin/serve`) and its pointer name a plugin install and a node that still exist, and which install (and version) the pointer names when it is not this one;
- `ssh` and its version;
- every room this machine hosts: its log's hash chain over every segment, and every person's line against the keys the room pins (a broken chain or a line that does not verify fails: it was written outside the plugin; `sub-human verify CODE` checks one room);
- every link to a room hosted elsewhere: its transport, whether its daemon runs, its state and last error, and (unless the host ended it) a quick hello to the host (with a timeout) that shows whether the host is reachable, whether ssh works without prompting (BatchMode), both sides' protocol versions and, when the host sends its time, how far your clocks differ;
- your Claude Code version against the one sub-human's internals were checked on (and, when it differs, the internals themselves);
- settings that turn hooks off;
- the web listener, when this machine serves a room over the web: running, its pid and port, the rooms it serves; with Tailscale, that `tailscale serve status` still lists each room's path, and with Funnel a warning that the name is public (certificate-transparency logs). A link over the web gets its hello through the real WebSocket and pinned Noise channel;

`--quick` skips the hello and the internals check. `--fix` (in a terminal only) rewrites the shim and its pointer and closes the home's modes. `--bundle [FILE]` writes the same report as JSON for a bug report, redacted: it holds versions, settings, check results, link states and recent link errors, never a message; paths under your home become `~`, room codes, host names, user names and IP addresses are hashed, and SSH keys, tokens and invites are removed (a key is cut to a fingerprint prefix). Read it before you attach it.

The room row shows the link too, in a room hosted elsewhere, in the same words as `doctor`, the tail and `~/.sub-human/links/CODE.state.json` (online, connecting, offline, stopped, fork): `✕ offline 2m · 2 queued`, `… connecting (3)`, `✕ stopped` or `✕ out of step: /sub-human doctor` first while it is not online, and `⇄ online` at the end while it is.

## The room tail

In a session that has joined a room, the plugin's hooks module runs one `node` child, `sub-human tail`, for the session's life: it follows the room's log and hands each new line to the module, which shows it, gives your Claude its copy, or wakes it. The child restarts by itself if it exits, and stops when the session ends or leaves. A session that never joins a room starts no child.

## Settings worth knowing

- **Your own `subagentStatusLine` hides the row text.** The rows' text (who said what, tasks, presence) comes from the plugin's `subagentStatusLine`. Claude Code lets any `subagentStatusLine` in your user, project or local settings, or one passed with `--settings`, override a plugin's, so with one set the rows show your status line instead. Remove it (or run it only outside rooms) to get the room text back.
- **Bypass mode.** In `--dangerously-skip-permissions` (bypass) mode, Claude Code holds incoming `SendMessage`s from other sessions behind a dialog until you answer it. The join message warns you. Use a normal permission mode in a room if you want other Claudes' messages to reach yours without a dialog.

## Room storage

Everything the plugin keeps lives in `~/.sub-human/` (rooms, seats, seat keys in `keys/`, the row launcher in `bin/row-status`, the SSH serve shim in `bin/serve`), or in `$SUB_HUMAN_HOME` when that is set. Set it the same way for every session that should share rooms: sessions with different homes never see each other, except through a link (see **Join from another machine**). Rooms live in `<home>/rooms/<CODE>/`. Each has an append-only JSON-lines log. Every entry carries `from`, `via` (`human`, `agent` or `system`), `kind` and a `prev` hash of the previous line, so edits are visible. The log is kept in segments of about 1 MiB: `log.jsonl` is the newest, older ones are `log-0001.jsonl`, `log-0002.jsonl` and so on, and `snapshot.json` sums them up so a session reads the newest segment only. An open room's log is kept whole. **Closed rooms disappear after 30 days:** a room everyone left (a seat whose session crashed has not left), with its room session stopped and no link to it or from it, untouched for 30 days, is set aside the next time someone joins a room on this machine (never the room being joined): it moves to `rooms/<CODE>.gc-<time>` and its seat keys to `keys/<CODE>.gc-<time>`, and both are deleted 30 days later. Rename them back to bring the room back. Session records of sessions that ended 30 days ago are deleted. Proposals are stored by hash in `plans/`, the task mirror in `tasks.json`, and row state in `rows/`. On a machine that joined a room hosted elsewhere, `<home>/links/<CODE>.json` is the link (with its token; file 0600) and `<home>/links/<CODE>.log` its log; `rooms/<CODE>/` there is the mirror, written only by the link.

## Threat model

The security model is one machine, one OS user, per room: everyone on the host is a trusted collaborator running as that same user, so names aren't defended against forgery between people. **The host is trusted** by everyone who joins it: it holds the room, places every entry and decides proposals. The goal is narrower: **a model can't speak or consent as a person through anything sub-human gives it**. That covers any member's Claude, including one steered by text someone posted in the room: no tool, hook or command of the plugin writes `via=human` for it, and it can't hide an entry. One limit is the machine's, not the plugin's: a Claude with `Bash` runs as the same user as the seat key, and the guards that keep it from the key are lexical checks (see **Bash guard**), so a Claude steered into building the key's path at run time could sign as that seat. The hash chain still shows a line written around the store.

- Agreement and objection come only from the plan view or the card, which the human answers. A plan text edited before "Yes", answers that come with the model's call, an AFK timeout or a stale hash are dropped. The only dialog-free exit the hooks allow records nothing.
- Your words reach the room only through `@room`, posted by a hook. Your Claude's posts are always labelled `via=agent`. `SendMessage` between sessions is Claude to Claude.
- **Seat keys.** Each seat gets an Ed25519 key pair when it joins, stored in `<home>/keys/<CODE>/` (directory 0700; `NAME.key` and `NAME.pub` 0600). The join writes the public key into the room's log, which pins it: a name is its key for the room's life, and a later join under that name with another key is refused (a lost key means a new name). Every `via=human` entry is signed with the seat's private key. The signature covers what was said, the room, a random nonce and a timestamp, not the entry's place in the log; the store refuses a nonce it has already placed and a timestamp more than 10 minutes off. Only hook processes load that key, and Claude Code runs hooks itself; a model never does. The room MCP server, the CLI and the room tail never load it, so they can't write `via=human` at all; the store refuses the append. Readers check the signature against the pinned key. A `via=human` line without a valid signature shows as `bob (unverified): …`, and consent never counts it; Claude reads the room through the `read` tool as the same rendered lines, the marker included, with no signature material. Logs from before keys were pinned still read: their signatures check against the local `NAME.pub`, and an unsigned answer from a seat with no key still counts, marked unverified. A room that pins any key never counts an unsigned answer.
- **Who typed it.** The plugin's hooks module reads the origin Claude Code itself stamps on each prompt (only your own Enter, `-p` or Remote Control count as typed) and drops an `@room` that you didn't type (from another session, a notification, another plugin) before any hook runs. It hands that origin to the hook that signs the post together with a secret nonce the module makes for your session and keeps in its lease file (`<home>/sessions/mods/`, 0600). The hook posts only when the origin is typed and the nonce matches the lease; a post whose origin it can't see or trust is refused, and you type it again. Forging one takes reading that lease file, which the guards below deny to `Read`, `Grep` and `Glob` and to a Bash command that names or globs its path: a lexical check (see the Bash guard), not a wall.
- **`@room` fails closed.** If the module's hook for the prompt fails in any way, an `@room` is refused with a short notice. It is never passed on to your Claude as an ordinary prompt.
- **Store guard.** The plugin's function hooks module (`mod/guard.ts`, Claude Code 2.1.292+) denies `Write`, `Edit`, `MultiEdit` and `NotebookEdit` into the store (`~/.sub-human` or `$SUB_HUMAN_HOME`, checked lexically and after resolving symlinks), so a Claude can't edit the log with its file tools. It runs in-process on every such call, so it costs no process start, and it learns where the store is from the plugin itself when the session starts. It also lets joined sessions use the room tools without a prompt, and refuses `hold` to anything but a row agent. It never answers a tool call in a way that skips other hooks: your own and other plugins' `PreToolUse` hooks still run on the room tools. Where function hooks are off (`--bare`, safe mode, a policy that turns hooks off) a session can't join a room.
- **Bash guard.** The same module checks every `Bash` command and denies one that:
  - names the store (its path, `~/.sub-human`, `$HOME/.sub-human`, the keys under it), or reaches it by a glob, a `?`, a brace or a `cd` (each word is placed as the shell would: `~` and `$HOME` expanded, ANSI-C quoting such as `$'\x68'` decoded wherever the shell decodes it (also inside `"${…}"`; a quoted heredoc's body is literal), `$"…"` read as a quoted string, `${NAME:-word}` also read as its word, relative to the working directory or the last `cd`, glob segments matched against the store's path; a `$'…'` it cannot read whole is denied);
  - points a tool that walks or reads a tree (`grep -r`, `rg`, `ag`, `find`, `fd`, `tar`, `zip`, `cp -r`, `xargs`, `python`/`node`/`perl` code, `sh -c`) at a directory above the store (`/tmp`, `~`, `/`), or at the working directory when that is above it;
  - reads Claude Code's prompt history (`~/.claude/history.jsonl`) or this session's transcript, where an invite line and its PIN can be;
  - names or sets `SUB_HUMAN_HOME`;
  - runs the plugin's own modules or hooks with `node`, `bun`, `deno` or `npx` (`lib/room*`, `lib/identity`, `lib/proposal`, `hooks/*.ts`, `hooks/handlers/*.ts`, `mcp/*.ts`, and their `.js` names of earlier versions).

  The read-only CLI (`<plugin root>/scripts/sub-human read`, `who`, `tasks`, `plan`, `show HASH`, `verify CODE`) stays allowed, and so do reading the plugin's source and running its tests. This is a lexical check of the command's words, and a model with `Bash` as the same user can still get past it: a path built at run time (a variable, string arithmetic in an interpreter), a script written to a file first, a symlink made first. So the seat key's signature proves a person's words only against a Claude that has not been steered into reading the key: a Claude that reads it can sign as that seat. What the guard does not stop, the log still shows when it is written around: a line placed outside the plugin breaks the hash chain or carries no valid signature (`sub-human doctor` checks every hosted room's log, `sub-human verify CODE` one room), and an unverified line counts for nothing.
- **Read guard.** The same module denies `Read`, `Grep` and `Glob` inside the home's secret directories: `<home>/keys/` (the seat keys, the one file a model could sign a person's words with, and the machine key), `<home>/listen/` (the web listener's private key), `<home>/links/` (each link's token, a pending invite's SECRET and PIN, a web link's own key) and `<home>/sessions/` (the module's lease with your session's nonce, and the session indexes); and Claude Code's prompt history and this session's transcript. A `Grep` from the home itself or any directory above it (`~`, `/`) is denied too, since ripgrep would descend into them; search a narrower directory. A `Glob` lists names only, so it is denied only inside those directories. (A Claude Code build that searches through `Bash` has no `Grep` or `Glob`; the Bash rules above then apply.) The rest of the store stays readable, so a model can read the log and the plans with `Read` too. Other MCP servers that read or write files aren't guarded, and neither is a script that reads the key: the guard is a lexical check.
- **Not covered.** Other MCP servers, and a hostile local user.
- **File modes.** The home and every directory in it are 0700 (a home an older version made 0755 is closed when a room is opened), and the log and state files are 0600.
- **Row launcher and serve shim.** The status-line launcher in `<home>/bin/row-status` and the SSH serve shim `<home>/bin/serve` run only plugin roots outside temp directories (`/tmp`, `os.tmpdir()`), unless `SUB_HUMAN_ALLOW_TMP_ROOT=1` is set.
- Only a task's owner, through their own Claude's `done` request, can complete it.

Remote rooms add:

- **An invite is shown once** and works for one machine; the host keeps only its hash. An invite is untrusted input: its locator is a plain `user@host[:port]` (or a home path, the tests' and the demo's pipe) with plain jump hosts (ssh), and the link always runs this plugin's own server, or `ssh` with fixed options, never a command or an ssh option the invite names.
- **An invite has two parts, and each guards against something else.** The line carries a **SECRET**: 128 bits of single-use randomness, plus a 64-bit tag of the host's key (keyed by those 128 bits). The host tells the 4-digit **PIN** apart from the line, and checks it online. The host keeps only `sha256(secret)` and `sha256(secret:PIN)`, so its own store gives the PIN to nobody who lacks the line.
  - *The SECRET* stops anyone without the line: there is nothing to guess (2^128), and an unknown secret is answered "unknown" with nothing charged. Single use: once a PIN held for it, the invite is used.
  - *The tag* stops a line from being spent on the wrong host: before the SECRET goes anywhere, the joiner checks that whoever answered holds the key the tag names (the web listener's X25519 key, read and checked before the Noise handshake; over ssh and a pipe, the host home's Ed25519 machine key, which signs the joiner's fresh nonce). Someone in between, or a line typed against another host, gets nothing at all, not even the SECRET. 64 bits is enough because the tag is keyed by the secret: nobody can grind a key to match it without the line, and a line holder has 15 minutes.
  - *The PIN* stops someone who got hold of the line (a chat log, a shared screen, a forwarded mail): it is checked only online, by the host, 5 tries per invite (the fifth wrong one burns it, as do 15 minutes or its one use), throttled after each wrong one (the invite takes no PIN for 2, 4, 8, 16 s; the machine that typed it, by its machine key, waits one step longer; a throttled PIN costs nothing). Each wrong PIN is a room line. A stolen line gives 5 guesses in 10,000, then the invite is gone. The PIN is checked inside the channel the tag checked, so nobody in between sees it.
  - *The card* stops a lucky guess and the person you did not mean: a PIN that holds is not the admission. It makes a join request bound to the machine whose key typed it (and, over the web, to the Noise key its connection proved); only the host person's **Let in** on the card admits it (`hooks/consent.ts`: only the answer on the card as the hooks built it counts, never the model's; the answer is signed with that person's seat key), or `sub-human admit REF` in a shell. Unanswered requests lapse after 10 minutes. The machine let in joins as the one name on the card.
  - *The key binding* stops a stolen token: a link made over the web is bound to a key of its own (made for that link on the joiner's machine, proven on every connection by Noise XK), so its token alone gets nowhere. Over ssh the link rides the person's own login, which is the binding.
- **The SECRET and the PIN are kept from the model.** `invite` shows them to the person only: through the hooks module the line and its PIN are pinned on the plugin's status line under the prompt until the invite expires, which Claude Code saves in no transcript (a `sub-human:` notice is saved there, so the notices only say where they are; without the module, the classic hook's hidden block shows them, never a systemMessage); in Claude Code's `!` shell `sub-human invite` masks both; every `/sub-human join`, `invite` and `admit` prompt, and any `/sub-human` prompt with a word of digits or a SECRET-shaped word (32 to 48 letters and digits), is answered with a hidden block before its form is even sorted out (a mistyped PIN, an unknown flag), and a SECRET-shaped word is never echoed back; for the same reason neither the line nor the PIN takes the seat in that step (the seat's context would go to the model with the prompt), and a bare `/sub-human` does once the host has let you in; the link file holds the SECRET (0600) until the token comes and the PIN only until the host answers it; neither is in a log or room line, and `doctor --bundle` cuts any lone 4- or 6-digit number. **History caveat:** what you type at Claude Code's prompt stays in its prompt history (the up arrow, `~/.claude/history.jsonl`) and in the session's transcript; the guards deny a model reading either (the Read and Bash guards above, lexical checks), and after a burn or a use the line and the PIN are worthless.
- **Over SSH, the joiner's own login is the way in, and sub-human writes nothing to `authorized_keys`.** An ssh invite line still goes through its PIN and the card, and the link it makes is bound to the one name, not the account owner's. Someone with no login on the host is invited over the web instead.
- **An ssh login to the host's account is trusted as that account.** `/sub-human join USER@HOST ROOM` runs `serve --login` over the joiner's own login, and the server then makes a link with no invite, because that login could make one anyway. A restricted key can't get there: `serve --login` refuses to run under a forced command (`SSH_ORIGINAL_COMMAND` is set). Give someone a login to your account only if you would give them the account.
- **A link token is a seat-level credential** (over the web, together with the link's own key). The invite turns into a token once the card let the machine in. It is stored in clear in `<home>/links/<CODE>.json` (0600, the same trust as the seat key) and hashed on the host. Whoever holds it can post as the seats joined over that link, never as anyone else: the host checks every entry's `from` against them and its signature against the key pinned in the log.
- **Keys are pinned strictly.** A name is its key for the room's life, on every machine. A lost key, or the same name from a new machine, means a new name.
- **Addressed posts are not private.** A post to one person (`to`) has its own rate limit, but the whole room reads the log, on every machine.
- **A link's ops are bounded.** A seat's own posts and answers are limited to 300 a minute on its own machine (a script driving the hooks would meet that). Over a link the host keeps one quota per op (a seat elsewhere holds its own key and token, so a script there could send as fast as it liked): 30 posts a minute per person and per Claude, 40 new plans stored an hour, 30 plan versions and 60 task requests a minute, 60 subscribes and 30 joins or leaves per 10 minutes, and caps on hellos, beats, plan fetches and pings, counted per link (or per seat, or per connection) so a reconnect resets nothing. Typing at a keyboard never meets them; over one the host answers `RATE` and when to try again.
- **A machine is its key.** Each sub-human home has a machine key (`~/.sub-human/keys/machine.json`); a link proves it, and the host records the machine's id from the key, not from what the link says. No link can pass for the host or another member's machine (which decides whose seat is local, and whose seat is the host person's own).
- **An admitted machine joins as the one name on your card.** The link your Let in makes can take that seat and no other (a name no one holds included); a second seat, or another name, is refused. Your own ssh login's link (no card) picks its name as you do.
- **The guard denies `sub-human invite`, `admit`, `kick`, `listen`, `link`, `serve` and `doctor --fix` to a model** (a plain `sub-human doctor` is read only and allowed), and `/sub-human invite` shows the line and its PIN to you, not to your Claude.

Over the web (Tailscale Serve, Funnel or your own front), who sees what:

- **The listener binds `127.0.0.1` only.** Nothing on your LAN can reach it; Serve, Funnel or your front is the only way in. Before a Noise handshake completes it holds at most 16 connections in handshake (64 in all, 8 from one source), gives each 10 seconds, and takes frames of at most 64 kB. A connection that completed its handshake but makes no link within 10 seconds is closed, with its serve process.
- **Tailscale (or your front) ends TLS, not the room's encryption.** It sees which IPs connect, when, and how many bytes; Funnel's relays see the same. Inside the WebSocket every byte is Noise XK ciphertext (X25519, ChaCha20-Poly1305, SHA-256, from `node:crypto` only; checked against the published cacophony and snow test vectors), keyed to the listener's own X25519 key (`<home>/listen/host-x25519.json`, 0600, random, one per home, used for nothing else) and to the link's own key. The joiner checks the listener's key against the invite line's tag before the handshake, then pins it: a front that answers with another key gets `… is not the one the invite line names` (or later `the host did not prove the key this link pinned`) and nothing secret is sent. The path names the room. The only plaintext before Noise is the key request and its answer (a public key).
- **Funnel's name is public** (certificate-transparency logs), so expect probes: without an invite line a probe gets nothing (an unknown SECRET is charged nothing and grants nothing); with a stolen line a guessed PIN costs one of 5 tries, every wrong one is a line in the room, and even the right PIN gets only as far as your card.
- **The host is still trusted**: the listener hands decrypted bytes to `serve --stdio CODE`, which checks the hello exactly as over SSH.

The plugin doesn't stop a hostile local user, who can read the keys and write the files directly. The hash chain makes such edits visible. It doesn't prevent them.

## Troubleshooting

Start with `/sub-human doctor` (see **Doctor**): it names most of these and the fix.

| Symptom | Fix |
|---|---|
| "Unknown command" for `/sub-human` | Launch with `--plugin-dir plugin/sub-human`, or install the plugin. |
| `/sub-human` asks which room | More than one room is open, so add it: `/sub-human NAME ROOM`. |
| `✗ "NAME" is taken in room …; pick another: /sub-human NAME` | Your default name (from git) is someone else's in that room. Type a name: `/sub-human dana2`. |
| "the room session could not start" on join, or `Workspace not trusted` | Run `claude` in that folder once and accept trust, then join again. Without the room session the room still works: tasks are kept, but no session shows them as a native list and the room session's rows are missing. |
| No rows in the panel | Accept workspace trust for this folder. After a resume they come back by themselves. |
| A sign-off request didn't open | Ask your Claude to "show me the plan to sign off". `node <plugin root>/scripts/sub-human plan` in a terminal shows each plan's state, `node <plugin root>/scripts/sub-human plan NAME` its text and `show HASH` a version's. `sub-human` is not on the PATH, in a terminal or in a session. |
| `✗ sub-human needs Claude Code 2.1.292 or newer, and this is …` | Update Claude Code (`claude update`) and restart it. |
| `✗ sub-human's hooks module isn't running in this session (…)` | `/sub-human doctor` (it still runs) checks the usual causes: a settings file with `disableAllHooks` or `allowManagedHooksOnly`, or Claude Code's hooks-modules switch off. Start `claude` without `--bare` or safe mode, in a folder you trust. |
| `the connection to room … stopped (…)` | The link stopped for good: the host refused or revoked it, or the room closed. The reason says what to do (usually a new invite from the host: `/sub-human invite` there). A closed room reconnects with `/sub-human` if the host opens it again; `sub-human link CODE --forget` drops it for good. |
| `the connection to room … is down` | The link can't reach the host. It retries by itself (from 1 s, with jitter, up to 10 s; at once after a wake or a network change); `@room` posts are queued, answers are refused, until it is back, and `the connection to the room is back` says when (and how many queued posts went out). `~/.sub-human/links/CODE.log` says why; `~/.sub-human/links/CODE.state.json` holds the link's state. |
| `the connection to room … isn't running` | The link's background process on this machine is gone (crashed or killed). The next `@room` queues the post and starts it again; `/sub-human` starts it too. The room row reads `✕ not running` meanwhile. |
| `this machine's copy of room … no longer matches the host's` | Nothing more syncs. Forget this copy in a terminal (`node <plugin root>/scripts/sub-human link --forget CODE`), then join again with a new invite from the host. |
| SSH join: `room … is offline` and the link log says `Permission denied (publickey)` | Your ssh login to the host's account does not work without a prompt (for a link an older version made, its own key was removed). The link uses `BatchMode=yes`, so it never asks for a password or a passphrase: load the key into your agent, or name it in `~/.ssh/config` (or `SUB_HUMAN_SSH_OPTS="-i KEY"`). |
| SSH join: `Host key verification failed` in the link log | ssh has not seen the host yet and BatchMode can't ask. Run `ssh me@host true` once in your shell to accept its key. |
| SSH join: `no room` in the link log | The host's folder is not where the line looked: an invite line from a host whose folder is not `~/.sub-human` carries `--home PATH`; type the whole line. |
| `wrong PIN (N tries left) … /sub-human join PIN` | Check the digits with the host and type `/sub-human join PIN` again (after a wrong one, wait the seconds it says). After 5 the invite stops working: ask for a new one. |
| `that invite line comes from an older sub-human on the host` | The host's line ends with a 4-digit PIN: it runs a version before invite lines. Ask them to update and invite you again. |
| `the line's SECRET … did not come through whole` | The long last word of the line was cut or changed by the way it was sent. Paste the whole line again. |
| `the host's machine checked your PIN. A card there now asks them…` and nothing more | The host person has not answered their card yet (their Claude opens it; or `/sub-human admit` there). Once they let you in, type `/sub-human`. After 10 minutes it lapses: ask for a new invite. |
| `… is not the one the invite line names … Nothing secret was sent` | Whoever answered (the ssh host your address reached, or the listener at that URL) does not hold the key the line's SECRET names: a wrong address or alias, a reinstalled host, another host with the same room, or someone in between. Check with the host. |
| SSH invite: `refused your ssh login` | An ssh invite rides your own ssh login to the host's account, and you have none there (or it needs a password). Ask for `/sub-human invite --web`, or have a login set up. |
| Web join: `the host did not prove the key this link pinned` | Whoever answered at that URL is not the listener the link was made for (a changed host key, the wrong front, or someone in between). Ask the host for a new invite. |
| Web join: `still connecting (Tailscale may be issuing a certificate …)` | A new ts.net name's first TLS handshake waits on its certificate (~20 s). The link keeps trying; type `/sub-human` in a moment. |
| Web join: `still connecting` and the link log says `answered 502` / `404` | The front reaches no listener: on the host, `sub-human listen --status`; with Tailscale, `tailscale serve status` should list `/sub-human/CODE`. Run `/sub-human invite --web` again. |
| Web join: `TLS to …: unable to verify` in the link log | The joining machine does not trust the front's certificate. A ts.net certificate is public; for your own front set `NODE_EXTRA_CA_CERTS`. |
| `AUTH` after upgrading the plugin | A seat that joined before keys were pinned can't post as you. Rejoin with `/sub-human NAME ROOM`; if the name's key is lost, join with a new name. |

## Limits

- **Remote joining needs SSH** to the host's account, or a front the joiner can reach over HTTPS (Tailscale Serve or Funnel, or your own). There is no relay for two laptops behind NAT without one.
- **A name is one machine's**: its key stays where it joined first.
- Agent posts are rate-limited, so Claudes can't wake each other in a loop; a person's own posts have a higher limit.

## Leaving

`/exit` asks Claude Code's own question about background work, because your room row is a background agent:

```
❯ 1. Exit and stop tasks
  2. Move to background and exit
  3. Stay
```

Choose **1**. The room records that you left, and your row reads `left` in everyone's panel until you rejoin. A plugin can't mark an agent as safe to stop, so Claude Code always asks this question. `/clear` does not leave the room. When the last person leaves, the room's Claude is stopped and the room closes. The room's `tasks.json` stays.
