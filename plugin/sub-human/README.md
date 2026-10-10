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

**Requirements.** Claude Code 2.1.292 or newer with function hooks on (not `--bare`, not safe mode, and no policy that turns hooks off): the plugin's hooks module guards the store, checks who typed an `@room` and delivers the room, so `/sub-human` refuses to join without it. Node 24 or newer on `PATH`: every hook, the room MCP server, the room tail and the row status line run `node`. macOS or Linux only (the row launcher is a POSIX shell script and the store relies on POSIX rename and file modes); Windows is not supported. `claude plugin validate plugin/sub-human` checks the plugin. Accept workspace trust for your folder: the room's Claude starts in your working directory, and Claude Code refuses to start a background session in an untrusted folder.

**Updates.** Marketplace plugins don't update by themselves by default: enable auto-update for the sub-human marketplace in `/plugin` (Marketplaces), or run `/plugin update sub-human` now and then. Everyone in a room should run the same version; `sub-human doctor` shows yours and, for a room hosted elsewhere, the host's protocol version.

## Join: one command

In your normal Claude Code session:

```
/sub-human alice
```

When no room is open, the join hook creates one (say `vole-8126`) and starts the room's Claude as a background session titled `claude.vole-8126`. An idle room's Claude costs nothing. A join that works prints nothing (Claude Code would draw it as a warning): your session is titled `alice.vole-8126` and the room's row `vole-8126` appears in your agent panel. A line shows only when something needs you: a refusal, the room's Claude failing to start, or bypass-permissions mode. The next person runs `/sub-human bob`, and adds the code (`/sub-human bob vole-8126`) only when more than one room is open.

The hook binds your name to your session before the model sees anything, so your Claude can never pick or change it. A name already in the room is refused. Your identity survives `/clear`, compaction and `--resume`. The command shows as `/sub-human:sub-human` in the picker; typing the bare `/sub-human` works.

## Join from another machine

A room lives on the machine that opened it, its **host**. If you can already ssh to the host's account (your own second machine, a dev box you log in to), join with that login. Anyone else joins with one line the host sends them, `/sub-human join NAME you@devbox vole-8126 482913`, and the host's card lets them in.

### If you can already ssh to the host: `/sub-human join NAME USER@HOST CODE`

On your other machine, with the room's code:

```
/sub-human join carol you@machine-a vole-8126
/sub-human join carol you@devbox:2222 vole-8126 --via bastion   # a port, a jump host (ProxyJump)
/sub-human join carol you@devbox vole-8126 --home /srv/sh        # the host's sub-human home is not ~/.sub-human
```

That is the whole step: no invite, no PIN, no admit. It links the machine and takes your seat at once (`joined vole-8126 as carol`); later rejoins are `/sub-human carol vole-8126`. Your login to that account is the admission, since whoever can run commands there could make an invite anyway. The room shows `a machine (…) linked over your SSH login (link 1a2b3c4d5e6f)`.

