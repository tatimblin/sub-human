#!/usr/bin/env bash
# devbox.sh — a private sshd for the film's remote join (scripts/demo.sh --film): tristan's machine as ssh reaches it.
# It runs as you (no root, no sudo), listens on 127.0.0.1 only, and never reads or writes ~/.ssh or /etc/ssh:
# its own Ed25519 host key, its own sshd_config, and its own authorized_keys (the file sub-human's
# SUB_HUMAN_AUTHORIZED_KEYS names on the host seat: the invite's enrollment door and the card's Let in line go there).
# sshd run by a non-root user can only log that user in, so the ssh login is your own account: the configs name it
# (User), and nothing on screen does (the invite and the join line say `devbox`).
#
#   scripts/devbox.sh up DEVBOX LAPTOP [PORT]   make what is missing and start sshd unless it runs (PORT 2222)
#       DEVBOX/ssh_host_ed25519_key(.pub)  the host key (made once: a resumed take keeps the key jess's link pinned)
#       DEVBOX/.ssh/authorized_keys        sub-human's lines only (made once, empty)
#       DEVBOX/sshd_config, sshd.pid, sshd.log
#       DEVBOX/ssh_config                  the host seat's own `Host devbox` (SUB_HUMAN_SSH_OPTS=-F …: ssh -G names the user)
#       LAPTOP/.ssh/config                 jess's ssh: `Host devbox` -> 127.0.0.1:PORT, her own known_hosts
#   scripts/devbox.sh down DEVBOX               stop that sshd and its sessions (and nothing else)
#   scripts/devbox.sh status DEVBOX             exit 0 when it runs
set -u

cmd=${1:-}; DEVBOX=${2:-}
[ -n "$DEVBOX" ] || { echo "usage: devbox.sh up DEVBOX LAPTOP [PORT] | down DEVBOX | status DEVBOX" >&2; exit 2; }
SSHD=/usr/sbin/sshd
PIDF="$DEVBOX/sshd.pid"

running() { local p; p=$(cat "$PIDF" 2>/dev/null) && [ -n "$p" ] && kill -0 "$p" 2>/dev/null && ps -p "$p" -o command= 2>/dev/null | grep -q -- "-f $DEVBOX/sshd_config"; }

case "$cmd" in
  status) running; exit $? ;;
  down)
    if running; then
      pkill -P "$(cat "$PIDF")" 2>/dev/null   # its sessions (sshd-session: a link's serve ends with its ssh)
      kill "$(cat "$PIDF")" 2>/dev/null
      for _ in 1 2 3 4 5 6 7 8 9 10; do running || break; sleep 0.2; done
      echo "devbox: sshd stopped"
    fi
    pkill -f -- "$SSHD -D -e -f $DEVBOX/sshd_config" 2>/dev/null
    rm -f "$PIDF"; exit 0 ;;
  up) ;;
  *) echo "usage: devbox.sh up DEVBOX LAPTOP [PORT] | down DEVBOX | status DEVBOX" >&2; exit 2 ;;
esac

LAPTOP=${3:-}; PORT=${4:-2222}
[ -n "$LAPTOP" ] || { echo "devbox.sh up: name jess's machine dir (LAPTOP)" >&2; exit 2; }
U=$(id -un)
mkdir -p "$DEVBOX/.ssh" "$LAPTOP/.ssh" || exit 1
chmod 700 "$DEVBOX" "$DEVBOX/.ssh" "$LAPTOP/.ssh"
[ -f "$DEVBOX/ssh_host_ed25519_key" ] || ssh-keygen -q -t ed25519 -N '' -C devbox -f "$DEVBOX/ssh_host_ed25519_key" || exit 1
[ -f "$DEVBOX/.ssh/authorized_keys" ] || { : > "$DEVBOX/.ssh/authorized_keys"; chmod 600 "$DEVBOX/.ssh/authorized_keys"; }
cat > "$DEVBOX/sshd_config" <<EOF
# a private sshd for the sub-human film (scripts/devbox.sh): this user only, loopback only, keys only
ListenAddress 127.0.0.1
Port $PORT
HostKey $DEVBOX/ssh_host_ed25519_key
PidFile $PIDF
AuthorizedKeysFile $DEVBOX/.ssh/authorized_keys
AuthorizedPrincipalsFile none
AuthenticationMethods publickey
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
StrictModes no
AllowUsers $U
PermitRootLogin no
PermitUserEnvironment no
AllowAgentForwarding no
AllowTcpForwarding no
X11Forwarding no
PermitTunnel no
PrintMotd no
EOF
# the host seat's view of its own address (the invite's record: ssh -G devbox names the user)
cat > "$DEVBOX/ssh_config" <<EOF
Host devbox
  HostName 127.0.0.1
  Port $PORT
  User $U
EOF
# jess's ssh: her machine's own config and known_hosts (sub-human adds its own pinned known_hosts per link)
cat > "$LAPTOP/.ssh/config" <<EOF
Host devbox
  HostName 127.0.0.1
  Port $PORT
  User $U
  UserKnownHostsFile $LAPTOP/.ssh/known_hosts
  GlobalKnownHostsFile /dev/null
  IdentityAgent none
  ControlMaster no
EOF
chmod 600 "$DEVBOX/sshd_config" "$DEVBOX/ssh_config" "$LAPTOP/.ssh/config"
running && exit 0
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "devbox: port $PORT is taken by another process" >&2; exit 1; fi
"$SSHD" -t -f "$DEVBOX/sshd_config" || { echo "devbox: sshd refused its config" >&2; exit 1; }
# -D: stays a child we can stop; -e: its log to sshd.log
nohup "$SSHD" -D -e -f "$DEVBOX/sshd_config" >> "$DEVBOX/sshd.log" 2>&1 < /dev/null &
for _ in $(seq 50); do
  running && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && { echo "devbox: sshd on 127.0.0.1:$PORT (pid $(cat "$PIDF"))"; exit 0; }
  sleep 0.1
done
echo "devbox: sshd did not start (see $DEVBOX/sshd.log)" >&2; exit 1
