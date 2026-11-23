# Security

> **v2 is in progress.** This branch is a rebuild and is not yet usable. Its security design (admission, the Noise
> channel, what reaches a model) is in [docs/PRD.md](docs/PRD.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md);
> this page is rewritten when v2 ships. The 0.8 threat model is in git history.

## Reporting a vulnerability

Please report it privately through GitHub: **Security → Report a vulnerability** on this repository
(https://github.com/tatimblin/sub-human/security/advisories/new). Don't open a public issue for it. You'll get a
reply within a few days. sub-human is a one-person project, so there is no bounty, but you will be credited in the
fix's release notes if you want to be.

## What v2 aims to protect

- **Only a person agrees for themselves.** No Claude agrees to a plan, or speaks, as its person.
- **Invite secrets never reach a model.** An invite is shown to the person only.
- **The host is trusted** by everyone who joins it: it holds the room's log and applies every write.

## Privacy

sub-human has **no server and no telemetry**. Nothing is sent to the author or any third party. A room's data is
stored on the host's machine and on each joined machine's copy of the room, and travels only over the links you set
up (Tailscale or ssh).
