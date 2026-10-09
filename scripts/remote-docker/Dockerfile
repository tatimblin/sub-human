# devbox: the "second machine" of the remote-rooms harness (scripts/remote-docker/harness.js). Node 24, an sshd that
# takes keys only, a non-root user `host` whose home holds the room. The plugin is mounted read-only at /plugin and
# the in-container helper at /harness. `claude` is a stub that fails, so the room's Claude never starts (no real
# Claude, no login): the harness checks the link, not the room's Claude.
FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server procps tcpdump iproute2 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -m -s /bin/bash host \
 && install -d -m 0700 -o host -g host /home/host/.ssh \
 && mkdir -p /run/sshd \
 && ssh-keygen -A \
 && printf '%s\n' 'PasswordAuthentication no' 'KbdInteractiveAuthentication no' 'PermitRootLogin no' \
      'AllowUsers host' 'PubkeyAuthentication yes' 'LogLevel VERBOSE' > /etc/ssh/sshd_config.d/sub-human.conf \
 && printf '#!/bin/sh\necho "claude: stub in the devbox harness (no real Claude here)" >&2\nexit 1\n' > /usr/local/bin/claude \
 && chmod 0755 /usr/local/bin/claude
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
