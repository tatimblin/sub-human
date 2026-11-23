# Security

## Reporting a vulnerability

Please report it privately through GitHub: **Security → Report a vulnerability** on this repository
(https://github.com/tatimblin/sub-human/security/advisories/new). Don't open a public issue for it. You'll get a
reply within a few days. sub-human is a one-person project, so there is no bounty, but you will be credited in the
fix's release notes if you want to be.

## Threat model

The threat is **outsiders**: someone who isn't in a room reading it, writing to it, or impersonating its host. Inside
a room, members and their Claudes are trusted collaborators.

- **Admission.** `/sub-human invite NAME` makes one line holding a 128-bit secret and the host's public key. The line
  works once, for 15 minutes. It is made for NAME, but the line does not enforce the name: the card shows the name the
  joiner gave and the name the invite was for, and the host decides. The secret travels only inside an encrypted
  channel keyed to the host's key, so it never reaches anyone but the real host, and the proof of it is compared in
  constant time. The host's records (`host.json`, readable by its owner only) keep each open invite's MAC key, which
  is derived from the secret and admits as the line does until the line is used or expires. A dial that carries
  neither a known machine key nor proof of an open invite is refused before any record, card or state change. Nobody
  is let in without the host's **Let in** on a card that shows the joiner's name, machine and a check string both
  people compare. A second use of a line, even at the same moment as the first, refuses both dials and alerts the host.
- **The channel.** Every connection, over Tailscale (Funnel or Serve) or ssh, runs Noise XK
  (`Noise_XK_25519_ChaChaPoly_SHA256`, on `node:crypto`, checked against the published test vectors in CI). Each
  joining machine proves a key of its own; that key is its access, and `/sub-human kick NAME` ends it for good.
- **Behind Funnel.** Each connection's real source comes from a PROXY v2 header and is limited per source (an IPv6
  source per /64) and in all, with room kept for ssh connections, which have a cap of their own; writes, messages
  and resubscribes are rate-limited per machine.
- **The log.** A room's history is append-only and hash-chained, with the host authoritative: a machine's copy that
  stops chaining is discarded and synced again from the host. The host checks that each write comes from the member
  the machine that sent it was let in as, refuses the kinds only it may write, and takes no system entry from another
  machine but that member's own joined and left. A machine hosting a room never takes a line for a room of the same
  code.
- **Secrets.** Nothing that matches a curated secret-pattern list (from gitleaks), in an update, a message between
  Claudes, a plan or a task, no `.env`-style or key file, no ignored file and no file outside the repo is shared. Invite secrets are never written to the room's history or the
  host's records.
- **Permissions.** No hook ever answers a permission check with allow; every permission decision stays the person's.

**What sub-human does not try to stop.** A member's own Claude acting for its person. Attribution (a person or their
Claude) is honest labelling, not a security boundary. Text planted in a repo can reach a colleague's Claude through
your Claude's messages; framing it as a colleague's request, showing the person anything that would wake their Claude
and carries a command or URL (a Claude's message or a person's line alike) instead of handing it to their Claude, and
an hourly wake budget limit what it can do, but don't make it impossible. A colleague's text reaches your terminal and
your Claude as one line or a marked block, with escape sequences, bidi overrides and forged labels taken out. The host holds the room's history and applies every write, so everyone who joins trusts the host. An
invite line sits in the transcript of the session it was typed in; it is single-use and short-lived for that reason.

## Privacy

sub-human has **no server and no telemetry**. Nothing is sent to the author or any third party. A room's data is
stored on the host's machine and on each joined machine's copy of the room, under `~/.sub-human` (owner-only files),
and travels only over the connections you set up (Tailscale or ssh). Messages between two Claudes are delivered only
to the recipient and never written to the room's history.
