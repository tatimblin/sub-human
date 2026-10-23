# Join over your own ssh login to the host machine, not the host's account (#27)

**Status:** implemented on branch `ssh-forward-join` as 0.5.4. Steps 1-6 and 9 are done, with the simplicity review's cuts: steps 1 and 3 merged, the argv trimmed (`-W` implies `-T`/`ExitOnForwardFailure`), `--forward` takes no DEST, and the squatter is a node test (`test/remote-forward.node-test.ts`). Still to do:
- Step 7: doctor. Only the hints exist (`doctor/ssh.ts` sshHint knows the two new kinds); there is no probe.
- Step 8 is done: `scripts/remote-docker/scenarios/16-forward.ts` passes on real OpenSSH. It showed that the reason for a failed forward appears only at `LogLevel INFO`, so the tunnel pins `-o LogLevel=INFO`.
- A live check on a real box: whether `AllowTcpForwarding` is on. If corp images turn it off, the `ssh HOST nc 127.0.0.1 PORT` fallback the review suggested becomes v1 scope.
- `SOURCE_MAX` is shared by every forwarded joiner (all of them reach the listener from 127.0.0.1).

Goal: alice hosts a room in her account on a shared dev box. bob can ssh to that box only as `bob@devbox`. bob types the line alice sends him, plus the PIN, and joins. No Tailscale is involved, and nothing is installed in bob's account on the box.

Paths below are relative to `plugin/sub-human/`.

## Why it fails today

- An ssh link logs in and runs `"$HOME"/.sub-human/bin/serve` (`lib/remote/transports/ssh.ts:108-109`). That works only when the login is the host's own account, because the room lives in alice's home and her shim and store are `0700`.
- The web invite does reach another account's room, but it needs a TLS front, which in practice means Tailscale.
- bob's join stops with `SSH_NO_SHIM` (`ssh.ts:156`), which tells him to "open the room in Claude Code" there. For bob that is the wrong advice.

## Design: the web link, carried over bob's own ssh login

The host's listener (`lib/remote/listener.ts`) already binds `127.0.0.1` only and runs Noise XK. The invite's SECRET tag pins its X25519 key (role `listener`). bob's own ssh login can reach that loopback port with stdio forwarding:

```
ssh -T -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=2 \
    [SUB_HUMAN_SSH_OPTS] -W 127.0.0.1:PORT [-p P] -- bob@devbox
```

- No shell runs, so nothing in bob's account on the box is touched.
- Above the byte pipe nothing changes. The listener key is fetched and checked against the tag, then the XK handshake runs and the link's own key is bound. The PIN, the card and the token work as they do over the web.
- No new exposure: the listener stays on loopback, as it is today behind Tailscale Serve.

**The link file's transport** is the existing `ws` kind with one new field:

```
{kind: 'ws', host: '127.0.0.1', port: 7420, path: '/sub-human/CODE', hostKey, clientKey,
 tunnel: {user: 'bob', host: 'devbox', port?: 22}}
```

Reusing `ws` keeps all of the web path in `link-connect.ts` as it is: `isWeb`, `fetchKey`, `clientKey`, `keepAnswer` and the join check. The tunnel only replaces the TCP connect under `ws.ts connect()`.

**The invite line** (host):

```
/sub-human join devbox ROOM SECRET --forward 7420
```

- The destination is the host name or alias **without a user**. The joiner's `withUser` (`ssh -G`) fills in their own user from their own `~/.ssh/config`. If that would be wrong, they type `bob@devbox`.
- This drops the `YOU@` placeholder dance: the line works as pasted for anyone whose ssh config already reaches the box.

### Decisions (recommended; say if you want otherwise)

