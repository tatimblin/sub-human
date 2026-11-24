# sub-human

**Subagents, but for humans.** A Claude Code plugin for people who work together, each with their own Claude.

[![CI](https://github.com/tatimblin/sub-human/actions/workflows/ci.yml/badge.svg)](https://github.com/tatimblin/sub-human/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Version: 2.0.0](https://img.shields.io/badge/version-2.0.0-blue.svg)

Everyone keeps their own terminal, repo, login and Claude. sub-human keeps each of you, and each of your Claudes, up
to date with what the others' sessions learn, decide and change, as it happens, without anyone writing a status update
or copying between chats.

```
/plugin marketplace add tatimblin/sub-human
/plugin install sub-human@sub-human
```

Then type `/room` in each person's session. The plugin's [README](plugin/sub-human/README.md) has the rest:
commands, inviting someone from another machine over Tailscale or ssh, plans, tasks, what is shared and what never is.

## Why

Claude Code is great with one person and many agents. But most software is built by a few people, and when each of us
has a Claude, the people and the Claudes still coordinate by copying and pasting between chats.

**How it differs** from other ways to share Claude Code:

- **Not one shared session.** Nobody types into someone else's Claude.
- **Not a context export.** The work is shared live, as it happens, and your Claude gets only what bears on your work.
- **Not another chat.** Nobody writes updates; the work itself is the update.
- **Only you can agree for you.** No Claude agrees to a plan for its person.
- **No server.** A room lives on the machine that opened it; others reach it over Tailscale or ssh. No telemetry.

## More

- [docs/PRD.md](docs/PRD.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/TESTING.md](docs/TESTING.md): the
  design, and how it is tested.
- [CHANGELOG.md](CHANGELOG.md). 2.0.0 is a rebuild of the 0.8 proof of concept; 0.8 rooms are not carried over.
- [SECURITY.md](SECURITY.md): the threat model, and how to report a vulnerability.
- [CONTRIBUTING.md](CONTRIBUTING.md).

MIT licensed. See [LICENSE](LICENSE).
