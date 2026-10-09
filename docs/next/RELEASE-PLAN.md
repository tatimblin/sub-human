# sub-human release plan: a private beta, then a one-day public launch

Goal: a stranger goes from install to a working room in under 5 minutes, and a friend joins in one step. The repo stays private until the onboarding is proven and some testers vouch for it. Then everything goes public on the same day, so the first place people find the idea is this project, already polished, listed and in use.

Why this order: the realistic risk is a fast copy of the idea that is better distributed, not theft of the code. A private beta keeps the idea among invited people while onboarding gets fixed. The launch then claims every channel at once.

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

**Weak:**
- Install needs a local clone.
- There is no root README, and the plugin README (about 430 lines) puts about 140 lines of SSH, handoff and promote before basic use.
- A successful join prints nothing, and a room with one person in it shows nothing.
- doctor is hard to run from inside Claude Code.
- A single join refusal covers five different causes.
- CI never installs Claude Code, so a Claude Code update that breaks an internal reaches users unnoticed. The plugin depends on 72 internals.

**Not true any more:**
- "Function hooks" are now **mods**, on by default from 2.1.287; users don't have to turn anything on.
- `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` is ignored.
- What turns mods off: `disableAllHooks`, safe mode, `--bare`, `allowManagedHooksOnly` and `allowManagedModsOnly`, and an untrusted folder.

---

# Phase B: private beta (about 4 to 6 weeks)

## B0: A private install that works (about 1 day)
- [ ] **Install from the private repo**: `/plugin marketplace add tatimblin/sub-human`, then `/plugin install sub-human@sub-human`. Claude Code reads a private repo with the tester's own git credentials (`gh auth`, an SSH key or a credential helper). Background auto-update needs `GITHUB_TOKEN` in the tester's environment; without it they run `/plugin marketplace update sub-human`.
- [ ] **Check that a non-owner can install it**:
  - Use a second GitHub account with read access, on a clean machine or in a `CLAUDE_CONFIG_DIR` sandbox.
  - Install, join, update to a bumped version.
  - Note every prompt it raised.
- [ ] **Keep the marketplace's own name.** sub-human stays in its own `sub-human` marketplace and is not listed in `tatimblin-skills`; one install path only, so nobody ends up with the hooks running twice.
- [ ] **Root `README.md`, beta edition**:
  - what it is;
  - the private install above;
  - requirements;
  - how to report a problem;
  - a "beta, please don't share" note.
- [ ] **Fix the marketplace.json description**, which still says "on one machine".
- [ ] **Add `repository` and `homepage` to plugin.json.**
- [ ] **No LICENSE yet.** No license means all rights reserved: testers may use it but not redistribute it. The license is chosen at launch.
- [ ] **Release discipline**:
  - `CHANGELOG.md`;
  - tag each beta with `claude plugin tag --push` (`sub-human--v0.5.0-beta.N`);
  - bump `version` with every change (check-version.js already enforces this), or testers never get the change.
- [ ] **Push the CI fix (`1773b97`)** so CI is green before testers arrive.

## B1: Testers (recruit during B0)
- **Who:** 5 to 10 people, a mix of:
  - 2–3 coworkers on SSH dev boxes and Bedrock, which tests corporate networks and the no-phone limit;
  - 2–3 friends on Tailscale or Funnel;
  - 1–2 people new to Claude Code plugins, to test onboarding cold.
- **How:**
  - Add them as **read** collaborators on GitHub.
  - Send a short invite note: what it is, the install line, one task ("start a room with me and plan a small change together"), and that it's under wraps.
- **Feedback:**
  - private GitHub issues, using templates (bug: attach `doctor --bundle`; friction: "where did you get stuck?");
  - a short call with each tester after their first session, if possible;
  - watching a newcomer's first install live (screen share) is worth more than any survey.
- **What to measure, by hand, per tester:**
  - time from install to the first `@room` that someone else sees;
  - whether a friend joined without help;
  - the number of messages asking for help;
  - any problem where a cause wasn't shown on screen.

## B2: The first five minutes (about 1–2 weeks, start before testers and keep going)
- [ ] **README order**:
  1. one sentence;
  2. a GIF of two terminals, one typing `@room` and the other seeing it, then a proposal card;
  3. a 3-line quick start;
  4. "you'll know it worked when…";
  5. links out.

  Move remote hosting and handoff to `docs/REMOTE.md`, the threat model to `SECURITY.md`, and the troubleshooting table to `docs/TROUBLESHOOTING.md`.
- [ ] **Confirm a join on screen**: `sub-human: alice joined vole-1234 · 1 here · @room to talk`.
- [ ] **`/sub-human doctor`** inside Claude Code (read only, through the hidden-block expansion; `--fix` stays outside Claude Code).
- [ ] **Split the join refusal** at `hooks/join.js:68` by cause:
  - Claude Code too old;
  - mods not loaded;
  - a managed policy;
  - `node` missing or below 24;
  - folder not trusted.

  Each says its fix and ends with "run /sub-human doctor".
