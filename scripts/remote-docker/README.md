# scripts/remote-docker: the sub-human lab

Test and validation environments for remote rooms 1.0 (SSH) and 1.1 (wss through a TLS front). Everything runs in
Docker on this Mac. Nothing touches this Mac's sshd, `~/.ssh` or `~/.sub-human`.

| What | Command | Stack |
|---|---|---|
| The scenario suite (personas P1–P3, chaos, skew, security, 1.1) | `npm run test:remote-docker` or `node scripts/remote-docker/harness.js scenarios [--only ID[,ID]] [--out DIR] [--keep]` | `lab/compose.yml`, project `sub-human-lab` |
| The original 11 assertions, with this Mac as the joiner | `npm run test:remote-docker:mac` or `harness.js run` | `compose.yml`, project `sub-human-remote` |
| Manual mode: real Claude sessions on this Mac join a devbox room | `harness.js up [--host-seat NAME] [--joiners A,B]`, `status`, `say [--to NAME] TEXT`, `cut`, `heal`, `latency MS`, `down` | `compose.yml` |

## Topology (`lab/compose.yml`)

```
                          this Mac (127.0.0.1: toxiproxy api + devbox-ssh, for the manual mode)
                                    |
  ======================= edge (the "internet") =================================================
     |               |                    |                     |                       |
 [joiner-a]     [toxiproxy]           [bastion]             [tls-front]             [corp-proxy]
  P1 friend     :22001 -> devbox:22    sshd, user jump       Caddy, internal CA     tinyproxy :3128
  NET_ADMIN     :22003 -> devbox-old   no shell, no tty      https://tls-front/     CONNECT only,
  sshd (for     latency / cut /        ProxyJump only to     -> devbox:7421          to :443 :22001
  a handoff)    reset_peer / timeout   devbox, devbox-old,       |                   :22003
                    |                  joiner-a                  |                       |
  ==================|==================|=========================|=====    ===============|=======
     core (internal)|                  |                         |          corp (internal: no
                    v                  v                         v           route, no DNS out,
              [devbox] <---------------+          fwd.js :7421 -> 127.0.0.1:7420    no UDP)
              sshd (user host), the host room,    (the tailscaled stand-in; the       |
              plugin /plugin (ro), node 24        1.1 ws listener will sit on 7420)   |
              [devbox-old]  plugin 0.2.0 (cb4d344), baked in              [joiner-b] -+-> bastion:22
                                                                          P2 corporate  corp-proxy:3128
```

- **devbox**: node 24, sshd (keys only, `AllowTcpForwarding no`), user `host` with the room in
  `/home/host/.sub-human`. The plugin is mounted read-only at `/plugin`; `claude` is a stub, so no room Claude runs. It is on
  the internal `core` network only: a joiner reaches it through toxiproxy (the chaos-able WAN path), through the
  bastion (ProxyJump) or, for 1.1, through tls-front.
- **devbox-old**: the same image with plugin 0.2.0 from `git archive cb4d344 plugin/sub-human` baked in
  (`lab/Dockerfile.old`, built once by `lab.js` as `sub-human-lab-old:cb4d344`). Its `joiner` user is the 0.2.0 joiner.
- **bastion**: sshd for user `jump`: `ForceCommand nologin`, `PermitTTY no`, forwarding only to `devbox:22`,
  `devbox-old:22` and `joiner-a:22`.
- **joiner-a / joiner-b**: node 24, the plugin, an ssh client, user `joiner` with its own `SUB_HUMAN_HOME`, and
  `NET_ADMIN` for iptables. They run the real hooks and CLI (`lab/seat-cli.js`). Each seat has a `lab/seat-proc.js`
  that stands in for its `claude` process and runs the plugin's own room tail, which renews the lease and records
  every delivery with a timestamp. A joiner's ssh routing is its own `~/.ssh/NAME.conf`, passed to the link
  daemon as `SUB_HUMAN_SSH_OPTS=-F …`. Every invite says `ssh:host@devbox`; the config decides the path.
  joiner-b sits on `corp`, so it can reach only `bastion:22` and `corp-proxy:3128`.
- **toxiproxy**: `devbox-ssh` (:22001) and `old-ssh` (:22003). It is used for latency, disable (cut), `reset_peer`
  and `timeout` (half-open) toxics.
