# The sub-human lab's one machine image (scripts/remote-docker/lab/compose.yml): node 24, OpenSSH server and client,
# and the network tools the scenarios use (iptables for a half-open link, tcpdump, nc). entry.sh picks the role:
# devbox | joiner. Users: `host` (the devbox's room owner), `joiner` (a joiner's person). sshd takes
# keys only. `claude` is a stub that fails, so the room's Claude never starts (no real Claude, no login).
FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server openssh-client procps iproute2 iptables tcpdump \
      netcat-openbsd curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -m -s /bin/bash host && useradd -m -s /bin/bash joiner \
 && for u in host joiner; do install -d -m 0700 -o $u -g $u /home/$u/.ssh; done \
 && mkdir -p /run/sshd \
 && printf '#!/bin/sh\necho "claude: stub in the sub-human lab (no real Claude here)" >&2\nexit 1\n' > /usr/local/bin/claude \
 && chmod 0755 /usr/local/bin/claude
COPY entry.sh /usr/local/bin/lab-entry
RUN chmod 0755 /usr/local/bin/lab-entry
ENTRYPOINT ["/usr/local/bin/lab-entry"]
