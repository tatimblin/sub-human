#!/bin/sh
# The lab image's entrypoint (scripts/remote-docker/lab/Dockerfile): one role per container.
#   devbox   sshd for user `host` (keys only, no forwarding); /lab/fwd.js, the stand-in for `tailscale serve`:
#            0.0.0.0:$LAB_WS_FWD_PORT -> 127.0.0.1:$LAB_WS_PORT (the host's future ws listener, 1.1)
#   bastion  sshd for user `jump`: no shell, no tty, TCP forwarding only to $LAB_PERMIT_OPEN (ProxyJump)
#   joiner   sshd for user `joiner` (used only once a handoff makes this joiner the host)
#   proxy    tinyproxy with /lab/tinyproxy.conf: the corporate HTTP CONNECT egress
# Every container makes its own sshd host keys at start, so no two machines share a host key.
set -e
role="$1"
sshd_for() {
  ssh-keygen -A >/dev/null
  {
    echo 'PasswordAuthentication no'
    echo 'KbdInteractiveAuthentication no'
    echo 'PermitRootLogin no'
    echo 'PubkeyAuthentication yes'
    echo 'LogLevel VERBOSE'
    echo 'X11Forwarding no'
    echo "AllowUsers $1"
    shift
    for line in "$@"; do echo "$line"; done
  } > /etc/ssh/sshd_config.d/lab.conf
}
case "$role" in
  devbox)
    sshd_for host 'AllowTcpForwarding no' 'AllowAgentForwarding no'
    node /lab/fwd.js "${LAB_WS_FWD_PORT:-7421}" "${LAB_WS_PORT:-7420}" &
    exec /usr/sbin/sshd -D -e ;;
  bastion)
    sshd_for jump 'AllowTcpForwarding yes' "PermitOpen ${LAB_PERMIT_OPEN:-devbox:22}" 'PermitTTY no' 'ForceCommand /usr/sbin/nologin'
    exec /usr/sbin/sshd -D -e ;;
  joiner)
    sshd_for joiner 'AllowTcpForwarding no'
    exec /usr/sbin/sshd -D -e ;;
  proxy)
    exec tinyproxy -d -c /lab/tinyproxy.conf ;;
  *) echo "lab-entry: unknown role '$role'" >&2; exit 2 ;;
esac
