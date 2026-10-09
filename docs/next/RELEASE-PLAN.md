# sub-human public release plan

Goal: a stranger goes from install to a working room in under 5 minutes. A friend joins in one step, the project looks trustworthy enough to install a plugin that touches SSH keys, and the plugin gets listed where Claude Code users look.

Sources: three research passes, run on 2026-10-08:
- a repo audit;
- a study of the distribution mechanics (code.claude.com/docs/en/plugins/*, claude.com/docs/plugins/*);
- a study of how comparable tools got adopted (Superpowers, claude-mem, croc, sshx, upterm, Live Share, Tuple).

## Where we stand

**Strong already:**
- the core security model (signed seats, hash chain, PINs never seen by the model, pinned keys);
- `doctor --fix --bundle`;
- `claude plugin validate --strict` in CI;
- no top-level `bin/`;
- no npm dependencies;
- no telemetry;
- an SSH lab and a Tailscale lab.

**Blocking a public release:**
1. **The repo is private** and has no LICENSE. Without a license nobody may legally use it, and the directory refuses it.
2. **Install needs a local clone.** The README uses `claude plugin marketplace add /path/to/sub-human`. It should use the GitHub form.
3. **No root README.** GitHub's landing page shows nothing useful. The README that does exist (`plugin/sub-human/README.md`, about 430 lines) puts about 140 lines of SSH, handoff and promote before basic use.
4. **The first run gives no feedback.** A successful join prints nothing, and a room with one person in it shows nothing.

**Not true any more** (the docs say mods are on by default from 2.1.287):
- "Function hooks" are now called **mods**, and users don't have to turn anything on.
- Our README wording "with function hooks on" makes it sound like a flag.
- `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` is ignored, so tell users to remove it.
- What actually turns mods off: `disableAllHooks`, safe mode, `--bare`, `allowManagedHooksOnly` and `allowManagedModsOnly`, and an untrusted folder.

## R0: Make it installable (blockers; about 1 day)
- [ ] Add a LICENSE (MIT recommended), and add `license`, `homepage` and `repository` to plugin.json.
- [ ] Add a root `README.md`. Fix the marketplace.json description, which still says "on one machine".
- [ ] Change the install instructions to:
  - `/plugin marketplace add tatimblin/sub-human`, then `/plugin install sub-human@sub-human`;
  - or, in one step, `claude plugin install sub-human --marketplace tatimblin/sub-human` (needs 2.1.292, our floor anyway).
- [ ] Release discipline:
  - Make `CHANGELOG.md` the single record of what changed.
  - Tag with `claude plugin tag --push`, which gives `sub-human--v0.5.0`.
  - Put the version policy in CONTRIBUTING: every plugin change bumps `version` (check-version.js already enforces this), and each release states the Claude Code range it was tested on.
- [ ] Remove `.DS_Store` files. Check the directory limits (under 512 files, no non-image file over 256 KiB) so the submission doesn't get held for human review.
- [ ] Make the repo public. **Your decision.**

## R1: The first five minutes (about 1 week)
- [ ] **README order**:
  1. one sentence on what it is;
  2. a GIF of two terminals side by side, one person typing `@room` and the other seeing it, then a proposal opening as a plan card;
  3. a 3-line quick start;
  4. "you'll know it worked when…";
  5. links out.
  - Move remote hosting and handoff to `docs/REMOTE.md`, the threat model to `SECURITY.md`, and the troubleshooting table to `docs/TROUBLESHOOTING.md`.
- [ ] **Confirm a join on screen**: a one-line systemMessage such as `sub-human: alice joined vole-1234 · 1 here · @room to talk`.
- [ ] **`/sub-human doctor` inside Claude Code**, through the same hidden-block expansion as join, read only; `--fix` stays outside Claude Code. Today users must find the plugin root by hand to run doctor.
- [ ] **Split the join refusal by cause.** The single message at `hooks/join.js:68` should become five:
  - Claude Code too old;
  - mods not loaded (safe mode, `--bare`, `disableAllHooks`);
  - a managed policy (`allowManagedHooksOnly` or `allowManagedModsOnly`);
  - `node` missing or below 24;
  - folder not trusted.

  Each one names the fix and ends with "run /sub-human doctor".
- [ ] **New doctor checks:**
  - workspace trust;
  - `allowManagedHooksOnly` and `allowManagedModsOnly`;
  - a user `subagentStatusLine` that hides ours;
  - a leftover `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS`.
- [ ] **A solo demo.** `/sub-human try` opens a room with a scripted second member (a local bot seat), so one person sees posts, rows and a proposal card without a second terminal. This is the "it works" moment that Superpowers gets from one prompt.
- [ ] **Glossary, and fewer user-facing terms.**
  - Readers meet `orch`, seat, row, lane, link, `sh2` and `shk1` early.
  - Keep "room", "member" and "invite".
  - Say "coordinator" for the orch in user-facing text.
  - Never show `sh2`/`shk1` without explaining them.
- [ ] **Cost note.** The orch is a background Claude on the host's account. Say what it does and when it is idle.
- [ ] **Hide the `/exit` background-work prompt.** Every `/exit` asks a 3-choice question about background work; either suppress it or document it in one line.

## R2: Trust bundle (about 3 days, can run alongside R1)
- [ ] **`SECURITY.md`**: a disclosure address and the threat model, moved out of the README. Cover what a leaked invite gets you, what a host can and can't do, what Tailscale or Funnel can see, and why the developer can never read messages.
- [ ] **Hooks list**: name every hook and mod entry, what it touches and why. Security reviewers now read hooks first; see the PromptArmor and SentinelOne marketplace-hijack write-ups.
- [ ] **No-telemetry statement**: the only network code is the transports the user starts.
- [ ] **Badges**: CI and license. Add release attestations, either GitHub artifact attestation or a checksum on each tag, and tell users to pin a tag (`owner/repo#sub-human--v0.5.0`) if they want no silent changes.
- [ ] **Safer defaults to look at**:
  - an upterm-style `--authorized-user github:alice` that admits a joiner whose key matches their GitHub keys, with no `admit` round trip;
  - a read-only seat.

  These are candidate features, not blockers.

## R3: Survive Claude Code updates (about 1 week)
`lib/cc.js` lists 72 Claude Code behaviours we depend on, 38 of them incidental. Today a Claude Code update that changes one of them shows up as silent misbehaviour.
- [ ] **CI job against the latest Claude Code**: install the latest release and run `npm run probe` plus `test:mods`. Run it nightly on a schedule, so we break before users do. Today CI never installs Claude Code, so the mods tests skip.
- [ ] **On join, warn once** when the Claude Code version is newer than the last version we tested and the cheap probe fails. The warning says which feature may not work and points to doctor.
- [ ] **Tested range**: publish it in README and CHANGELOG.

## R4: Get it listed and launch
In this order:
1. **Our own marketplace.** Works the day R0 lands.
2. **Anthropic's directory.** Submit at claude.ai/directory/manage (plugin bundle; needs a paid plan and a public repo). An approved plugin installs as `@synced` and also appears in the `claude-community` marketplace.
   - The default marketplace is the biggest lever: listed plugins see 250k+ installs whatever their star count.
   - Review takes an unknown time, so submit as soon as R0 and R2 are done.
3. **awesome-claude-code.** Submit through its web issue form; a human must file it. The repo must be 14+ days old with ongoing commits, or have 100+ stars.
4. **Show HN.** "Show HN: sub-human, a shared room for several people's Claude Code sessions", with the GIF and the "the model can never speak or consent for you" claim up front. sshx is the template.
5. **r/ClaudeAI and X**: a 30–60 second side-by-side clip.

Aggregators (claudemarketplaces.com, claude-plugins.dev) seem to crawl GitHub; that is not confirmed.

## Release cut: v0.5.0 "public preview"
- **Included:** R0, R1, R2, and the R3 CI job.
- **Tested on:** macOS and Linux, Claude Code 2.1.292 up to the latest, Node 24 and 26.
- **Call it a preview, with known limits**:
  - no phone client under Bedrock or Vertex;
  - an SSH handoff needs per-member invites;
  - typed join commands are kept in `~/.claude/history.jsonl` (rotate PINs, which are single use);
  - no Windows;
  - no relay (1.2).
- **1.0** once the directory listing is live and two weeks pass with no internals breakage.

## Decisions for you
1. Make the repo public, under MIT? (recommended)
2. Submit to Anthropic's directory? It needs your paid plan, and it publishes the plugin under your name.
3. Build `/sub-human try` (the solo demo with a bot seat)? It is the biggest onboarding win and about 2–3 days of work.
4. Rename "orch" to "coordinator" in user-facing text?
