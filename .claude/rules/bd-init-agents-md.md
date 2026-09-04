---
paths:
  - "AGENTS.md"
  - "CLAUDE.md"
  - ".beads/**"
---

# `bd init` Re-runs: Reviewing the Managed AGENTS.md Block

このルールが適用されるのは `AGENTS.md` / `CLAUDE.md` / `.beads/**` を触るときだけ。
**`bd init` または `bd setup <tool>` をこの repo で走らせたら、staging/commit の前に
必ず下の「Required procedure」を実行する。**

`bd init` (and `bd setup <tool>`) regenerates the content **inside** the
`<!-- BEGIN BEADS INTEGRATION --> … <!-- END BEADS INTEGRATION -->` markers
(and the sibling `<!-- BEGIN BEADS CODEX SETUP --> … <!-- END BEADS CODEX
SETUP -->` block above) on every run; content outside the markers is left
alone. This bit this repo on 2026-08-17 (bdboard-ejz): a `bd init` run on a
separate machine silently dropped two project-specific customizations from
inside the block — `bd ready --exclude-label gt:slot` (the fix for the
merge-slot mis-claim incident, bdboard-9k3) reverted to plain `bd ready`, and
an unconfirmed `bd dolt push` line was added to the Session Completion
command list, contradicting AGENTS.md's "outward-facing/network operations
need confirmation first" stance elsewhere.

**Investigated:** `bd init --help` (bd 1.2.1, Homebrew) exposes flags that
target this regeneration directly: `--skip-agents` (skip AGENTS.md/tool-setup
generation entirely), `--agents-file <name>` (custom filename, default
`AGENTS.md`), `--agents-profile minimal|full`, and `--agents-template <path>`
(use a custom template instead of the embedded default for what gets written
inside the markers). `--agents-template` is the closest thing to an official
"keep my customizations" mechanism — point it at a repo-maintained template
file that already contains the `--exclude-label gt:slot` Quick Reference line
and no unconfirmed push command, and that becomes the regenerated block
content:

```bash
bd init --agents-template path/to/our-agents-template.md ...
```

**Caveat that keeps the manual review mandatory anyway:** `bd config --help`
enumerates every persisted config namespace (`export.*`, `import.*`,
`jira.*`, `linear.*`, `github.*`, `gitlab.*`, `ado.*`, `notion.*`,
`custom.*`, `status.*`, `claim.*`, `doctor.suppress.*`) — there is no
`agents.*` / `agents-template`-style key, so `.beads/config.yaml` cannot make
`--agents-template` "sticky." It only takes effect on the exact invocation
that passes it. Any other `bd init` (a different machine, a teammate, a CI
recovery script, a future `bd` upgrade, or simply forgetting the flag) falls
back to the embedded upstream default and can silently re-drop these
customizations again. Treat `--agents-template` as a nice-to-have that
reduces how often the checklist below finds a diff, not as a substitute for
running the checklist.

**Required procedure — every time `bd init` or `bd setup <tool>` runs against
this repo** (fresh clone, `bd` version upgrade, or any manual re-run),
**before** staging or committing:

```bash
git diff -- AGENTS.md   # and the --agents-file target, if different from AGENTS.md
```

Check specifically for:

1. **`bd ready --exclude-label gt:slot`** is still present in the Quick
   Reference blocks inside the managed blocks — losing it
   reopens the bdboard-9k3 merge-slot mis-claim failure mode.
2. **No unconfirmed push/sync command** (`bd dolt push`, `bd dolt push
   --remote legacy`, etc.) was added to the Session Completion / git-handling
   steps without a confirmation gate.

If either check fails, hand-restore the customized wording before
committing. Do not `git add`/commit an unreviewed `bd init` diff.

**Alignment with the direct-to-main ban:** `bd init` can autocommit straight
to whatever branch happens to be checked out — on 2026-08-17 it produced two
commits directly on `main` on a separate machine (bdboard-ejz), one
rewriting AGENTS.md and one adjusting `.beads/config.yaml`. The Git Workflow
section of AGENTS.md bans direct-to-main commits except `chore(beads): ...` commits
that touch **only** `.beads/`. A `bd init` commit that touches AGENTS.md (or
any other non-`.beads/` file) does not qualify for that exception even when a
sibling commit from the same `bd init` run is `.beads/`-only — each commit is
judged on its own diff. Practically:

- Never let `bd init` run with `main` checked out. Run it on a feature
  branch or inside a per-ticket worktree first, review the diff per the
  checklist above, then land it through the normal PR flow.
- If it already ran directly on `main` (as happened here) before push: keep
  or cherry-pick any commit that touches only `.beads/` through the existing
  `chore(beads)` exception, but re-route any commit touching AGENTS.md (or
  other non-`.beads/` files) through a normal `bd/<ticket-id>` branch + PR
  instead of pushing it straight — e.g. extract the diff with `git show
  <sha> -- AGENTS.md` and apply it on a fresh branch, or reset/revert the
  non-`.beads/` commit off `main` before it is ever pushed.