1. **Flag.** Use `/sub-human invite --forward [DEST]` on the host and `--forward PORT` on the joiner's line. The default invite stays as it is (tailnet, else ssh login), so the same-account flow (your `ssh dev` setup) keeps working. The ssh invite's once-note points to `--forward` in place of `--web`.
2. **The forward target is never taken from the invite.** The line carries only the port. The joiner always forwards to `127.0.0.1:PORT`. The host name comes from what the joiner typed, and every ssh option comes from the joiner's machine. Otherwise a crafted line could point bob's ssh at another host on the box's network.
3. **No protocol bump.** The host side is the existing listener, and the wire above the pipe is unchanged. An older joiner refuses the line (`"--forward" isn't a join option`). An older plugin reading a new link file ignores `tunnel`, dials its own loopback, and fails AUTH on the pinned key, so it fails safe.
4. **Seats are invite seats, not login seats.** bob's seat has no host `account`, so consent counts him as his own person, not as alice. This is correct, and a test says so.

## Steps

Each step ships on its own with tests, in this order.

### 1. `ws.ts connect()` over a stream it's handed (S)
- `lib/remote/ws.ts:312` `connect(url, opts)`: add `opts.socket?: () => Promise<Duplex>`. When it is given, it replaces `tcp()`, and TLS is refused, since a tunnel is `ws:` only. The Host header and the path stay as they are.
- `Conn` already takes any `Duplex` (`WsSocket`, `setNoDelay` optional), so it needs no change.
- Tests: `test/remote-ws.node-test.ts` adds a connect over a `PassThrough` pair to `createServer`'s handler, and a refused `wss:` with `socket`.

### 2. The tunnel opener (M)
- New `lib/remote/transports/tunnel.ts`:
  - `openTunnel(dest, port) -> Promise<{stream: Duplex, stderr(): string, child}>`. It spawns the command above with `Duplex.from({readable: child.stdout, writable: child.stdin})`.
  - It resolves on the first byte or once the child is up, and rejects if the child exits first. stderr is kept, as the pipe kind keeps it.
  - It is built through `ssh.ts checked()`/`dest()`. Pinned options go before `SUB_HUMAN_SSH_OPTS`, as in `command()`.
- `ssh.ts classify`: add two kinds.
  - `forward-refused`: `administratively prohibited`, `open failed: … prohibited`, `forwarding disabled`, `DisableForwarding`, or a `PermitOpen` refusal.
  - `forward-unreached`: `open failed: connect failed: Connection refused` and `stdio forwarding failed`, meaning nothing listens on the port.
- `loginProblem` gets a sibling, `forwardProblem(stderr, spec, {first})`. It reuses host-key, denied, mfa and dns as they are.
  - `forward-refused` → AUTH `SSH_FORWARD_REFUSED`: "devbox's sshd doesn't allow port forwarding for bob (AllowTcpForwarding). Ask an admin to allow it for local forwarding, or ask the host for an invite another way."
  - `forward-unreached` → OFFLINE, which keeps retrying. On the first dial its message adds: "the host's listener isn't running on devbox:PORT; ask them to run /sub-human invite --forward again."
  - Add the new reason codes to `lib/reasons.ts`.
- Tests: `test/support/fake-ssh.ts` learns `-W HOST:PORT`. It `net.connect`s and pipes stdio, and `FAKE_SSH_FAIL=noforward` prints OpenSSH's prohibited line. Add unit tests for the argv (the order of `--`, `-W` always to `127.0.0.1`) and for each classify string. Copy the real OpenSSH strings from a box rather than writing them from memory.

### 3. The `ws` kind uses the tunnel (S)
- `types-rest.ts WsSpec`: add `tunnel?: SshDest`.
- `transports/ws.ts`:
  - `open` and `fetchKey` call `ws().connect(url, {socket: () => openTunnel(...)})` when `spec.tunnel` is set. The tunnel is valid only with `kind: 'ws'`, `host: 127.0.0.1`, a port, and a `dest()` that checks out; anything else is INVALID.
  - `describe` → `ssh bob@devbox → listener :7420`.
  - The `.ts.net` hint (`offline()`) is skipped.
  - The tunnel's stderr is exposed on the returned transport, as ssh's is, so `link-connect.ts loginRefused` can read it.