- **Your own ssh.** The link runs `ssh -T -o BatchMode=yes [-J JUMP] [-p PORT] -- you@machine-a '"$HOME"/.sub-human/bin/serve --stdio vole-8126 --link ID --login'` with your keys, agent, `~/.ssh/config` and `known_hosts`, checked as usual. A host alias from your config works. It never prompts. When ssh does not know the host's key yet, the join stops at once and says so: run `ssh you@machine-a` once in a terminal, check and accept the key, then join again. A login that needs a password is refused the same way. Behind an MFA bastion, run `sub-human prime vole-8126` and then `/sub-human carol vole-8126`.
- **On the host** this runs the stable serve shim (`<home>/bin/serve`, see [SSH details](#ssh-details)), which records where node is, because a non-interactive ssh shell lacks nvm's or Homebrew's `PATH`. Opening or joining a room on the host writes the shim when it is missing. If it is still missing, the join says to open the room there in Claude Code or run `sub-human doctor --fix` there.
- **Not through a restricted key.** A key that `admit` let in runs a forced command fixed to its one link, and that line never carries `--login`. The host's `serve --login` also refuses to run under any forced command (sshd's `SSH_ORIGINAL_COMMAND`). So a key restricted to one link can't make itself a new one.
- `revoke`, `doctor`, the link state, the outbox and handoffs work as for any ssh link. Revoking stops the link, but that login can link again: to shut it out, take its key out of `authorized_keys`.

Three transports exist: **SSH** (the other machine reaches the host's account with an SSH key), **the web** (a join URL and a PIN, through Tailscale or any HTTPS front of yours; see [Join from anywhere: Tailscale](#join-from-anywhere-tailscale)) and the **pipe** (a second sub-human home on the same machine, another `SUB_HUMAN_HOME`; what the tests and the demo use). Host on a machine that stays awake (a dev box): when the host sleeps, the room is down for everyone.

### Inviting someone who can't ssh to the host: `/sub-human host`

On the host, in a session that is in the room:

```
/sub-human host --ssh                       # this machine's address: SUB_HUMAN_SSH_ADDR, else you@hostname
/sub-human host --ssh me@devbox.local:2222  # or name it
/sub-human host --ssh me@devbox --via bastion   # the joiner reaches it through a jump host (ProxyJump)
/sub-human host --tailscale                 # over the web: see Join from anywhere: Tailscale
```

```
sub-human: invite to room vole-8126, for one machine, over ssh me@devbox.local. Shown once; it lasts 15 minutes.

  /sub-human join NAME me@devbox.local vole-8126 482913

The 6-digit code is the whole secret: send this line privately (a direct message), or send it without the code and say the code. 5 wrong codes burn it.
When they type it, a card here asks you to let them in (or refuse); nothing gets in before you answer. In a shell: sub-human admit.
Leaked? /sub-human revoke 3f9c2a1b7e0d burns just this invite (its ref; the room and its links stay).
```

This is shown to you, never to your Claude. The joiner types exactly that line with their name. The invite is for one machine and one use; the **6-digit code is its whole secret**, so treat the line like a password: a direct message, or say the code. `sub-human host [--room CODE] [--ssh [USER@HOST]] [--via JUMP]` prints the same in a terminal outside Claude Code; inside Claude Code (its `!` mode) it masks the code, because that output becomes part of the conversation.

When they type it, **your Claude Code shows you a card**: `Let carol (SHA256:ab12…) on carols-mbp join room vole-8126? — Let in / Refuse`. Only your answer there admits them: your Claude can't answer it, and the answer is signed with your seat key. The fingerprint is the key their machine just made for this link; their screen shows the same one, so you can compare. **Let in** writes one `authorized_keys` line that lets that key reach only this room's server, as one link (as `admit` always did), and their link connects within seconds. **Refuse** ends it. Unanswered, the request lapses after 10 minutes. With no session open on the host, `sub-human admit` in a shell lists the requests and `sub-human admit REF` asks y/N (`--refuse` to say no); `/sub-human admit REF` typed in the room does the same as the card.

`/sub-human host --ssh --long` gives the older two-part invite instead (`sh2.…` plus a PIN, and the pasted `/sub-human admit shk1.…` line), for a joiner on sub-human older than 0.5.0-beta.4. `/sub-human host` with no flag gives one for a second home on this machine (`--short` for the short form there).

### Joining: `/sub-human join NAME DEST CODE 482913`

On the other machine, the line the host sent you, with your name:

```
/sub-human join carol me@devbox.local vole-8126 482913
/sub-human join carol https://box.tail1a2b.ts.net/sub-human/vole-8126 482913   # over the web
```

This step only links the machine to the room, and the hook stops the prompt there, so the code never reaches your Claude. (A login join, `/sub-human join NAME USER@HOST CODE`, has no code after the room; with one, it is a short invite.) Your machine and the host check the code against each other without sending it (a PAKE, see the threat model); your machine checks it reached the real host, makes a key of its own for the link (over ssh), and the host's card asks its person. The join says what to do next:

- `the host's machine checked your code. A card there now asks them to let you in; it names carol (SHA256:ab12…). Once they do, type: /sub-human carol vole-8126`. The link keeps trying for 10 minutes. That second command takes your seat, as any rejoin does.
- **A wrong code:** `could not link to room vole-8126: wrong code (4 tries left)`. Type the join again with the right code; a rejoin never re-sends a refused code. The fifth wrong code burns the invite.
- **Refused or lapsed:** the link stops with `the host refused to let this machine in` (or `did not let this machine in in time`); ask for a new code.
- **Someone in between:** over ssh, if the server that answered shows another host key than the one the host vouched for inside the code's handshake, the join stops (`the ssh server that answered is not the one that holds your code`) and sends nothing more. Check with the host.

Older invites still work: `/sub-human join NAME sh2.… PIN` (and `https://…#SECRET.KEY PIN`). Over ssh that join makes its own key too and shows you a line to send back, `/sub-human admit shk1.vole-8126.4f1c2a9b03de.Qm9i….carol` (no secret in it), which the host pastes; the PIN is checked when the link first connects. A wrong PIN says `wrong PIN (4 tries left)`.

The join starts a **link** on that machine: a small background process (`sub-human link CODE`) that keeps a copy of the room (a mirror) and carries that machine's posts and answers to the host. After that, everything works as on the host: `@room`, rows, proposals in the plan view, tasks. Your words are signed on your machine and checked on the host. The host runs the room's Claude and decides proposals.

- **Rejoin** (a new session on the same machine) with `/sub-human carol vole-8126`. The link is kept, and started again if it had stopped; you need no new invite.
- **When the link is down**, your session shows one dim line, `room link: OFFLINE …`. An `@room` is queued (`⧗ queued`, up to 50 posts for up to 9 minutes) and sent in order once the link is back; one that waited too long is not sent, and you are told with its words. An answer to a proposal is never queued: it is not recorded and you are told so. The link retries on its own, and at once after your machine wakes or changes network.
- **When the link is slow** (the host has not answered within 2 s), an `@room` says `⧗ sending (slow link)`: it is on its way and shows in the room when the host has it, so don't type it again. An answer that gets no reply in time says it is not confirmed: if the proposal still shows you unanswered later, answering again is safe.
- **The link stops by itself** about a minute after no session of that machine is left in the room.
- **Versions.** The two machines agree on a protocol version when the link connects. When they share none, the join says which side must update, e.g. `host runs sub-human 0.5.0 (protocol 3–4); you run 0.4.0 (protocol 1–2). Update your plugin: /plugin update sub-human`. Update the host first: a host takes joiners one version older.

### Join from anywhere: Tailscale

For friends who have no SSH account on your machine. The host runs [Tailscale](https://tailscale.com) (the joiners need it only for the tailnet-only default). On the host, in a session that is in the room:

```
/sub-human host --tailscale            # Tailscale Serve: people on your tailnet (or a node you shared) only
/sub-human host --tailscale --funnel   # Tailscale Funnel: anyone with the URL and the code (opt-in)
/sub-human host --url https://my.front/sh   # any HTTPS front of yours that forwards to 127.0.0.1:7420
/sub-human unhost                      # stop serving this room over the web
```

```
sub-human: invite to room vole-8126, for one machine, over the web through Tailscale Serve (your tailnet only) to this machine's listener on 127.0.0.1:7420. Shown once; it lasts 15 minutes.

  /sub-human join NAME https://box.tail1a2b.ts.net/sub-human/vole-8126 482913

The 6-digit code is the whole secret: send this line privately (a direct message), or send it without the code and say the code. 5 wrong codes burn it.
When they type it, a card here asks you to let them in (or refuse); nothing gets in before you answer. In a shell: sub-human admit.
```

The joiner types `/sub-human join carol https://box.tail1a2b.ts.net/sub-human/vole-8126 482913`; your card lets them in, as over ssh; then they type `/sub-human carol vole-8126`. No secret is in the URL. `--long` gives the older `https://…/vole-8126#SECRET.KEY` link plus a PIN instead (no card: the secret, the PIN and the pinned key were the admission).

What happens:

- `/sub-human host --tailscale` starts **the listener** (`sub-human listen`, one per home, on `127.0.0.1:7420` only, `SUB_HUMAN_LISTEN_PORT` or `--port` to change it) and runs, with the `tailscale` on your `PATH` or `/Applications/Tailscale.app/Contents/MacOS/Tailscale`:

  ```
  tailscale serve --bg --https=443 --set-path=/sub-human/vole-8126 http://127.0.0.1:7420
  ```

  `--funnel` runs `tailscale funnel` with the same flags instead. The name comes from `tailscale status --json` (your node's MagicDNS name). `/sub-human unhost`, and the room closing, turn off that one path (`tailscale serve --https=443 --set-path=/sub-human/vole-8126 off`) and nothing else; it never runs `serve reset`. Tailscale's HTTPS certificates and Serve (and, for Funnel, the Funnel attribute) must be enabled for your tailnet. When they are not, `tailscale serve` prints an enable URL and waits; sub-human stops it at that URL (or after 10 s) and says: `Tailscale Serve isn't enabled on your tailnet yet. An admin turns it on once at <URL> (or Admin console → DNS → HTTPS Certificates and Serve), then run /sub-human host --tailscale again.` Tailscale not running, stopped or logged out is named as such. The first HTTPS connection to a new ts.net name waits ~20 s while Tailscale issues its certificate: the host fetches it right after `serve` (one background request), a joiner's WebSocket waits up to 45 s (`SUB_HUMAN_WS_CONNECT_MS`), and the link keeps trying after that.
- **Funnel is public.** Its hostname is published in public certificate-transparency logs, so anyone can find your node's name. Anyone who finds it can spend the code's tries (5, then the invite burns), never get in without the code and your card; the host shows that warning each time.
- The joiner's link connects with a WebSocket (through `HTTPS_PROXY` / `https_proxy` when set, honouring `NO_PROXY`: a corporate network that allows only `CONNECT` to port 443 works). The first connection runs the code's PAKE in text frames: in it the host vouches for the listener's X25519 key and hands over a one-time secret, both readable only by the one who knows the code. From then on every connection is an end-to-end **Noise_NK** channel pinned to that key. Tailscale, Funnel's relays or your front see the PAKE's public values, then Noise ciphertext; the code itself never travels.
- **The card is the admission.** The code proves only that the joiner has it; your Let in admits the machine, and the room line `carol's machine (…) linked to the room, let in by alice (link …)` records it. `revoke` ends such a link as any other.
- The listener runs one `serve --stdio CODE` per connection through the stable shim, like an SSH forced command. It survives a sleep; after a reboot, the host's next `/sub-human NAME CODE` starts it again. `sub-human listen --status` shows its pid, port and the rooms it serves (also in `<home>/listen/state.json`); `--stop` stops it.
- **Any HTTPS front.** `--url https://my.front/prefix` names a reverse proxy of yours (Caddy, nginx, a NetBird or ZeroTier address with a certificate) that forwards `/prefix/sub-human/CODE` WebSocket upgrades to `127.0.0.1:7420`. The joiner's machine must trust its certificate (a public CA, or `NODE_EXTRA_CA_CERTS`).

### Ending a link: `revoke`

On the host, `/sub-human revoke carol` (in a session in the room) or `sub-human revoke LINK_ID|NAME [--room CODE]` in a shell ends a link: its token stops working, its `authorized_keys` line is removed, its seats leave the room, its running server stops, and the room shows a line. On the other machine the link stops for good (`the host revoked this link`): it does not keep retrying, and `@room` posts there are refused, not queued. The room line for each new link names its id.

**One leaked invite.** An invite nobody has used yet is not a link, so it has no link id. `/sub-human host` (and `host --tailscale` / `--url`) prints a line under the PIN: `Leaked? /sub-human revoke <ref> burns just this invite`. That ref (12 hex characters, not a secret) or the invite itself (`sh2.…` or the join URL) given to `revoke` burns that one invite, with a room line; every other invite and link stays, and the room stays served (`/sub-human unhost` would stop serving the whole room over the web). An invite already used (or reserved by `admit`) revokes the link it became.

### SSH details

- **The enrollment door (short codes).** While an ssh short invite is open, `authorized_keys` also holds `command="SUB_HUMAN_HOME=… …/.sub-human/bin/serve --enroll vole-8126 --kind ssh",restrict ssh-ed25519 AAAA… sub-human-enroll:vole-8126`. Its key is the room's public enrollment key (derived from the room code; see the threat model): it runs only the code's PAKE. The line goes once no ssh code of the room is live. The joiner's ssh to it uses that key, a fresh known_hosts with `StrictHostKeyChecking=accept-new` and Ed25519 host keys only, so it can compare what it was shown with the key the host vouches for.
- **Forced command.** The line `admit` (or `authorize`) writes is `command="SUB_HUMAN_HOME=… …/.sub-human/bin/serve --stdio vole-8126 --link 1a2b3c4d5e6f",restrict ssh-ed25519 AAAA… sub-human:vole-8126:1a2b3c4d5e6f`. Whatever the other side asks to run, that key runs only this room's server, for that one link (`restrict`: no shell, pty or forwarding), and the server accepts only that link's token, or the invite reserved for it. `<home>/bin/serve` is a stable shim that finds the current plugin install and node when it runs, so the line keeps working after a plugin update or a node upgrade. Paths are absolute because sshd's `PATH` has no Homebrew. The file is `~/.ssh/authorized_keys`, or `SUB_HUMAN_AUTHORIZED_KEYS`, or `--file F`.
- **The joiner's ssh.** The link runs `ssh -T -o BatchMode=yes … -i <link key> -o IdentitiesOnly=yes -o UserKnownHostsFile=<link known_hosts> -o StrictHostKeyChecking=yes -o HostKeyAlias=sub-human-CODE [-J JUMP] -- me@devbox.local`. A jump host is reached with your own `~/.ssh/config` and agent (a host alias works as `--via`). An invite names only a plain `user@host[:port]` and jump hosts: it can't carry an ssh option or a command. `SUB_HUMAN_SSH_OPTS` (space-separated, in the joiner's own environment) adds ssh options; it is meant for tests and unusual setups.
- **MFA bastions.** `sub-human prime CODE [--persist 8h]`, on the joining machine, opens one shared connection interactively (answer the MFA prompt once), and the link rides it (`ControlPath <home>/ssh/cm-%C`). The link itself never prompts (BatchMode) and never opens a shared connection of its own; with none open it connects as usual.
- **By hand (sh1).** `sub-human invite --room CODE --ssh me@devbox [--via JUMP]` prints an older `sh1.…` invite with no PIN, and `sub-human authorize INVITE carol.pub [--file ~/.ssh/authorized_keys]` writes the line for a public key the joiner sent you. The joiner then types `/sub-human join carol sh1.…` (one step). `authorize --file` also rewrites lines sub-human 0.2 wrote (a versioned node and plugin path) to name the shim; it refuses a key that is already in the file with another line. A link id in place of the invite (with `--room CODE`) authorizes another key for a link that exists.

### Moving the host before you close your laptop

The host's machine holds the room's log, serves the links and runs the room's Claude, so when it sleeps the room goes offline. Before you close it, hand the room to someone else in it who is on another machine:

```
/sub-human handoff bob                       # bob's machine reachable as a second home here (pipe)
/sub-human handoff bob bob@bobs-box.local    # the others reach bob's machine over SSH
/sub-human handoff bob bob@bobs-box --via bastion   # through a jump host (ProxyJump), as host --ssh --via
```

(`sub-human handoff bob [USER@HOST[:PORT] | --ssh USER@HOST[:PORT]] [--via JUMP] | --url https://FRONT` in a terminal does the same. Over SSH each member's link follows with its own key and its `prime` setting, pins bob's host key, and until bob lets that key in it is offline with a line to send him: `/sub-human admit shk1…`; he pastes it, and the link connects with no new invite. With `/sub-human handoff bob https://bob-box.tail1a2b.ts.net`, or `--url`, the others follow bob over the web: his machine serves the room on its listener and every invite it sends them pins its listener key; bob then runs `/sub-human host --tailscale` once to put the Tailscale path in front of it.) Bob's Claude shows him a card: **Host room CODE on this machine?** It says plainly that the room's Claude will then run on **his** model account (his Claude or Bedrock billing and rate limits) and that his machine must stay on and reachable. Nothing moves unless he chooses **Host it here** himself; **Not now** leaves everything as it was, and you see `room handoff: bob declined`. The ask lapses after 10 minutes.

When he agrees:

1. The log records `host_changed` at the next **host epoch**, with his signed acceptance and your signed ask. Everyone sees "room CODE moved to bob's machine".
2. The room's Claude stops on your machine and a new one starts on his machine. It rebuilds from the room's tasks and log; nothing of the old session moves.
3. Your machine becomes a member: it mirrors his and your session goes on as before.
4. Every other member's link gets, over its existing connection, a single-use `sh2` invite to bob's machine meant only for that machine, with its seats already bound, and reconnects there. These invites never appear in the log, and no PIN is needed because the old link is already authenticated.

If someone's machine can't reach bob's (a laptop behind NAT, an SSH key bob's machine doesn't know), their link goes offline with a message that says so and what to do. Nothing hangs: posts are refused at once, as with any offline link. Bob runs `sub-human handoff --status` to see who hasn't reconnected. He gives that person a fresh invite and PIN (`/sub-human host [--ssh]`; over SSH their link makes its own key and they send him the `/sub-human admit` line). They run `/sub-human join NAME INVITE PIN`, then `/sub-human NAME CODE`: the join replaces the old link and their seat joins again over the new one. Over SSH every member needs bob's `authorized_keys` to allow their key, so it is easiest when bob's machine is a dev box everyone can already reach.

**There is no automatic failover**: two machines each deciding they host the room would split it. If the host is gone for good (the laptop died, not just asleep), a member whose machine has a full copy can take over by hand, in their own shell:

```
sub-human promote CODE --confirm CODE [--ssh ME@MY-BOX]
```

It refuses while the link to the host is still online, and until the host has been unreachable for 10 minutes (`--force` skips the wait). It prints what it risks first. **Promote can fork the room**: if the old host was only asleep, whatever it writes from then on reaches nobody, and lines it wrote that this copy never got are lost to the room. It prints one invite per other machine. Hand them out yourself; each one works only on its own machine. When the old host comes back, its owner runs `sub-human demote CODE INVITE PIN`. That keeps its own log aside in `orphaned-<time>.jsonl` (never merged) and makes it a member of the new host. A copy that reaches the old host after the move is refused there (`STALE`), so the two never quietly merge.

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
@room bob, can you take the parser tests? handler's in src/tasks.js
room: same thing, without the @ file picker
@claude let's plan cursor paging
```

Two tags, both at the very start of the prompt:

- **`@room …`** (or `room:`) posts your words to everyone. It never wakes the room's Claude.
- **`@claude …`** posts your words to everyone too, addressed to `claude`, and wakes the room's Claude.

Either is posted **verbatim** as your words (`via=human`). No model turn runs, and the receipt is one line:

```
⏺ Operation stopped by hook: ✓ sent
```

- Only a leading tag counts. `@room ask @claude later` is a plain post that wakes nothing, and so is `@room @claude …`.
- Outside a room, `@claude …` is an ordinary prompt to your own Claude.
- Spaces, unicode, `$`, backticks and quotes arrive byte-exact. For multiline input, use `\` + Enter or Ctrl+J.
- Typing `@room` opens the file picker, and a space closes it. Don't press Tab. `room:` avoids the picker.
- Check a prompt suggestion before you accept it. A suggested `@room …` or `@claude …` line is your Claude's wording, and accepting it posts it as yours.
- Your Claude reaches the room's Claude with `SendMessage` at `claude.CODE`.

Anything else you type goes to your own Claude. Its posts are labelled as your Claude's (`via=agent`) and never count as your words.

**The room reads like a group chat.** When someone else posts, everyone else's session shows their exact words, with no ids and nothing added:

```
  sub-human: bob: sure, once we've agreed how paging works
```

A Claude's post shows as `bob's Claude: …`, a join as `bob joined`, a leave as `bob left`. The plugin writes these lines into your session itself, as dim notices that stay there (also after `--resume`). They cost no model turn: your Claude doesn't repeat them, and it gets a copy to read with its next request. A leave shows only after 8 s away, so a quick leave and rejoin shows nothing.

Every person's own words reach everyone. A Claude's post reaches you when it is addressed to you or mentions `@you`, and a proposal naming you opens for you to read and answer: those wake your Claude with a prompt from the plugin ("Prompt from the sub-human plugin"), or join its current turn if it is busy. Everything else reaches your Claude as a short "Room since your last turn" note it reads with its next request. Your room row also reads `+bob joined` or `−bob left` for two minutes.

**On your phone (Remote Control).** The phone shows your session's prompts and replies, not the dim notices. So once you type in the session from Remote Control, the plugin sends what would have been a notice there as a short prompt of its own holding just those lines (`alice: hi`, `room: "Rate limiting" agreed (bob)`): room lines, batched to at most one every few seconds, and a refusal of your `@room` (a post that went through shows nothing more). Each one is a model turn; your Claude is told it needs no reply. Typing at the terminal again turns it off. A proposal's plan view works on the phone too: a bare **Deny** records nothing. A note (**Suggest edits**, or "Tell Claude what to change" at the terminal) is never sent by itself, because a message you type on the phone right after a Deny lands there too: a card asks `Send to alice as changes requested on "…": "…"?`, and only your **Send** records the objection with that note (**Discard** records nothing; reopen the proposal any time).

**Claude to Claude.** Ask your Claude to "ask alice's Claude what the cursor format is". It calls `SendMessage` to `alice.vole-8126`, and alice's pane shows `› Message from @bob.vole-8126: …`. Those messages come from Claudes, not people.

## Agreeing to a proposal

Anyone can propose something. Tell your Claude "propose this" (a plan from your own plan mode, a file or some text), or ask the room's Claude to plan. The proposal names its approvers, by default the people in the room.

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

Say "show me the proposal" and your Claude opens it again. With several waiting, name the one you mean ("open the v3 one", or its hash): the hooks open the one your own last words name, else the oldest, never one your Claude chose. When everyone named has agreed, the room logs a `decision`. A newer proposal replaces an older one, and earlier answers stop counting.

**The card, as a fallback.** When the plan view can't be used, a question card opens instead (Not yet / Agree / Object, **n** adds a note): when you are already in plan mode yourself, in bypass or don't-ask mode, when `showClearContextOnPlanAccept` is on (that approval path clears the context and starts building), or for a proposal over 200,000 characters. The card shows the proposal beside the options when it fits (up to 2,000 characters and about 20 lines), otherwise a summary and the path. Not yet, Esc, "Chat about this" or no answer record nothing.

Planning is optional. Use your own plan mode and "propose this", type `@claude let's plan cursor paging`, or don't plan at all.

## Shared tasks

The room has one shared task list: the native Claude Code task list of the room's Claude. Your private task list stays private.

- Tell your Claude "put the parser tests on the room list, I've got it". It calls the room's `task` tool (`add`, `claim`, `release`, `done`), which replies `queued; the room's Claude applies it`. The room's Claude applies pending requests in one batch.
- Only a task's owner can complete it, with evidence ("12/12 pass, see #15"). A request from anyone else is refused, and the task stays open.
- Your room row shows the summary (`tasks 3 open · #2 you · #4 bob`). `sub-human tasks` lists them, and `sub-human tasks --json` gives the same list as JSON.
- While the room's Claude is not running, the room task list is unavailable, and `task` says so.

## The `sub-human` CLI

`plugin/sub-human/scripts/sub-human` reads the room. Inside a room session it finds your room by itself. It never posts as anyone; only the host's link commands (`admit`, `revoke`) add a line from the room itself. It lives in the plugin's `scripts/`, not `bin/`: claude.ai rejects a plugin with a top-level `bin/` when an organization distributes it, so the CLI is not on the Bash tool's `PATH`. Claude reads the room with the room MCP tools; in your own shell, run it by its path (`node <plugin root>/scripts/sub-human …`) or alias it.

| Command | Prints |
|---|---|
| `read` | The room log. |
| `digest` | The room's current state in a few lines. |
| `who` | People, the room's Claude and their presence. |
| `watch NAME` | NAME's thread: their own words, their Claude's posts (labelled), and their answers to proposals. |
| `tasks [--json]` | The room's shared task list. |
| `host [--room CODE] [--ssh [USER@HOST[:PORT]]] [--via JUMP] [--long \| --short]` | A short invite (`/sub-human join NAME DEST CODE 482913`) as `/sub-human host` shows it; `--long` an sh2 invite and its PIN; no `--ssh`: an sh2 pipe invite (`--short` for the short form). |
| `host [--room CODE] --tailscale [--funnel] \| --url URL [--port P] [--long]` | The same over the web: the listener, Tailscale Serve (or Funnel) or your own front, and a join URL with its code (`--long`: a URL#SECRET.KEY and a PIN). |
| `unhost [--room CODE]` | Stop serving a room over the web (its own Tailscale path goes off). |
| `listen [--port 7420] \| --start \| --stop \| --status` | The host's web listener (127.0.0.1 only); `/sub-human host --tailscale` starts it for you. |
| `admit [REF [--refuse] [--yes]]` | The short-code join requests waiting for you (no REF), or let one in (asks y/N) or refuse it: the card, for a host with no session open. |
| `admit REQUEST [--file F] [--yes]` | Let in the SSH key an older join's admit request (`shk1.…`) carries, for that invite's link only; asks y/N first. |
| `revoke LINK_ID\|NAME\|INVITE_REF\|INVITE [--room CODE] [--file F]` | End a link: token burnt, key line removed, its seats leave. Or burn one unused invite (a leaked one) by its ref or the invite itself. |
| `prime CODE [--persist 8h]` | On a joining machine: one shared SSH connection, opened interactively, for an MFA bastion; the link rides it. |
| `invite [--ssh USER@HOST[:PORT]] [--via JUMP]` | An older one-step `sh1` invite (no PIN) to a room hosted here. |
| `authorize INVITE\|LINK_ID PUBKEY [--file F]` | The `authorized_keys` forced-command line for an SSH joiner's key and that one link; `--file` appends it. |
| `link CODE [--reset]` | Run the link to room CODE hosted elsewhere (in the foreground; joins start it in the background). `--reset` copies the room again after a FORK. |
| `handoff NAME [--ssh USER@HOST[:PORT] \| --url https://FRONT]`, `handoff --status` | Ask NAME to host the room (their card decides); who hosts it at which epoch, and who hasn't reconnected. |
| `promote CODE --confirm CODE [--force]` | This machine's copy becomes the room, when its host is gone for good. Can fork the room. |
| `demote CODE INVITE [PIN]` | On an old host the room was promoted away from: set its log aside and follow the new host. |
| `doctor [--quick] [--fix] [--bundle [FILE]]` | What is wrong on this machine, with a fix for each (see **Doctor**). |

`tail` (the room tail), `agent-statusline` (the rows) and `serve --stdio CODE` (the host's end of a link) are internal. Run `host`, `unhost`, `admit`, `revoke`, `prime`, `listen`, `invite`, `authorize`, `link`, `serve`, `handoff`, `promote` and `demote` in a terminal outside Claude Code: the plugin refuses them to a Claude, and Claude Code's `!` mode would put their output (an invite, a PIN) into the conversation, so there `host` and `promote` mask the PIN and `invite` refuses.

## Doctor

When something is off, run `node <plugin root>/scripts/sub-human doctor` in your shell, on either machine. Each line is ✓ (fine), ! (a warning), ✗ (broken) or · (for your information), and a broken or doubtful one has a `fix:` line under it:

```
✓ node             v24.15.0
✗ home             ~/.sub-human is 755
                   fix: sub-human doctor --fix (or chmod 700 ~/.sub-human)
! link vole-8126   ssh me@devbox:22 · daemon running (pid 4242) · ✕ offline 2m · 2 queued · last error: Permission denied (publickey)
                   fix: the host refused this key in BatchMode: is the key in ssh-agent …?
```

It checks:

- the plugin's version, and Node 24 or newer;
- that the home and its directories are private (0700);
- that the SSH serve shim (`<home>/bin/serve`) and its pointer name a plugin install and a node that still exist;
- `authorized_keys` lines from an older `authorize` that bypass the shim (they break on the next plugin or node update), with the `sub-human authorize … --file` line that rewrites them;
- `ssh` and its version;
- every link to a room hosted elsewhere: its transport, whether its daemon runs, its state and last error, and a quick hello to the host (with a timeout) that shows whether the host is reachable, whether ssh works without prompting (BatchMode), both sides' protocol versions and, when the host sends its time, how far your clocks differ;
- your Claude Code version against the one sub-human's internals were checked on (and, when it differs, the internals themselves);
- settings that turn hooks off;
- the web listener, when this machine serves a room over the web: running, its pid and port, the rooms it serves; with Tailscale, that `tailscale serve status` still lists each room's path, and with Funnel a warning that the name is public (certificate-transparency logs). A link over the web gets its hello through the real WebSocket and pinned Noise channel;
- whether Remote Control (the phone) is likely to work. It needs a claude.ai subscription login and isn't available with Bedrock (`CLAUDE_CODE_USE_BEDROCK`), Vertex or an API key; that is only a note, the room works the same.

`--quick` skips the hello and the internals check. `--fix` rewrites the shim and its pointer and closes the home's modes. `--bundle [FILE]` writes the same report as JSON for a bug report, redacted: it holds versions, settings, check results, link states and recent link errors, never a message; paths under your home become `~`, room codes, host names, user names and IP addresses are hashed, and SSH keys, tokens and invites are removed (a key is cut to a fingerprint prefix). Read it before you attach it.

The room row shows the link too, in a room hosted elsewhere, in the same words as `doctor`, the tail and `~/.sub-human/links/CODE.state.json` (online, connecting, offline, stopped, fork): `✕ offline 2m · 2 queued`, `… connecting (3)`, `✕ stopped` or `✕ FORK: sub-human link --reset` first while it is not online, and `⇄ online` at the end while it is.

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
- **Store guard.** The plugin's function hooks module (`mod/guard.mjs`, Claude Code 2.1.292+) denies `Write`, `Edit`, `MultiEdit` and `NotebookEdit` into the store (`~/.sub-human` or `$SUB_HUMAN_HOME`, checked lexically and after resolving symlinks), so a Claude can't edit the log with its file tools. It runs in-process on every such call, so it costs no process start, and it learns where the store is from the plugin itself when the session starts. It also lets joined sessions use the room tools without a prompt, and refuses `hold` to anything but a row agent. It never answers a tool call in a way that skips other hooks: your own and other plugins' `PreToolUse` hooks still run on the room tools. Where function hooks are off (`--bare`, safe mode, a policy that turns hooks off) a session can't join a room.
- **Bash guard.** The same module checks every `Bash` command and denies one that:
  - names the store (its path, `~/.sub-human`, `$HOME/.sub-human`, the keys under it);
  - names or sets `SUB_HUMAN_HOME`;
  - runs the plugin's own modules or hooks with `node`, `bun`, `deno` or `npx` (`lib/room*`, `lib/identity`, `lib/proposal`, `hooks/*.js`, `mcp/*.js`).

  The read-only CLI (`sub-human read`, `digest`, `who`, `tasks`, `watch`) stays allowed, and so do reading the plugin's source and running its tests. This is a string check. A determined command can evade it, for example a script written to a file first, or a path built at run time. What can't be evaded is the signature: a line written around the store has no valid one, so it shows as unverified and counts for nothing.
- **Not covered.** The `Read` tool is not guarded, so a model can read the store, including the private key files. Other MCP servers that write files aren't guarded either.
- **File modes.** The home and every directory in it are 0700 (a home an older version made 0755 is closed when a room is opened), and the log and state files are 0600.
- **Row launcher and serve shim.** The status-line launcher in `<home>/bin/row-status` and the SSH serve shim `<home>/bin/serve` run only plugin roots outside temp directories (`/tmp`, `os.tmpdir()`), unless `SUB_HUMAN_ALLOW_TMP_ROOT=1` is set.
- Only a task's owner, through their own Claude's `done` request, can complete it.

Remote rooms add:

- **An invite is shown once** and works for one machine; the host keeps only its hash. An invite is untrusted input: its locator is a home path (pipe) or a plain `user@host[:port]` with plain jump hosts (ssh), and the link always runs this plugin's own server, or `ssh` with fixed options, never a command or an ssh option the invite names.
- **A short invite's 6-digit code is its whole secret, and it never travels.** Both machines run CPace (the CFRG's CPace specification, revision 21: ristretto255 + SHA-512, initiator-responder, with its key confirmation both ways) with the code as the password; the group code is the vendored, hash-pinned `@noble/curves` 2.4.0 (`lib/vendor/noble`, its MANIFEST and LICENSE; `test/vendor-noble.test.js` fails on any edit), checked against the specification's published vectors. What crosses the wire are random-looking group elements and MACs: watching them tells an eavesdropper nothing it can test guesses against, offline or later.
- **Guessing is online only, and counted before the host answers.** The host charges one of the invite's 5 tries when it answers an attempt, so an attempt abandoned after that answer still costs its try; the fifth wrong code burns the invite, as do 15 minutes or its one use. Each wrong code is a room line. An attacker (a prober, or someone in the middle of a real join) gets one guess per attempt: 5 guesses in a million, then the invite is gone. With several short invites open (at most 4 per room), one attempt is tried against each and charged on each, so the odds are at most 20 in a million; a success gives the others their try back. The host keeps the code in its own store (CPace needs it in clear) and drops it once the invite is used, burnt or revoked.
- **The code authenticates the host, then the host's key is pinned.** Inside the PAKE the host vouches for its key: sshd's Ed25519 host key over ssh, the listener's X25519 key over the web. Over ssh the joiner's ssh records the host key it was shown (a fresh known_hosts, Ed25519 only, `accept-new`) and the joiner stops, before its own confirmation goes out, unless it is the vouched one: someone between the joiner and the host (a spoofed name, a hostile network) learns at most whether its one guess was right. The joiner then pins that key, as an `sh2` invite pinned it. Over the web the joiner pins the vouched listener key and every later connection is Noise_NK to it.
- **The code is not the admission; the host person is.** A code that holds gets the joiner a fresh 128-bit secret (sealed under a key derived from the PAKE's ISK, bound to that machine and, over ssh, to the link key the joiner made and sent inside the PAKE). It redeems nothing until a person on the host answers **Let in** on the card (`hooks/consent.js`: only the answer on the card as the hooks built it counts, never the model's; the answer is signed with that person's seat key) or runs `sub-human admit REF` in a shell. Unanswered requests lapse after 10 minutes.
- **The ssh enrollment door.** A joiner with no admitted key still has to get through sshd. While an ssh short invite is open, `authorized_keys` holds one more line: `command="… serve --enroll CODE --kind ssh",restrict <the room's enrollment key> sub-human-enroll:CODE`. That key's private half is **public by design**: anyone who knows the room code derives it (sha256 of a label and the code). It is never derived from the 6-digit code, so trying keys at sshd tests no guess. What the door lets anyone who reaches sshd and knows the room code do: run the PAKE (a guess, charged), spend the invite's tries until it burns (a denial of service on that one invite), and see that a room by that code is hosted there. What it does not: run a shell, a pty, forwarding or any other command (`restrict`, a forced command that ignores what was asked), read the room, post, or learn anything about the code beyond one guess per try. The line goes when no ssh short invite is live (used, burnt, revoked or expired; the host's tail sweeps every 30 s, and each attempt and revoke sweeps), and `serve --enroll` refuses a room with no open code whatever the file says. Limits: sshd itself must accept public keys for that account (an `AuthenticationMethods` that also demands a password or MFA defeats the door; use `--long` then), the host's sshd must have a readable Ed25519 host key, and during those 15 minutes an attacker on the network can burn the invite.
- **The code is treated like the PIN everywhere.** `host` shows it to the person only (a hidden block, never a systemMessage); in Claude Code's `!` shell `sub-human host` masks it; the join that carries it is blocked and suppressed, so the model never sees it; the link file holds it (0600) only until the host answers; it is in no log or room line, and `doctor --bundle` cuts any 6-digit number. **History caveat:** what you type at Claude Code's prompt stays in its prompt history (the up arrow, and its history file under `~/.claude`), as a PIN did; after a burn or a use the code is worthless.
- **An sh2 invite's PIN is a second factor checked online only.** It is never in the invite and never seals or derives anything: the host keeps `sha256(secret:PIN)`, checks it at the link's first connection, and burns the invite after 5 wrong tries, 15 minutes, or its one use. The join that carries it is hidden from your Claude (the prompt is blocked and suppressed), and the joining machine drops it with the invite once the host answered. A leaked invite alone gets nowhere; a leaked invite plus a key the host admitted gets 5 guesses.
- **Over SSH, keys are made where they are used.** The joiner's link key is made on the joiner's machine; the host admits only its public key (the card, or a pasted `shk1` request), and the joiner pins the host's SSH host key (vouched for inside the PAKE, or carried in an `sh2` invite).
- **Over SSH, the host's `authorized_keys` decides what runs**: `admit` (or `sub-human authorize`) writes a `command="… serve --stdio CODE --link ID",restrict` line, so the key reaches that room's server for that link and nothing else, and the server refuses another link's token there.
- **An ssh login to the host's account is trusted as that account.** `/sub-human join NAME USER@HOST CODE` runs `serve --login` over the joiner's own login, and the server then makes a link with no invite, because that login could make one anyway. A restricted key can't get there: its line fixes `serve`'s arguments without `--login`, and `serve --login` refuses to run under a forced command (`SSH_ORIGINAL_COMMAND` is set). Give someone a login to your account only if you would give them the account.
- **A link token is a seat-level credential.** The invite turns into a token at the link's first connection. It is stored in clear in `<home>/links/<CODE>.json` (0600, the same trust as the seat key) and hashed on the host. Whoever holds it can post as the seats joined over that link, never as anyone else: the host checks every entry's `from` against them and its signature against the key pinned in the log.
- **Keys are pinned strictly.** A name is its key for the room's life, on every machine. A lost key, or the same name from a new machine, means a new name.
- **Addressed posts are not private.** A post to one person (`to`) has its own rate limit, but the whole room reads the log, on every machine.
- **The guard denies `sub-human host`, `unhost`, `admit`, `revoke`, `prime`, `listen`, `invite`, `authorize`, `link`, `serve`, `handoff`, `promote` and `demote` to a model**, and `/sub-human host` shows the invite and its code (or PIN) to you, not to your Claude.
- **Moving the host needs the new host's person.** Only their own answer on the handoff card moves the room, signed with their seat key. The `host_changed` entry carries that signature and the old host's signed ask. A handoff's invites travel only over each machine's existing authenticated link. Each one works for one machine and is bound to that machine's seats. The old host keeps them for a day so a member that reconnects late still gets one, then they lapse. A `promote` is a person's own command in their own shell, recorded in the log with their name.

Over the web (Tailscale Serve, Funnel or your own front), who sees what:

- **The listener binds `127.0.0.1` only.** Nothing on your LAN can reach it; Serve, Funnel or your front is the only way in. Before a Noise handshake completes it holds at most 16 connections in handshake (64 in all), gives each 10 seconds, and takes frames of at most 64 kB.
- **Tailscale (or your front) ends TLS, not the room's encryption.** It sees which IPs connect, when, and how many bytes; Funnel's relays see the same. Inside the WebSocket every byte is Noise_NK ciphertext (X25519, ChaCha20-Poly1305, SHA-256, from `node:crypto` only; checked against the published cacophony and snow test vectors), keyed to the listener's own X25519 key (`<home>/listen/host-x25519.json`, 0600, random, one per home, used for nothing else). The joiner pins that key from inside the short code's PAKE (or from an `sh2` URL's `#` part): a front that answers with another key gets a `could not link … the host did not prove the key the invite pinned` and the link stops. The path names the room code. A short code's PAKE runs in WebSocket text frames before any Noise: the front sees its public values and the sealed secret, never the code.
- **Funnel's name is public** (certificate-transparency logs), so expect probes: a guessed code (or PIN) costs one of 5 tries, every wrong one is a line in the room, and even the right code gets only as far as your card.
- **The host is still trusted**: the listener hands decrypted bytes to `serve --stdio CODE`, which checks the hello exactly as over SSH.

The plugin doesn't stop a hostile local user, who can read the keys and write the files directly. The hash chain makes such edits visible. It doesn't prevent them.

## Troubleshooting

Start with `sub-human doctor` (see **Doctor**): it names most of these and the fix.

| Symptom | Fix |
|---|---|
| "Unknown command" for `/sub-human` | Launch with `--plugin-dir plugin/sub-human`, or install the plugin. |
| `/sub-human NAME` asks for a code | More than one room is open, so add the CODE. |
| "the room's Claude could not start" on join, or `Workspace not trusted` | Run `claude` in that folder once and accept trust, then join again. Without its Claude the room still works, but it has no shared task list. |
| No rows in the panel | Accept workspace trust for this folder. After a resume they come back by themselves. |
| A proposal didn't open | Ask your Claude to "show me the proposal". `sub-human read` shows who a proposal names. |
| `/sub-human` says it needs Claude Code 2.1.292+ with function hooks on | Update Claude Code, and start it without `--bare` or safe mode; a managed policy that turns hooks off also prevents it. |
| `room link: STOPPED (…)` | The link stopped for good: the host refused or revoked it, or the room closed. The reason says what to do (usually a new invite: `/sub-human join NAME INVITE PIN`). |
| `room link: OFFLINE` | The link can't reach the host. It retries by itself (from 1 s, with jitter, up to 10 s; at once after a wake or a network change); `@room` posts are queued, answers are refused, until it is back, and `room link: back online` says when (and how many queued posts went out). `~/.sub-human/links/CODE.log` says why; `~/.sub-human/links/CODE.state.json` holds the link's state. |
| `room link: OFFLINE (room CODE moved to NAME's machine …, which this machine cannot reach yet …)` | A handoff moved the room and this machine can't reach the new host. Ask its person for an invite your machine can use (`/sub-human host` there), then `/sub-human join NAME INVITE PIN`; over SSH they also admit your key with the line your join shows. |
| `STALE` | A write or a link reached a host the room has moved away from, or a copy that has not caught up with the move. A copy catches up by itself. An old host that was promoted away runs `sub-human demote CODE INVITE PIN`. |
| `room link: FORK` | This machine's copy no longer matches the host's log. Nothing more syncs. Run `sub-human link --reset CODE` in your shell: the link copies the room again from the host. |
| SSH join: `room … is offline` and the link log says `Permission denied (publickey)` | The key ssh used is not the one the host authorized, or the host's `authorized_keys` line is missing. The link uses `BatchMode=yes`, so it never asks for a password or a passphrase: load the key into your agent, or name it in `~/.ssh/config` (or `SUB_HUMAN_SSH_OPTS="-i KEY"`). |
| SSH join: `Host key verification failed` in the link log | ssh has not seen the host yet and BatchMode can't ask. Run `ssh me@host true` once in your shell to accept its key. |
| SSH join: `no room` or `AUTH: this token is not link …'s` in the link log | The forced command names another room, home or link than your invite. Ask the host to run `sub-human authorize` again with your invite and key. |
| `could not link …: wrong code (N tries left)` | Type the join again with the code the host gave you. After 5 the invite is burnt: ask for a new one. |
| `the host's machine checked your code. A card there now asks them…` and nothing more | The host person has not answered their card yet (their Claude opens it; or `sub-human admit` in their shell). After 10 minutes it lapses: ask for a new code. |
| SSH join: `the ssh server that answered is not the one that holds your code` | The host key ssh was shown is not the one the host vouched for inside the code's handshake: a wrong address, a reinstalled host, or someone in between. Check with the host; nothing more was sent. |
| SSH short code: `Permission denied (publickey)` before any code check | The host's sshd refused the room's enrollment key: no door line (the code expired or was used), or sshd demands more than a key. Ask for a new code, or for `/sub-human host --ssh --long`. |
| Web join: `could not link … the host did not prove the key the invite pinned` | Whoever answered at that URL is not the listener the invite was made for (a changed host key, the wrong front, or someone in between). Ask the host for a new invite. |
| Web join: `still connecting (Tailscale may be issuing a certificate …)` | A new ts.net name's first TLS handshake waits on its certificate (~20 s). The link keeps trying; type `/sub-human NAME CODE` in a moment. |
| Web join: `still connecting` and the link log says `answered 502` / `404` | The front reaches no listener: on the host, `sub-human listen --status`; with Tailscale, `tailscale serve status` should list `/sub-human/CODE`. Run `/sub-human host --tailscale` again. |
| Web join: `TLS to …: unable to verify` in the link log | The joining machine does not trust the front's certificate. A ts.net certificate is public; for your own front set `NODE_EXTRA_CA_CERTS`. |
| `AUTH` after upgrading the plugin | A seat that joined before keys were pinned can't post as you. Rejoin with `/sub-human NAME CODE`; if the name's key is lost, join with a new name. |

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