- [ ] **New doctor checks**:
  - workspace trust;
  - `allowManagedHooksOnly` and `allowManagedModsOnly`;
  - a user `subagentStatusLine` that hides ours;
  - a leftover `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS`.
- [ ] **`/sub-human try`**: a solo room with a scripted bot member, so one person sees posts, rows and a proposal card. About 2–3 days.
- [ ] **Plain words**: "the room" for the orch in user-facing text (see Decisions), a short glossary, and never `sh2`/`shk1` without a word of explanation.
- [ ] **A cost note**: the orch is a background Claude on the host's account. Say when it runs and when it is idle.
- [ ] **The `/exit` background-work prompt**: suppress it, or document it in one line.
- [ ] **Re-prioritise** after each tester's first session. Their findings beat this list.

## B3: Trust (about 3 days)
- [ ] **`SECURITY.md`**: a disclosure contact and the threat model. Cover:
  - what a leaked invite gets you;
  - what a host can and can't do;
  - what Tailscale or Funnel can see;
  - why the developer can never read messages.
- [ ] **Hooks list**: every hook and mod entry, what it touches and why.
- [ ] **A no-telemetry statement.**
- [ ] **CI badge.**

## B4: Survive Claude Code updates (about 1 week)
- [ ] **Nightly CI job**: install the latest Claude Code, then run `npm run probe` and `test:mods`.
- [ ] **Warn once on join** when Claude Code is newer than the last version we tested and the cheap probe fails. The warning names the feature at risk and points to doctor.
- [ ] **Publish the tested Claude Code range** in the README and CHANGELOG.

## Exit criteria (all must hold before launch)
- [ ] At least 3 testers who are new to sub-human got a room going without help. The median time from install to the first `@room` seen by another person is under 5 minutes.
- [ ] At least 2 friends joined across machines (SSH or Tailscale) without help.
- [ ] No open bug at the "lost a message" or "a model spoke for a person" level.
- [ ] Two weeks with no breakage from a Claude Code update, or any breakage caught by the nightly job first.
- [ ] At least 3 testers willing to say something publicly on launch day.
- [ ] The GIF and a 30–60 second side-by-side clip are recorded.

---

# Phase L: public launch (one day, prepared ahead)

**Prepare during the beta:**
- [ ] **Name**: check that no plugin called `sub-human` is listed in the directory or the aggregators. Take a domain and social handles if wanted.
- [ ] **License**: MIT (decided). Prepare `LICENSE` and the `license` field, and add them on launch day.
- [ ] **Anthropic directory**: find out whether a submission can be filed while the repo is private (the docs only say it must be public before the listing goes live). If so, submit at the end of the beta so the review lag overlaps the beta. The portal is claude.ai/directory/manage, choose "plugin bundle"; it needs a paid plan.
- [ ] **Directory checks**:
  - a README of at least 40 words;
  - no `.DS_Store`;
  - under 512 files, and no non-image file over 256 KiB, or the submission is held for review;
  - `privacyPolicyUrl` and `supportUrl` filled in.
- [ ] **Drafts**: the Show HN post ("Show HN: sub-human, a shared room for several people's Claude Code sessions"; lead with "the model can never speak or consent for you" and the GIF), plus r/ClaudeAI and X posts.

**Launch day:**
1. Make the repo public. Add the LICENSE and tag `sub-human--v0.5.0`.
2. Install it from a clean account to check it still works now that the repo is public.
3. Submit to the directory (if not already submitted), then post the Show HN, then r/ClaudeAI and X. Ask testers to try and comment.
4. Spend the day answering. Fix any onboarding failure the same day and release a new version.

**After launch:**
- Submit to awesome-claude-code through its web issue form once the repo has been public for 14 days or has 100+ stars.
- **1.0** once the directory listing is live and two weeks pass with no breakage from a Claude Code update.

## Known limits to state in the beta and at launch
- No phone client under Bedrock or Vertex.
- An SSH handoff needs per-member invites.
- Typed join commands are kept in `~/.claude/history.jsonl` (PINs are single use).
- No Windows.
- No relay (1.2).

## Decisions (2026-10-09)
1. **Build `/sub-human try` during the beta**, as part of B2.
2. **The orch is called "the room" in user-facing text.** It is the room acting: "the room is working on a plan", "the room's tasks". Internal names in code and logs don't change.
   - In B2, go through the rows, systemMessages, the README and the skill text.
   - Keep `@orch` working as an alias for addressing it, so existing habits don't break. Decide in B2 whether user-facing text should spell it `@room …` alone.
3. **License: MIT**, added on launch day.