- `link-connect.ts`:
  - `loginRefused` → generalize to "ssh refused", run for any transport with a `tunnel` too, through `forwardProblem`.
  - `fetchKey` failures on the first dial go through the same classifier. Today it throws a bare OFFLINE before the transport exists.
- `lib/room/links.ts`: a hand-edited `tunnel` is checked again with `ssh.dest`.
- `joining.ts:67,71` (`urlOf` for display) shows the ssh form for a tunnel, not `ws://127.0.0.1…`.
- Tests: an e2e in the shape of `remote-wss-e2e`. The host listener runs in one home, and the joiner home's ssh is the fake ssh, which forwards `-W`. Cover:
  - the PIN join, the knock and card join, and a redial after the listener restarts;
  - kick;
  - the second dial pinning `hostKey`, with no `fetchKey` after the first link.

### 4. Host: `/sub-human invite --forward [DEST]` (S)
- `lib/remote/webhost.ts`: `hostWeb(code, {forward: true})` takes a third mode, `ssh-forward`.
  - It starts the listener and has no Tailscale and no front. `addRoom(code, {path: '/sub-human/CODE', mode: 'ssh-forward', port})`.
  - It mints `kind: 'ws'` with locator `ws://127.0.0.1:PORT/sub-human/CODE`, and the tag uses role `listener` as now.
  - The line is `/sub-human join HOST CODE SECRET --forward PORT`. HOST is `--forward DEST`, else `SUB_HUMAN_SSH_ADDR`, else `selfAddress()`, with any `user@` stripped.
- `lib/commands/invite.ts`: parse `forward: '?'`. It counts as its own way among `ways`, so it can't be combined with `--web` and the others. `--stop` covers it, since `unhost` already drops a room with no Tailscale record.
- Notes, once per room (`hosting.onceNotes`):
  - "They log in as themselves (their own account on HOST); nothing is installed for them. Their ssh must be allowed to forward ports (sshd's AllowTcpForwarding, on by default)."
  - The key-check note, as for `--web`.
  - The rules and the install hint.
- `hosting.ts:242`: the ssh invite's note ends with "No login to this account? /sub-human invite --forward" instead of `--web`.
- `listener.ts ensure()`/restart keeps the room's recorded port. Check that a restart after a reboot gets the same port. If 7420 is taken (bob hosting his own room on the same box), `start()` picks another, and the line carries whichever port it got.
- Tests: the invite text and line, `--forward` with a bad DEST, `--forward --web` refused, `--stop`.

### 5. Joiner: `/sub-human join HOST ROOM SECRET --forward PORT [PIN]` (S)
- `lib/commands/join.ts join`:
  - `parse(argv, {as: 1, home: 1, forward: 1})`. `--forward` with no SECRET, with `--home`, or with a `pipe:` destination is refused with a short why. A PORT outside 1-65535 is refused.
  - Build the transport with `withUser(dest)`, check it with `dest()`, then `{kind: 'ws', host: '127.0.0.1', port, path: '/sub-human/' + code, tunnel}`. It goes through `joining.linkLine` exactly as `joinWeb` does; `linkLine` already makes the `clientKey`.
  - The placeholder check (`YOU_HINT`) applies as for ssh.
- `mod/core/command.ts`: make sure the hidden-answer and secret routing still fires with the trailing flag after SECRET. Add a test.
- `JOIN_USAGE` and the help line mention the form.
- Tests: parse cases in the existing join tests, and the end-to-end path from step 3 driven through the verb.

