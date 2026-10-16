# scripts/remote-docker: the sub-human lab

Test and validation environments for remote rooms 1.0 (SSH) and 1.1 (wss through a TLS front). Everything runs in
Docker on this Mac. Nothing touches this Mac's sshd, `~/.ssh` or `~/.sub-human`.

**Stage 7b (the invite redesign): nothing here was run either.** No Docker where it was done. Every ssh join is now
the joiner's own ssh login to the host account (the lab authorizes the joiner's key there, as a person sets up any
login: `lab.authorizeLogin`), with an invite line (`/sub-human join DEST ROOM SECRET`) typed first and the PIN when the
host asks (`seat-cli short` then `pin`); web joins check the listener's key against the line and run Noise XK. There is
no enrollment door, no forced-command line and no `lab/attack.js` any more: the stranger, stolen-line-without-PIN and
PIN-guessing cases are the plugin's unit tests (`test/remote-invite-ssh`, `remote-invite-line`, `remote-short`), and
the `security` and `short` scenarios mark them pending. Checked with `node --check` only.

**Stage 7 (the remote simplification): nothing here was run.** There was no Docker where it was done. The scenarios,
the lab driver and the seat CLI were updated to the protocol as it now is (no sh1 invites: every join is the PIN join
or the login join; typed error reasons; machine ids from the joiner's machine key; the login consent-merge option), and
checked only with `node --check`. The "today" column below is the last run before Stage 7.

| What | Command | Stack |
|---|---|---|
| The scenario suite (personas P1–P3, chaos, skew, security, 1.1) | `npm run test:remote-docker` or `node scripts/remote-docker/harness.js scenarios [--only ID[,ID]] [--out DIR] [--keep]` | `lab/compose.yml`, project `sub-human-lab` |
| The original 11 assertions, with this Mac as the joiner: **not ported** to the PIN join yet (it linked with an sh1 invite, gone in Stage 7); `harness.js run` exits 2 saying so | `npm run test:remote-docker:mac` or `harness.js run` | `compose.yml`, project `sub-human-remote` |
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
              [devbox-old]  plugin 0.5.0-beta.15 (7c97bdb), baked in      [joiner-b] -+-> bastion:22
                                                                          P2 corporate  corp-proxy:3128
```

- **devbox**: node 24, sshd (keys only, `AllowTcpForwarding no`), user `host` with the room in
  `/home/host/.sub-human`. The plugin is mounted read-only at `/plugin`; `claude` is a stub, so no room Claude runs. It is on
  the internal `core` network only: a joiner reaches it through toxiproxy (the chaos-able WAN path), through the
  bastion (ProxyJump) or, for 1.1, through tls-front.
- **devbox-old**: the same image with the previous release, plugin 0.5.0-beta.15, from `git archive 7c97bdb
  plugin/sub-human` baked in (`lab/Dockerfile.old`, built once by `lab.js` as `sub-human-lab-old:7c97bdb`; `LAB_OLD_REF`
  for another). Its `joiner` user is the beta.15 joiner. Releases before 0.5 are not interoperated with any more.
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
| `p1-friends` | P1 | joiner-a joins by ssh with the real flow (its key a login on devbox; `/sub-human invite --ssh`, the line `/sub-human join host@devbox CODE SECRET --as bob`, then `/sub-human join PIN` when the host asks, the host's card Let in, a bare `/sub-human`); posts reach the other side's tail in under 2 s, also with a 300 ms latency toxic each way; machine ids distinct (bob's is the one his machine key gives, `k…`, kept in joiner-a's `machines.json`); mirror byte-identical; `doctor` exits 0, `doctor --json` passes the link and the clock, `--bundle FILE` holds no token, secret, PIN or room code | not run (Stage 7b) |
| `p2-corporate` | P2 | joiner-b's isolation (no route, no DNS, only bastion and proxy); bea joins with the line from `invite --ssh … --via jump@bastion` (her own login, `ssh -J`, her own known_hosts); a second home joins via the CONNECT proxy; bastion and proxy logs show the hops | not run (Stage 7b) |
| `p3-sleep` | P3 | `docker pause devbox` 90 s (`LAB_SLEEP_S`): both links go offline, then come back within 30 s of the wake; a post while offline is queued (`⧗ queued`) and flushed exactly once; seats renewed with no left/joined line; no line lost or duplicated. `docker pause joiner-a` 45 s (`LAB_JOINER_SLEEP_S`): it catches up on the 6 posts it slept through. Default link timings | pass |
| `half-open` | P3/P2 | a toxiproxy `timeout` toxic (bob) and iptables DROP (bea) black-hole the links; a post returns within 10 s (`⧗ sending`, kept under its nonce) and lands exactly once after the heal; both links are declared dead within 35 s by the app ping (`LAB_PING_DEADLINE_MS`) | pass |
| `flap` | P1/P3 | 10 cuts in 60 s (alternating disable and `reset_peer`) while everyone posts; ends byte-identical; every accepted post once; no ghost; bea via the bastion is the control | pass |
| `slow-link` | P1 | 5 s of upstream latency, past the hook's 3 s deadline: the hook says `⧗ sending (slow link)` within 3 s, never "nothing was sent"; the post lands exactly once (no ghost, no double) and the outbox empties | pass |
| `skew` | mixed | beta.15 host ← current joiner: its line ends with a 4-digit PIN, refused here naming the host's update; current host ← beta.15 joiner: beta.15 refuses the SECRET line, and the host's invite text names the version it needs; a link made before keeps working (protocol 1..3 against 1..2 settles on 2, unit-tested); a hello as a 9.9.9 joiner (protocol 99) into the host's serve over an ssh login is refused `PROTOCOL` (reason `SKEW`) naming both versions and "The host must update" | not run (Stage 7b) |
| `security` | all | nothing of sub-human's in the devbox account's `authorized_keys` (no door, no forced command); the bastion has no shell; homes 0700 with nothing group/world readable; no link token in any log, room file, process list or other file; PIN guessing pending (unit-tested); `/sub-human kick bob`: his link's token ends, serve stopped, bob's link stops (AUTH, typed reason) and his post is refused, bea untouched | not run (Stage 7b) |
| `handoff` | P3 | alice (devbox) runs `/sub-human handoff bob joiner@joiner-a`; bob answers the card; joiner-a hosts at epoch 1 (both signatures in `host_changed`), devbox mirrors it; bea's re-pointed link (her own login, the invite bob's machine minted for hers) is offline with a reason naming bob and the way out while she has no login on joiner-a (`doctor --json` shows the link moved, not reached); once joiner-a's account takes her key and devbox's, each joins again over its login; posts flow, `handoff --status` shows nobody left behind, every copy converges with the old lines kept | not run (Stage 7b) |
| `tls-front` | 1.1 | `https://tls-front/` verifies against the lab CA and answers 502 with no listener; with a stand-in listener on the devbox loopback (`lab/ws-probe.js`) the upgrade is 101 and echoes, from joiner-a and from joiner-b only through corp-proxy | pass |
| `wss` | 1.1 | the host's `sub-human listen` on 127.0.0.1:7420; `/sub-human invite --url https://tls-front` shows `/sub-human join https://tls-front/sub-human/CODE SECRET` and the PIN apart (no name, no `#`); bob and (through corp-proxy) ben type the line (the listener's key checked against it, Noise XK with a key of the link's own), then the PIN when asked; a wrong PIN is refused; alice's card lets each in, a bare `/sub-human` seats them; posts flow both ways; mirrors converge; Caddy's log holds no post text | not run (Stage 7b) |
| `tailscale` | 1.1 | opt-in (`TS_SERVE=1` and a tailscale CLI): the plugin's real `sub-human listen` and exactly the commands `invite --web` / `invite --stop` run (`tailscale serve --bg --https=443 --set-path=/sub-human-lab-<rand> http://127.0.0.1:<port>`, then `… --set-path=… off`), with a wss + Noise_NK handshake through the node's MagicDNS name pinned to the listener's key (never Funnel, never `serve reset`). The certificate is warmed first and the connect waits 45 s (a cold ts.net name takes ~20 s). A tailnet without Serve/HTTPS fails the serve check with the plugin's message (the admin URL), within 10 s | skip |
| `wss-resilience` | P3/P2 (1.1) | bob (direct) and ben (corp-proxy) over wss: `docker pause devbox` `LAB_WSS_SLEEP_S` (45) s, both offline, a post queued, back within 30 s, the queued post once; iptables DROP to tls-front / corp-proxy, both dead within `LAB_PING_DEADLINE_MS` and back after the heal; the listener killed and restarted, both redial; converged throughout | pass |
| `login` | P1 | bob's own key is an ordinary line in the devbox account's `authorized_keys`; `/sub-human join host@devbox CODE --as bob` (no invite, PIN or card) first fails at once on the unknown host key, naming `ssh host@devbox` to run once (BatchMode, no hang, no link minted); after that ssh it links and seats in one step through the host's shim (written by alice's join), `serve … --login` runs as host, the room line names the link, posts flow, mirror converges; the login seat has no account by default (its own person for consent; `sub-human options CODE login-same-person on` in the host's shell makes it the owner's) and its machine id is its machine key's (`k…`); a key restricted to another link (the forced-command line a card's Let in writes, here written directly) gets AUTH on the login path and mints nothing; `/sub-human kick bob` stops the link | not run (Stage 7) |
| `short` | P1/P2 | invite lines on real sshd and the web: `invite --ssh` writes nothing to `authorized_keys` and shows the line and the PIN apart; bob (joiner-a, WAN, his own login) types the line, the host asks for the PIN, a wrong PIN (4 tries left), the right one; alice's card; online; a bare `/sub-human` seats him; posts flow. ben (joiner-b, corp-proxy, tls-front) joins by URL + SECRET, then the PIN; mirrors converge; the front's log holds no PIN or SECRET. Strangers and PIN guessing: pending (unit-tested) | not run (Stage 7b) |

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
| `inviteLine` | `lib/remote/invite-secret.ts` (protocol 3: an invite line and its PIN apart) | short |
| `shortCode` | `lib/remote/enroll.ts` (0.5.0-beta.15's PIN over CPace: the old end in skew) | skew |
| `hostSsh` | `hooks/handlers/join.ts` handles `--ssh` | p2-corporate |
| `revoke`, `handoff`, `doctor` | the CLI's usage lists `kick` (`revoke` before 0.5.0-beta.6), `handoff`, `doctor` | security, handoff, p1-friends |
| `heartbeat` | protocol op `ping` (or `ping` in `link.ts`) | half-open |
| `outbox` | `lib/remote/outbox.ts` (or `outbox` in `link.ts`) | p3-sleep |
| `autoRejoin` | the daemon renews this machine's seats on reconnect (`keepSeats` in `link.ts`) | p3-sleep |
| `versionRange` | `protocol.skewMessage` (the hello's `proto` range) | skew |
| `outbox`, `heartbeat`, `autoRejoin` (source markers) | `link.ts`, `link-engine.ts` and `link-connect.ts` together (Stage 7 split the daemon); `invites.ts`, else beta.15's `auth.ts`, for the sh2 / PIN markers | as above |
| `ws`, `urlPin` | transport kind `ws`/`wss` or `ws.ts`/`listener.ts`; the join hook takes a URL + PIN | wss, wss-resilience |
| `loginJoin` | the join hook builds a login link (`loginSpec`) | login |

## Evidence

`/tmp/sub-human-lab-<time>/` (or `--out`): `REPORT.md` and `summary.json` (every scenario's status, checks,
timings), `features.json`. One folder per scenario holds `transcript.log`, `summary.json`, `compose-logs.txt` (that
scenario's window only), the host and mirror logs (`log-*.jsonl`, with sha256 in the transcript) and its own extras
(isolation, sshd/proxy logs, iptables, timelines, the secret scan). Invite secrets, PINs and link tokens are
redacted from every file.

## Running

- Needs Docker (28 here). The first run builds `sub-human-lab:node24` and `sub-human-lab-old:7c97bdb` and pulls
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
  `LAB_PING_DEADLINE_MS`, `LAB_WSS_SLEEP_S` (45), `LAB_WS_PORT` (7420), `LAB_WS_FWD_PORT` (7421), `LAB_OLD_REF` (7c97bdb), `LAB_STRICT`.

## Files

- `harness.js`: the entry point: `scenarios`, `run` and the manual mode.
- `lab.js`: the lab controller and the scenario runner.
- `scenarios/`: one file per scenario, plus `_lib.js` (ssh routes and the delivery, link-state and convergence helpers).
- `lab/`: `compose.yml`, `Dockerfile` (the one machine image), `Dockerfile.old`, `entry.sh` (roles), `seat-cli.js` /
  `seat-proc.js` (seats inside a machine), `fwd.js`, `ws-probe.js`, `tinyproxy.conf`, `Caddyfile`.
- `compose.yml`, `Dockerfile` and `host-cli.js`: the original single-devbox stack (the manual mode; `run` is not ported).
