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
  `/home/host/.sub-human`. The plugin is mounted read-only at `/plugin`; `claude` is a stub, so no orch runs. It is on
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
| `p1-friends` | P1 | joiner-a joins by ssh; posts reach the other side's tail in under 2 s, also with a 300 ms latency toxic each way; machine ids distinct; mirror byte-identical. With `doctor`: doctor ok, `--bundle` holds no secret | pass (doctor pending) |
| `p2-corporate` | P2 | joiner-b's isolation (no route, no DNS, only bastion and proxy); join and posts via ProxyJump through the bastion; a second home joins via the CONNECT proxy; bastion and proxy logs show the hops. With `host --ssh`: `--via` | pass (`host --ssh --via` pending) |
| `p3-sleep` | P3 | `docker pause devbox` 90 s (`LAB_SLEEP_S`): both links go offline, then come back within 30 s of the wake; a post while offline is refused clearly; no line lost or duplicated. `docker pause joiner-a` 45 s (`LAB_JOINER_SLEEP_S`): it catches up on the 6 posts it slept through. With the outbox, the post made during the sleep is flushed exactly once | pass (outbox pending) |
| `half-open` | P3/P2 | a toxiproxy `timeout` toxic (bob) and iptables DROP (bea) black-hole the links; a post fails within 10 s; both links are declared dead within 50 s (`LAB_HEARTBEAT_DEADLINE_MS`: ssh ServerAlive 15 s × 2). With the app ping, within 35 s | pass (ping deadline pending) |
| `flap` | P1/P3 | 10 cuts in 60 s (alternating disable and `reset_peer`) while everyone posts; ends byte-identical; every accepted post once; no ghost; bea via the bastion is the control | pass |
| `slow-link` | P1 | 5 s of upstream latency: the post times out ("nothing was sent"); it must not land later | **BUG** (it lands: a ghost post) |
| `skew` | mixed | 0.2.0 host ← 0.3.0 joiner, 0.3.0 host ← 0.2.0 joiner: compatible or a clear version message, never divergence; a v99 hello is refused `PROTOCOL` (with the version range: "which side to update") | pass (update message pending) |
| `security` | all | `ssh devbox ls` runs the forced command, not a shell; no pty; no `-W`; the bastion has no shell; homes 0700 with nothing group/world readable; no invite secret or token in any log, room file, process list or other file. With sh2+PIN: 5 wrong PINs burn the invite. With `revoke`: key removed, serve stopped, link cut | pass (PIN, revoke pending) |
| `handoff` | P3 | devbox hands the room to bob (joiner-a); bea follows; all copies converge with the old lines kept | pending (`handoff`) |
| `tls-front` | 1.1 | `https://tls-front/` verifies against the lab CA and answers 502 with no listener; with a stand-in listener on the devbox loopback (`lab/ws-probe.js`) the upgrade is 101 and echoes, from joiner-a and from joiner-b only through corp-proxy | pass |
| `wss` | 1.1 | the host's `sub-human listen` on 127.0.0.1:7420; `/sub-human host --url https://tls-front` mints a join URL (`https://tls-front/sub-human/CODE#SECRET.KEY`) + PIN; bob and (through corp-proxy) ben link with it (no admit step) and take their seats; a wrong PIN is refused; posts flow both ways; mirrors converge; Caddy's log holds no post text | pass |
| `tailscale` | 1.1 | opt-in (`TS_SERVE=1` and a tailscale CLI): the plugin's real `sub-human listen` and exactly the commands `host --tailscale` / `unhost` run (`tailscale serve --bg --https=443 --set-path=/sub-human-lab-<rand> http://127.0.0.1:<port>`, then `… --set-path=… off`), with a wss + Noise_NK handshake through the node's MagicDNS name pinned to the listener's key (never Funnel, never `serve reset`) | skip |
| `wss-resilience` | P3/P2 (1.1) | bob (direct) and ben (corp-proxy) over wss: `docker pause devbox` `LAB_WSS_SLEEP_S` (45) s, both offline, a post queued, back within 30 s, the queued post once; iptables DROP to tls-front / corp-proxy, both dead within `LAB_PING_DEADLINE_MS` and back after the heal; the listener killed and restarted, both redial; converged throughout | pass |

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
  `LAB_HANDOFF_CMD` (default `handoff --to {name} --yes`), `LAB_WS_LISTEN_CMD` (default `listen --port {port}`),
  `LAB_WS_INVITE=cli|expand`.

| feature | detected by | used in |
|---|---|---|
| `sh2Pin` | `lib/remote/auth.js` mentions sh2 and a PIN | security |
| `hostSsh` | `hooks/join.js` handles `host --ssh` | p2-corporate, security |
| `revoke`, `handoff`, `doctor` | the CLI's usage lists the command | security, handoff, p1-friends |
| `heartbeat` | protocol op `ping` (or `ping` in `link.js`) | half-open |
| `outbox` | `lib/remote/outbox.js` (or `outbox` in `link.js`) | p3-sleep |
| `autoRejoin` | `rejoin` in `link.js` | p3-sleep |
| `versionRange` | `min_v`/`vmin`/`MIN_VERSION` in protocol or server | skew |
| `ws`, `urlPin` | transport kind `ws`/`wss` or `ws.js`/`listener.js`; the join hook takes a URL + PIN | wss, wss-resilience |

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
- Knobs: `LAB_SLEEP_S`, `LAB_JOINER_SLEEP_S`, `LAB_FLAP_CUTS`, `LAB_FLAP_PERIOD_MS`, `LAB_HEARTBEAT_DEADLINE_MS`,
  `LAB_PING_DEADLINE_MS`, `LAB_WSS_SLEEP_S` (45), `LAB_WS_PORT` (7420), `LAB_WS_FWD_PORT` (7421), `LAB_OLD_REF` (cb4d344), `LAB_STRICT`.

## Files

- `harness.js`: the entry point: `scenarios`, `run` and the manual mode.
- `lab.js`: the lab controller and the scenario runner.
- `scenarios/`: one file per scenario, plus `_lib.js` (ssh routes and the delivery, link-state and convergence helpers).
- `lab/`: `compose.yml`, `Dockerfile` (the one machine image), `Dockerfile.old`, `entry.sh` (roles), `seat-cli.js` /
  `seat-proc.js` (seats inside a machine), `fwd.js`, `ws-probe.js`, `tinyproxy.conf`, `Caddyfile`.
- `compose.yml`, `Dockerfile` and `host-cli.js`: the original single-devbox stack (`run` and the manual mode).