- **corp-proxy**: tinyproxy (`lab/tinyproxy.conf`), CONNECT to 443, 22001 and 22003 only. Every CONNECT is logged.
  The ssh path through it is `ProxyCommand nc -X connect -x corp-proxy:3128 %h %p`; the wss path is `HTTPS_PROXY`.
- **tls-front**: Caddy with `tls internal` for `https://tls-front/` (`lab/Caddyfile`). It forwards everything,
  WebSocket upgrades included, to `devbox:$LAB_WS_FWD_PORT` (7421), where `lab/fwd.js` hands the connection to the
  host's `127.0.0.1:$LAB_WS_PORT` (7420), the plugin's `sub-human listen`. This is the shape of Tailscale Serve/Funnel: a third party terminates
  HTTPS and forwards to a loopback listener. The joiners trust Caddy's root through `NODE_EXTRA_CA_CERTS=/etc/lab-ca.crt`.

## Scenarios (`scenarios/NN-*.js`, run in order, each from a clean reset)

| id | persona | what it proves | today |
|---|---|---|---|
| `p1-friends` | P1 | joiner-a joins by ssh with the real flow (`/sub-human invite --ssh`, the line `/sub-human join host@devbox CODE PIN --as bob` through the enrollment door, the host's card Let in, a bare `/sub-human`); posts reach the other side's tail in under 2 s, also with a 300 ms latency toxic each way; machine ids distinct; mirror byte-identical; `doctor` exits 0, `doctor --json` passes the link and the clock, `--bundle FILE` holds no token, secret, PIN or room code | pass |
| `p2-corporate` | P2 | joiner-b's isolation (no route, no DNS, only bastion and proxy); bea joins with the line from `invite --ssh … --via jump@bastion` (her link runs `ssh -J` with its own key and the pinned host key); a second home joins via the CONNECT proxy; bastion and proxy logs show the hops | pass |
| `p3-sleep` | P3 | `docker pause devbox` 90 s (`LAB_SLEEP_S`): both links go offline, then come back within 30 s of the wake; a post while offline is queued (`⧗ queued`) and flushed exactly once; seats renewed with no left/joined line; no line lost or duplicated. `docker pause joiner-a` 45 s (`LAB_JOINER_SLEEP_S`): it catches up on the 6 posts it slept through. Default link timings | pass |
| `half-open` | P3/P2 | a toxiproxy `timeout` toxic (bob) and iptables DROP (bea) black-hole the links; a post returns within 10 s (`⧗ sending`, kept under its nonce) and lands exactly once after the heal; both links are declared dead within 35 s by the app ping (`LAB_PING_DEADLINE_MS`) | pass |
| `flap` | P1/P3 | 10 cuts in 60 s (alternating disable and `reset_peer`) while everyone posts; ends byte-identical; every accepted post once; no ghost; bea via the bastion is the control | pass |
| `slow-link` | P1 | 5 s of upstream latency, past the hook's 3 s deadline: the hook says `⧗ sending (slow link)` within 3 s, never "nothing was sent"; the post lands exactly once (no ghost, no double) and the outbox empties | pass |
| `skew` | mixed | 0.2.0 host ← current joiner, current host ← 0.2.0 joiner (sh1 both ways; no command makes or takes one any more, so on the current end the lab mints it and writes the link file with the plugin's lib, `seat-cli.js sh1/authorize/linkinvite`): compatible or a clear version message, never divergence; a hello as a 9.9.9 joiner (protocol 99) is refused `PROTOCOL` naming both versions and "The host must update" | pass |
| `security` | all | `ssh devbox ls` with the link's own key (let in on the card) runs the forced command, not a shell; no pty; no `-W`; the bastion has no shell; homes 0700 with nothing group/world readable; no link token in any log, room file, process list or other file; 5 wrong PINs through the door burn the invite (each says the tries left) and the right one then gets nowhere; `/sub-human kick bob`: key removed, serve stopped, bob's link stops (AUTH) and his post is refused, bea untouched | pass |
| `handoff` | P3 | alice (devbox) runs `/sub-human handoff bob joiner@joiner-a`; bob answers the card; joiner-a hosts at epoch 1 (both signatures in `host_changed`), devbox mirrors it; bea's re-pointed link is offline with a reason naming bob until bob lets her in (`doctor --json` shows the link moved, not reached); bob gives bea and devbox (`--via jump@bastion`) an invite each, they type its line, his card lets each in, a bare `/sub-human` joins both seats again; posts flow, `handoff --status` shows nobody left behind, every copy converges with the old lines kept | pass |
| `tls-front` | 1.1 | `https://tls-front/` verifies against the lab CA and answers 502 with no listener; with a stand-in listener on the devbox loopback (`lab/ws-probe.js`) the upgrade is 101 and echoes, from joiner-a and from joiner-b only through corp-proxy | pass |
| `wss` | 1.1 | the host's `sub-human listen` on 127.0.0.1:7420; `/sub-human invite --url https://tls-front` shows `/sub-human join https://tls-front/sub-human/CODE PIN` (no name, no secret in the URL); bob and (through corp-proxy) ben type it, the PAKE pins the listener key, alice's card lets each in, a bare `/sub-human` seats them; a wrong PIN is refused; posts flow both ways; mirrors converge; Caddy's log holds no post text | pass |
| `tailscale` | 1.1 | opt-in (`TS_SERVE=1` and a tailscale CLI): the plugin's real `sub-human listen` and exactly the commands `invite --web` / `invite --stop` run (`tailscale serve --bg --https=443 --set-path=/sub-human-lab-<rand> http://127.0.0.1:<port>`, then `… --set-path=… off`), with a wss + Noise_NK handshake through the node's MagicDNS name pinned to the listener's key (never Funnel, never `serve reset`). The certificate is warmed first and the connect waits 45 s (a cold ts.net name takes ~20 s). A tailnet without Serve/HTTPS fails the serve check with the plugin's message (the admin URL), within 10 s | skip |
| `wss-resilience` | P3/P2 (1.1) | bob (direct) and ben (corp-proxy) over wss: `docker pause devbox` `LAB_WSS_SLEEP_S` (45) s, both offline, a post queued, back within 30 s, the queued post once; iptables DROP to tls-front / corp-proxy, both dead within `LAB_PING_DEADLINE_MS` and back after the heal; the listener killed and restarted, both redial; converged throughout | pass |
| `login` | P1 | bob's own key is an ordinary line in the devbox account's `authorized_keys`; `/sub-human join host@devbox CODE --as bob` (no invite, PIN or card) first fails at once on the unknown host key, naming `ssh host@devbox` to run once (BatchMode, no hang, no link minted); after that ssh it links and seats in one step through the host's shim (written by alice's join), `serve … --login` runs as host, the room line names the link, posts flow, mirror converges; a key restricted to another link (its forced-command line) gets AUTH on the login path and mints nothing; `/sub-human kick bob` stops the link | pass |
| `short` | P1/P2 (beta.6) | invites on real sshd and the web: `invite --ssh` writes the enrollment door (the room's public key, forced to `serve --enroll`) and shows `/sub-human join host@devbox CODE 4829`; bob (joiner-a, WAN) types a wrong PIN (4 tries left), then the right one: the PAKE through the door, devbox's real Ed25519 host key pinned from inside it, the door gone; alice's tail wakes her card, Let in writes his key as a one-link forced command, online, a bare `/sub-human` seats him, posts flow. ben (joiner-b, corp-proxy, tls-front) joins by URL + PIN the same way; mirrors converge; the front's log holds no PIN. mallory (joiner-b via the bastion) with the public enrollment key: no shell, pty or forwarding; 5 guesses burn the invite, the door closes, the right PIN then says the door is shut | pass |

Statuses: **pass**; **fail** (a check failed: exit 1); **pending** (the feature is not in the plugin yet, so the
scenario or check is not run); **bug** (a known plugin bug; exit 0 unless `LAB_STRICT=1`); **skip** (opt-in).

### Pending features and switching them on

`lab.js` probes the plugin in `/plugin` once the stack is up (`seat-cli.js probe`: CLI commands, transport kinds,
protocol ops, files, source markers) and writes `features.json`. A scenario that `requires` a missing feature is
pending, and a check made with `t.expect(…, feature)` is pending instead of failing. When the feature lands, the
probe finds it and the scenario runs. You can also force things:

- `LAB_FORCE=handoff,wss` runs those scenarios whatever the probe says.
- `LAB_FEATURES=outbox=1,ws=0` overrides single features.
- The interfaces are assumed from `docs/next/PROD-PLAN.md`. Adapt them without editing the scenarios:
  `LAB_HANDOFF_CMD` (default `handoff {name} joiner@joiner-a`, the `/sub-human` form), `LAB_WS_LISTEN_CMD` (default `listen --port {port}`).

| feature | detected by | used in |
|---|---|---|
| `shortCode` | `lib/remote/enroll.js` (invites with a PIN over CPace) | every ssh join, security, short |
| `hostSsh` | `hooks/join.js` handles `--ssh` | p2-corporate |
| `revoke`, `handoff`, `doctor` | the CLI's usage lists `kick` (`revoke` before 0.5.0-beta.6), `handoff`, `doctor` | security, handoff, p1-friends |
| `heartbeat` | protocol op `ping` (or `ping` in `link.js`) | half-open |
| `outbox` | `lib/remote/outbox.js` (or `outbox` in `link.js`) | p3-sleep |
| `autoRejoin` | the daemon renews this machine's seats on reconnect (`keepSeats` in `link.js`) | p3-sleep |
| `versionRange` | `protocol.skewMessage` (the hello's `proto` range) | skew |
| `ws`, `urlPin` | transport kind `ws`/`wss` or `ws.js`/`listener.js`; the join hook takes a URL + PIN | wss, wss-resilience |
| `loginJoin` | the join hook builds a login link (`loginSpec`) | login |

## Evidence

`/tmp/sub-human-lab-<time>/` (or `--out`): `REPORT.md` and `summary.json` (every scenario's status, checks,
timings), `features.json`. One folder per scenario holds `transcript.log`, `summary.json`, `compose-logs.txt` (that
scenario's window only), the host and mirror logs (`log-*.jsonl`, with sha256 in the transcript) and its own extras
(isolation, sshd/proxy logs, iptables, timelines, the secret scan). Invite secrets, PINs and link tokens are
redacted from every file.

## Running

- Needs Docker (28 here). The first run builds `sub-human-lab:node24` and `sub-human-lab-old:cb4d344` and pulls
  toxiproxy and caddy. A full suite takes about 7 minutes, most of it the 90 s sleep, the 60 s flap and the 45 s
  heartbeat waits.
- The suite is idempotent: it starts the stack (or reuses one left by `--keep`), resets every machine between
  scenarios, and runs `compose down -v --remove-orphans` at the end.
- One stack: `node scripts/remote-docker/harness.js scenarios --only p1 --keep`, then
  `docker compose -p sub-human-lab -f scripts/remote-docker/lab/compose.yml exec -u joiner joiner-a bash` to look
  around. `docker compose -p sub-human-lab -f scripts/remote-docker/lab/compose.yml down -v` when done.
- Link timings: `SUB_HUMAN_LINK_*_MS` in the harness's environment reach every machine's hooks, CLI and link daemons
  (a scenario may add its own `linkEnv`); the default run uses the plugin's own timings.
- Knobs: `LAB_SLEEP_S`, `LAB_JOINER_SLEEP_S`, `LAB_FLAP_CUTS`, `LAB_FLAP_PERIOD_MS`, `LAB_HEARTBEAT_DEADLINE_MS`,
  `LAB_PING_DEADLINE_MS`, `LAB_WSS_SLEEP_S` (45), `LAB_WS_PORT` (7420), `LAB_WS_FWD_PORT` (7421), `LAB_OLD_REF` (cb4d344), `LAB_STRICT`.

## Files

- `harness.js`: the entry point: `scenarios`, `run` and the manual mode.
- `lab.js`: the lab controller and the scenario runner.
- `scenarios/`: one file per scenario, plus `_lib.js` (ssh routes and the delivery, link-state and convergence helpers).
- `lab/`: `compose.yml`, `Dockerfile` (the one machine image), `Dockerfile.old`, `entry.sh` (roles), `seat-cli.js` /
  `seat-proc.js` (seats inside a machine), `fwd.js`, `ws-probe.js`, `tinyproxy.conf`, `Caddyfile`.
- `compose.yml`, `Dockerfile` and `host-cli.js`: the original single-devbox stack (`run` and the manual mode).
