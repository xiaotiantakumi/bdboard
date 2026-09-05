# Git Workflow の詳細 (multi-session: per-ticket worktree + branch + PR)

AGENTS.md「Git Workflow」に骨格（ブランチ/worktree 命名、lifecycle、direct-to-main 禁止、
`.beads/` 不可触、dolt push 先、close タイミング）がある。**この文書はその根拠と手順の詳細**。
読むタイミング:

- PR を開く / マージする直前（`npm run drift`・merge serialization・cleanup の手順）
- `bd dolt push` / `bd dolt pull` を打つ前（remote 事故の詳細）
- 上記の規律が「なぜ」そうなのかを確認したいとき

汎用の worktree+PR 規律は skill `bdboard-harness` の `references/worktree-pr-flow.md` が正。
**この文書は bdboard 固有の値（remote 名 `legacy`、merge-slot bead 名、worktree パス、
実際に起きた事故）だけを持つ**。両者が食い違ったら、固有値はこの文書、規律はパックが正。

## 由来

Since 2026-08-15 this repo is pushed to GitHub (private:
https://github.com/xiaotiantakumi/bdboard) and uses a per-ticket worktree +
branch + PR flow instead of direct-to-main commits, specifically to avoid
silent conflicts when multiple sessions/agents work on the project
concurrently. Design rationale and full detail: bdboard-3tw.74.

## worktree

`.claude/worktrees/<ticket-id>/`, created at claim time from
`origin/main`, removed after merge. Each worktree needs its own
`npm install && npm --prefix web install` (`node_modules` isn't shared
across worktrees). Don't run `npm run dev` inside a worktree — it collides
on the port with the main checkout. `vitest`/`tsc`/`depcruise` don't bind a
port, so those run fine in parallel worktrees.

ブランチ: `bd/<ticket-id>` (ticket ID used verbatim, e.g.
`bd/bdboard-3tw.65` — dots are legal in git ref names). Non-ticket
exploratory branches use `spike/` and never get a PR.

## Direct-to-main の禁止と 2 つの例外

**Direct-to-main commits are banned**, with exactly two exceptions:
`chore(beads): ...` commits that touch only `.beads/` (routine
`interactions.jsonl` sync), and CI-recovery commits touching only
`.github/workflows/`. Even a one-line fix goes through a PR — the
consistency is what makes "main is always PR-gated" a reliable invariant
for concurrent sessions.

**`.beads/` is never touched inside a PR branch.** CI has a guard step
that fails any PR whose diff against `origin/main` touches `.beads/`.
Tracked `.beads/` files (`.gitignore`, `README.md`, `config.yaml`,
`hooks/*`, `interactions.jsonl`, `metadata.json`) only change via the
`chore(beads)` main-direct exception above.

## Drift check (`npm run drift`)

`npm run drift` has two comparisons. Its main comparison prints the files that **both**
`origin/main` and your branch have touched since their merge-base, and tells
you to rebase now if there are any. It also lists overlap with each eligible
open peer PR so that a human can choose the merge order. Run it when you open
the PR, and again whenever the PR has been open for more than a few hours —
including right before you take the merge slot.

This exists because merge-slot and CAS do not cover it. Both guard the
*instant* of merging (did `main` move while CI ran?); neither sees the
changes that pile up on `main` during the hours a PR is open. bdboard-3tw.152
is the incident: [PR #86](https://github.com/xiaotiantakumi/bdboard/pull/86)
opened at 17:01 and merged the next day, and in one five-hour window that
morning five unrelated PRs landed on `main` touching the same
`StatusPill.tsx` and `index.css`. The final rebase hit real text conflicts.
Running `npm run drift` that morning would have named both files.

It fetches `origin/main` and eligible peer branches first (a drift check
against stale remotes is worthless); `npm run drift -- --no-fetch` skips both
fetches when offline. For each peer, level 1 reports actual merge-tree text
conflicts in files you changed; when merge-tree reports a conflict outside those
files, the report does not assume a cause: the path may have shifted because of
a peer-side rename (a real conflict with this branch), or the peer may itself be
stale relative to `origin/main` (unrelated to this branch), so inspect the
reported paths. Level 2 reports shared files when there is no text conflict,
because semantic conflicts still need human
judgement. This was the gap exposed by PR #393 and PR #396: both changed the
same line in `web/src/index.css`, while neither overlapped changes already on
`origin/main`, so the old check was green for both.

It **never exits non-zero for a finding** and never blocks — overlapping files
are an upper bound on where a conflict could occur, not a prediction that one
will (separate hunks in the same file rebase cleanly). Making it a gate would
produce false stops and get it ignored. It **does** exit 2 when the main check
could not run at all (no `origin`, no merge-base). Peer discovery and fetch
failures are non-fatal, but are reported with their reason on stdout too, so
"nothing to report" and "could not look" never read the same to a caller that
only reads stdout. If no peer can be compared, it says so rather than claiming
there are no overlaps.

It compares **committed** changes only, so run it after you commit, not
mid-edit — uncommitted work in your tree is invisible to it.

There is deliberately **no hand-maintained "hot file" list**. Which files
are hot changes week to week, and a list in this document would go stale;
computing it from the merge-base is always current.

## Merge serialization

merge one PR at a time. Whoever holds merge
rights updates/rebases the next queued PR's branch and re-waits for CI
before merging it — this is what catches semantic conflicts between two
PRs that each pass CI independently but break when combined.

Concurrent sessions have made this concrete, so the procedure is now
spelled out rather than left to judgement. Run these in order for every
merge:

0. **Check for drift** — `npm run drift`. Rebase for main-branch drift; use
   peer-overlap reports to choose a merge order, then re-run CI before taking
   the slot. Taking it first just makes peers wait while you rebase.
1. **Take the slot** — `bd merge-slot acquire` (the `bdboard-merge-slot`
   bead already exists; `bd merge-slot create` is a one-time setup that has
   been done). Release it with `bd merge-slot release` when the merge is
   finished, including when you abandon the attempt. This is a
   *cooperative* lock: it coordinates every session that reads bd, and
   nothing else.
2. **Compare-and-swap immediately before merging** — after CI is green and
   right before `gh pr merge`, run `git ls-remote origin main` and compare
   it with the SHA the branch was rebased onto. If it moved, a peer merged
   while CI was running: update the branch and wait for CI again. **This
   step needs no cooperation from anyone, so it is the one that actually
   holds** — it shrinks the race window from "the length of a CI run" to a
   couple of seconds.
3. **Verify on main, and treat that as the gate for the next merge** —
   `git pull --ff-only`, then run `npm run verify` on `main` itself. Two
   branches that were independently green can still break in combination,
   and this is the only place that shows up. Do not merge the next queued
   PR until main is green. Merges are squashed, so recovery is a single
   revert.

Steps 1 and 3 are conventions other sessions must also follow; step 2
protects you regardless of what they do. Step 0 protects only you, but it
is the only one that catches a conflict *before* it has cost you a CI run.

## Cleanup after merge

(the merging session's responsibility):
`git worktree remove .claude/worktrees/<id>` → `git branch -d bd/<id>` →
`git remote prune origin` → restart the always-on server per skill
`bdboard-server-ops` (pull --ff-only / build:web / restart). At session start,
sweep `git worktree list` for merged leftovers left behind by a prior
session.

Two things to expect here, so they are not mistaken for failures:

- **`--delete-branch` always fails on the local branch**, with
  `cannot delete branch 'bd/<id>' used by worktree at …`. The remote
  branch *is* deleted; the local one can only go after the worktree does.
  This is the normal path, not an error — remove the worktree, then
  `git branch -D bd/<id>`.
- **Check for live processes before removing a worktree**:
  `lsof -a -d cwd +D "$(pwd)/.claude/worktrees/<id>"`. A concurrent session
  may be sitting in it; if anything is listed, leave the worktree alone.
  Removing a worktree out from under a running shell is what caused
  bdboard-3tw.61 (a shell whose `$PWD` fell back to `"."` spun a CPU core
  for 102 minutes).

## `.beads/` Dolt sync

> **Architecture in one line:** Issues live in a local Dolt database
> (`.beads/dolt/`); cross-machine sync uses `bd dolt push/pull` (a
> git-compatible protocol), stored under `refs/dolt/data` on your git
> remote — separate from `refs/heads/*` where your code lives.
> `.beads/issues.jsonl` is a passive export, not the wire protocol.
>
> See [SYNC_CONCEPTS.md](https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md)
> for the one-screen overview and anti-patterns (don't treat JSONL as the
> source of truth; don't `bd import` during normal operation; don't
> reach for third-party Dolt hosting before trying the default).

(separate from the above): `bd dolt push`/`bd dolt
pull` sync issue history to `refs/dolt/data` on a git remote — fully
independent of code branches/PRs, invisible in any diff. **This repo has
two git remotes**: `origin` (public, `xiaotiantakumi/bdboard`) and
`legacy` (private, `xiaotiantakumi/bdboard-legacy-private`). Issue
history is private and must go to `legacy` only — see bdboard-23v for why.
**Always run `bd dolt push --remote legacy` / `bd dolt pull --remote
legacy`. Never run a bare `bd dolt push` or `bd dolt pull` on this repo.**
A bare push can silently push to (or adopt) a Dolt-layer remote derived
from `git origin` — i.e. the public repo — leaking private issue history;
`bd dolt push --help` documents this remote-adoption behavior. This is not
hypothetical: on 2026-08-17 (bdboard-jb1) the main checkout itself still
had a Dolt-layer `origin` remote pointing at the public repo, even though
`.beads/config.yaml`'s `sync.remote` had already been commented out
(bdboard-23v) — disabling that app-level default did not remove the
Dolt-layer remote already registered underneath it. Before ever running a
bare `bd dolt push`/`bd dolt pull` on **any** checkout of this repo
(including a freshly-cloned one right after `bd init`), run `bd dolt
remote list` and confirm it shows no `origin` entry — if it does, remove
it with `bd dolt remote remove origin` first. Push periodically at
session end, not per-ticket.

## ブランチ保護

`main` は GitHub の **repository ruleset `protect-main`** (2026-09-05、bdboard-nmnj) で
保護している。リポジトリが public になったので Free プランでも ruleset が使える
(それ以前は「Free の private repo では強制できない」として規約 + CI + `gh pr merge` だけで
運用していた)。内容は上の運用規約をそのまま機械で固定したもの:

- **PR 経由必須** (`pull_request`、approvals 0 — ソロ開発)。マージ方式は **squash のみ**
  (`gh pr merge --squash` に揃える)。
- **required status checks** = `verify` / `e2e` / `commit-parse` (GitHub Actions 発のもの
  だけを認める)。`verify-windows` は `continue-on-error` のまま必須化しない (判断は
  bdboard-51qb)。GitGuardian は外部 app なので必須にしない。**strict (up-to-date 必須) は
  off** — main が動いたときの追従は上の drift + merge-slot + CAS の運用に任せ、PR ごとの
  rebase → CI 再走を強制しない。
- **force push 禁止** (`non_fast_forward`)、**ブランチ削除禁止** (`deletion`)。
- **bypass = Repository admin (always)**。オーナーだけが例外 2 件
  (`chore(beads)` と CI 復旧) を直接コミットできる。bypass は「規約上の例外を打てる」
  ためであって、通常の変更を main に直接 push してよい意味ではない。

確認・変更は API から:

```bash
gh api repos/xiaotiantakumi/bdboard/rules/branches/main --jq '.[].type'   # 効いている rule
gh api repos/xiaotiantakumi/bdboard/rulesets                             # ruleset 一覧 (id を取る)
gh api -X PUT repos/xiaotiantakumi/bdboard/rulesets/<id> --input ruleset.json
```

required checks の **名前はジョブ名と一致していなければならない**。ci.yml のジョブ名を
変えるときは ruleset 側も同じ PR の流れで更新すること (名前がずれると、その check が
永遠に「待ち」のままマージできなくなる — bypass で押し通すのは規約違反)。