### 6. The error message when the login isn't the host's account (S)
`ssh.ts loginProblem`, for both cases below. Neither case pretends to know the host's account name.
- `no-shim` on a login link: "bob@devbox has no sub-human at ~/.sub-human/bin/serve. If the room is in someone else's account on devbox, you can't join through theirs: ask them for `/sub-human invite --forward`, which goes through your own login. If it's your own account, open the room there first."
- `denied` on an invite line's ssh dest (bob pasted `alice@devbox` as is): add "If you have no login as alice there, ask the host for `/sub-human invite --forward`".
- Tests: update the message assertions in `remote-invite-ssh.node-test.ts`.

### 7. doctor (S)
- `lib/cli/doctor/`: for a link with a `tunnel`, make one probe: `ssh -W` plus a key `{"op":"key"}` fetch. Report pass, or the `forwardProblem` message.
- On the host, the listener check names the `ssh-forward` rooms.
- Tests: extend `remote-wss-doctor.node-test.ts`.

### 8. Docker lab: two accounts (M)
- `scripts/remote-docker/Dockerfile`: add a second user `joiner` to `AllowUsers` with its own key. `AllowTcpForwarding` stays at its default.
- New scenario `16-forward.ts`:
  - `host` opens a room and runs `invite --forward`.
  - The client joins as `joiner@devbox` with the PIN, posts, and gets a reply.
  - Then `sshd` sets `AllowTcpForwarding no` (a `Match User joiner` block) and the scenario expects `SSH_FORWARD_REFUSED`.
  - Then a squatter test: the listener is stopped and `joiner` binds the port itself on the box, and the scenario expects `HOST_KEY_MISMATCH` with nothing secret sent.
- This is the real proof of #27's flow, since the fake ssh can't show sshd's own behavior.

### 9. Docs and release (S)
- `plugin/sub-human/README.md`: the join section and the threat model (below).
- `docs/ARCHITECTURE.md`: Joining and the transports paragraph, plus the note that the ws kind's `tunnel` replaces only the TCP connect.
- `CHANGELOG.md`, then release 0.5.4 with the usual recipe.
- Live-verify on two real accounts on the Bedrock box (`ssh dev`, then a second user) before closing #27.

## Threat model additions (README)

- **Any local user on the host machine can reach the listener's loopback port.** This was already true. Without the line's SECRET and the PIN, or the card, they get nothing: the same reasoning as a Tailscale front.
- They can also learn three things:
  - the listener's public key, since `{"op":"key"}` is unauthenticated;
  - whether a room code is served, from the refusal wording;
  - and, by holding connections open, they can use up `PREAUTH_MAX` and `SOURCE_MAX`. Every forwarded connection's source is `127.0.0.1` with no X-Forwarded-For, so they all share `SOURCE_MAX` = 8 (`listener.ts:83`).
- This is a local denial of service, accepted. A fix is to key `bySource` on something better, which loopback doesn't offer. Note it, and consider raising `SOURCE_MAX` for loopback only if 8 bites.
- **Squatting the port.** If the listener isn't running, another local user can bind its port. On the first dial, the tag check stops them (`HOST_KEY_MISMATCH`, nothing secret sent). Afterwards, the pinned `hostKey` makes XK fail (AUTH). Step 8 tests this.
- **sshd policy.** The feature needs `AllowTcpForwarding` (`yes` or `local`), the OpenSSH default. A box that turns forwarding off, or restricts `PermitOpen`, is refused with a clear reason (step 2).
- **ARCHITECTURE "One machine per room … Not covered: a hostile local user"** still holds for the host's store. The joiner never touches alice's files: only bytes reach her listener, which spawns her `serve` as her.

## Open questions

- Should a forward invite be the **default** when this machine looks multi-user? For example, when more than one human account has a home under `/home`. My recommendation is not yet: start explicit, and revisit after the live test.
- Each dial is one fresh ssh login, and the first join makes two: the key fetch, then the link. Users with `ControlMaster` in their config get this cheaply. That seems fine, but check how it feels behind MFA. An MFA box already needs a login by hand first, as login links do.
