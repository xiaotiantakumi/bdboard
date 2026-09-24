# Git Workflow の詳細 (multi-session: per-ticket worktree + branch + PR)

AGENTS.md「Git Workflow」に骨格（ブランチ/worktree 命名、lifecycle、direct-to-main 禁止、
`.beads/` 不可触、Dolt remote の明示、close タイミング）がある。**この文書はその根拠と手順の詳細**。
読むタイミング:

- PR を開く / マージする直前（`npm run drift`・merge serialization・cleanup の手順）
- `bd dolt push` / `bd dolt pull` を打つ前（remote 事故の詳細）
- 上記の規律が「なぜ」そうなのかを確認したいとき
- セッション開始時（`npm run check:gh-issues` で bd 未紐付けの GitHub issue を確認）

汎用の worktree+PR 規律は skill `bdboard-harness` の `references/worktree-pr-flow.md` が正。
**この文書は bdboard 固有の値（merge-slot bead 名、worktree パス、実際に起きた事故）だけを
持つ**。両者が食い違ったら、固有値はこの文書、規律はパックが正。

## 由来

Since 2026-08-15 this repo is pushed to GitHub (public:
https://github.com/xiaotiantakumi/bdboard) and uses a per-ticket worktree +
branch + PR flow instead of direct-to-main commits, specifically to avoid
silent conflicts when multiple sessions/agents work on the project
concurrently. Design rationale and full detail: bdboard-3tw.74.

## worktree

`.claude/worktrees/<ticket-id>/`, created at claim time from
`origin/main`, removed after merge. Each worktree needs its own
`npm install && npm --prefix web install` (`node_modules` isn't shared
across worktrees). Use npm 10 (the one bundled with Node 22) so
`npm install` doesn't rewrite the committed lockfiles (see docs/VERIFY.md,
"lockfile と npm の版"). Don't run `npm run dev` inside a worktree — it collides
on the port with the main checkout. `vitest`/`tsc`/`depcruise` don't bind a
port, so those run fine in parallel worktrees.

ブランチ: `bd/<ticket-id>` (ticket ID used verbatim, e.g.
`bd/bdboard-3tw.65` — dots are legal in git ref names). Non-ticket
exploratory branches use `spike/` and never get a PR.

## bd チケット title の命名規約

チケット title に `[bug]` 等の type 接頭辞を付けない。`type=bug` は `bd` CLI 側で既に
`bd show` の見出し行で `[BUG] ·`、`bd list` で `[bug]` として title の前に描画されるため、
title 側にも書くと `[BUG] · [bug] …` のように二重表示になる。既存チケットに接頭辞付きの
ものが残っていることがあるが、命名慣習をそれらの既存 title から推測すると再発する
（実例: bdboard-wdwa・bdboard-nzul で2回発生し、いずれも `bd update --title` で接頭辞を
除去した）。書式は **`<領域>: <症状/要約>`**（type の情報は `--type` フィールドに持たせる。
title には書かない）。

## GitHub issue linking (`npm run check:gh-issues`)

At session start, run `npm run check:gh-issues`. It lists open GitHub issues
that are not linked from any bd ticket with `--external-ref gh-<number>`
(an external_ref of `https://github.com/<owner>/<repo>/issues/<number>` also
counts; any other form is reported as unlinked). Tickets of every status count,
including closed ones.
The check is read-only, uses the GitHub REST API only, and remains advisory:
it exits 0 even when `gh` is unavailable or cannot authenticate.

GitHub issue（別端末・別アカウントから起票されることもある）は bd チケット化して対応する:

1. **紐付け**: `bd create ... --external-ref gh-<番号>`（新規チケット時）または
   `bd update <id> --external-ref gh-<番号>`（既存チケットへ後付け）で、少なくとも1件の
   bd チケットから GitHub issue を紐付ける（上の check スクリプトが認識する形式は
   `gh-<番号>` または `https://github.com/<owner>/<repo>/issues/<番号>`）。
2. **進捗コメント**: 起票（bd チケット化した時点）・着手・PR 作成・マージ・close の節目ごとに、
   紐付けた GitHub issue 側にもコメントで進捗を書く。対応が完了したら issue を閉じる。
3. **判断が残る場合**: 対応方針の判断がまだ残っている（要確認・要議論）なら issue を閉じず、
   その旨をコメントに書いて次のセッションに引き継ぐ。
4. **公開リポジトリの注意**: このリポジトリは public なので、issue コメントに内部パス・
   端末固有の設定・非公開の運用履歴やシークレットを書かない。

## Direct-to-main の禁止とその唯一の例外

**Direct-to-main commits are banned**, with exactly one exception:
CI-recovery commits touching only `.github/workflows/`. Even a one-line
fix goes through a PR — the consistency is what makes "main is always
PR-gated" a reliable invariant for concurrent sessions.

**This repo does not track `.beads/` in git** (see root `.gitignore`) —
it is local to the maintainer's own environment. **`.beads/` is never
touched inside a PR branch.** CI has a guard step that fails any PR whose
diff against `origin/main` touches `.beads/`.

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
against stale remotes is worthless, and both fetches use `--prune` so a peer
branch deleted between `gh pr list` and the fetch does not leave a stale
`origin/<peer>` behind that keeps getting compared as if it were still alive);
`npm run drift -- --no-fetch` skips both fetches when offline. The peer-branch
fetch is a single refspec-less `git fetch origin`, not a fetch of the specific
branches it plans to compare: an earlier version listed the target branches
explicitly, and a single deleted branch in that list failed the whole fetch
(exit 128), so **no** peer got updated, not just the deleted one.

For each peer it also checks, with `git merge-base --is-ancestor`, whether
this branch and the peer are themselves each caught up with `origin/main`.
Only when **both** are caught up does level 1 assert a merge-tree text
conflict outright ("… と衝突します"); the same is true for a conflict outside
the files you changed (the peer-rename-vs-stale-peer case below). Otherwise
it softens to "… と衝突する可能性があります" and names a cause instead of
asserting one:

- If **this branch** is the one that is behind `origin/main`, the report
  cannot rule out that the conflict is really this branch's own unrebased
  drift showing up against a peer that has nothing to do with it, so it says
  so and tells you to rebase and rerun rather than pointing at the peer —
  even if the peer also happens to be behind.
- If this branch is caught up but the **peer** is behind, the conflict is
  attributed to the peer's own stale base, which is expected to clear once
  the peer rebases.

When merge-tree reports a conflict outside the files you changed, the same
priority applies: if this branch is behind, the cause is left unresolved
(cannot isolate it to the peer); otherwise the path may have shifted because
of a peer-side rename (a real conflict with this branch) or the peer itself
may be stale relative to `origin/main` (unrelated to this branch) — inspect
the reported paths either way. Level 2 reports shared files when there is no
text conflict, because semantic conflicts still need human judgement. This
was the gap exposed by PR #393 and PR #396: both changed the same line in
`web/src/index.css`, while neither overlapped changes already on
`origin/main`, so the old check was green for both.

Two more qualifiers can show up in the output. `(古い ref で比較)` is appended
to the conclusion line when the peer-branch fetch above failed and the
comparison fell back to whatever remote-tracking refs were already on disk —
including the "no comparable open PR" line, so a stale-ref comparison is
never reported the same way as a genuinely clean one. And when `git
merge-tree` itself cannot run for a peer (an old git, unrelated histories,
etc.), the check falls back to comparing changed file lists alone for that
peer and says so ("merge-tree が使えないため … はファイル単位でのみ比較しました")
rather than silently asserting no conflict — that peer is also excluded from
the "N 件との重なりはありません" count, since a file-list-only comparison
never actually reached a text-conflict verdict.

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
merge (this is **S0**, the procedure while `merge.mode` is `"S0"`; S1 follows):

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

Which procedure applies is decided by `merge.mode` in `.claude/bdboard-harness.json`
**as it is on `origin/main`** (bdboard-ulxa): `S0` = the steps above (the default),
`S1` = the steps below. Switching and rolling back are one-line edits of that key,
landed through a normal PR; agents dispatched after the switch use the new steps.

### S1 — hold the slot only for the CAS and the merge (`merge.mode: "S1"`)

Measured on 2026-09-23 (bdboard-iaqg): with S0 the slot was held 7.6 of 11 hours
(≈70%), because the rebase → CI (5–9 min) → CAS retry loop and the post-merge
verify all ran inside it; merges were ≈12 minutes apart. S1 moves everything except
`acquire → git ls-remote → gh pr merge → release` out of the slot (design:
bdboard-ulxa §2 A; S2/S3 — verifying a predicted landed tree instead of rebasing —
are bdboard-ulxa.2 and later). From the PR worktree:

```bash
npm run merge-pr -- prepare <N>   # outside the slot: PR open, local HEAD == PR head,
                                  # required checks green, origin/main is an ancestor of HEAD
                                  # → records PRED_BASE (= origin/main) in .git/bdboard-merge/pr-<N>.json
npm run merge-pr -- gate <N>      # layer 3: bdboard/landed-verify on PRED_BASE must be success
                                  # → bd merge-slot acquire --holder "<id> / PR#<N>" → ls-remote == PRED_BASE
                                  # → prints ONE line on stdout and exits holding the slot
gh pr merge <N> --squash --delete-branch --match-head-commit <head> --subject '<title> (#<N>)'
npm run merge-pr -- finish <N>    # always, merged or not: release → (if merged) detach-checkout the
                                  # landed SHA in this worktree → npm run verify → commit status
```

- **Exit codes**: `3` main moved (class R) → `git rebase origin/main` (or `git merge origin/main`)
  → push → wait for CI → `prepare` again. `75` start over from `prepare` (CAS lost, main moved
  while waiting, slot not free within `merge.slotWaitMinutes`, CI pending). `4` / `6` main is
  broken → below. `5` finish found the PR unmerged and returned the slot.
- **The merge line is printed, not run by the script** (decision 4 of bdboard-ulxa §6): if the
  permission classifier refuses `gh pr merge`, running it from inside a script would be a
  bypass. Refused → do not retry, run `finish` (it returns the slot), then the human gate
  (ticket-flow). `--match-head-commit` makes GitHub reject the merge (409) if someone pushed to
  the branch after `prepare`; that also ends in `finish` + `prepare`.
- **Layer 3 ledger** = GitHub commit status `bdboard/landed-verify` on each main SHA
  (`gh api repos/xiaotiantakumi/bdboard/commits/<sha>/status`). `finish` posts `pending`, runs the
  contract's `verify` on the landed tree in the PR worktree (`git checkout --detach <sha>`; `npm ci`
  first if a lockfile differs from what that worktree last installed), posts `success` / `failure`,
  and checks the branch out again. It never touches the main checkout, so hook rule 7 does not
  apply. The verify log is `.git/bdboard-merge/landed-verify-<sha>.log`.
- **The next merger's gate** reads that ledger for its PRED_BASE: `success` → go on; `failure` →
  do not merge; `pending` / none → wait (30 s polls) until `merge.leaseMinutes` (8) after the last
  update (or the commit time), then verify that SHA itself and post the result (self-heal —
  also covers SHAs merged under S0, which never write the ledger). Two self-healers at once just
  verify the same tree twice.
- **Never release someone else's slot.** If it stays held past `merge.slotWaitMinutes` (10),
  `gate` exits 75 and the agent reports the holder to the chair. A holder equal to
  `<id> / PR#<N>` (this PR's own interrupted gate) is taken over.
- Audit trail for occupancy (acquire → release seconds, CAS losses, self-heals):
  `${TMPDIR}/bdboard-merge-audit.log` (`BDBOARD_MERGE_AUDIT_LOG` overrides).
- If the PR worktree predates `scripts/merge-pr`, `git merge origin/main` first (it is class R
  anyway once main has moved).
- The chair deploys to the always-on server as before (see "Cleanup after merge"),
  preferably once the tip's `bdboard/landed-verify` is `success`.

### When main is broken (S0 and S1)

Detected by a `failure` in `bdboard/landed-verify`, a red `verify` / `e2e` in main's push CI
(`commit-parse` is not used as a gate), or a gate exiting 4. Squash merges make recovery one
revert:

1. The detector takes the slot and keeps it until main is green again — the only long hold in S1
   (`finish` does this itself when it records `failure`, holder `<id> / main-broken <sha>`).
2. `bd create --type bug -p 0 "main 破損: <sha> <failing step>"`, first lines of the log in a comment.
3. Find the last `success` and the first `failure` from the per-SHA statuses (CI runs on main are
   `cancel-in-progress`, so they can be missing; statuses are not).
4. Fix-forward only if it is a one-liner doable in ~10 minutes; otherwise revert:
   `git switch -c bd/<bug-id> origin/main && git revert --no-edit <breaking squash sha>` (no `-m`
   needed: it is a squash) → PR → CI → merge (S1: prepare / gate / finish).
5. Once the fix's landed-verify is `success`, release the slot, reopen the ticket of the breaking
   PR with the reason, and add the case to failure-catalog.md.

Other mergers that see `failure` stop; they neither merge nor take the slot.

## Cleanup after merge

(the merging session's responsibility):
`git worktree remove .claude/worktrees/<id>` → `git branch -d bd/<id>` →
`git remote prune origin`. Restarting the always-on server is **not** part of
the cleanup a subagent does: the chair (top-level session) runs
`BDBOARD_SERVER_CALLER=chair scripts/always-on-server.sh deploy --expect-pid <pid>`
(pull --ff-only / build:web / restart; see skill `bdboard-server-ops`), and hook
rule 7 denies a subagent's main-checkout pull / start / kill (bdboard-hpu8). A
subagent that merged a PR just reports that a restart is needed. At session start,
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
> See [sync-concepts.md](https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md)
> for the one-screen overview of the wire format and what JSONL is (and
> isn't) for (don't treat JSONL as the source of truth; don't `bd import`
> during normal operation), and
> [architecture/dolt.md](https://github.com/gastownhall/beads/blob/main/docs/architecture/dolt.md)
> for embedded vs server mode, Dolt remotes, and corruption recovery
> (`bd doctor --deep` / `--fix`).
>
> **Caution:** several upstream defaults conflict with this repo's rules:
> `bd init` (and `bd bootstrap`, when it finds `refs/dolt/data` on git
> origin) wires git `origin` as the Dolt remote; the examples use bare
> `bd dolt push`/`pull`; and the Repair steps add `origin` as a Dolt remote
> and commit `sync.remote`. Do none of these here — see below.

`bd dolt push`/`bd dolt pull` sync issue history to `refs/dolt/data` on a git remote — fully
independent of code branches/PRs, invisible in any diff. `origin` is the
public code remote (`xiaotiantakumi/bdboard`) and must never be used as a
Dolt remote for issue history.
**Always pass `--remote <name>` explicitly. Never run a bare `bd dolt
push` or `bd dolt pull` on this repo.**
A bare push can silently push to (or adopt) a Dolt-layer remote derived
from `git origin` — i.e. the public repo — leaking issue history;
`bd dolt push --help` documents this remote-adoption behavior. This is not
hypothetical: on 2026-08-17 (bdboard-jb1) the main checkout itself still
had a Dolt-layer `origin` remote pointing at the public repo, even though
`.beads/config.yaml`'s `sync.remote` had already been commented out
(bdboard-23v) — disabling that app-level default did not remove the
Dolt-layer remote already registered underneath it. After `bd init` or
`bd bootstrap` on **any** checkout of this repo (including a freshly-cloned
one), and before any `bd dolt push`/`bd dolt pull` there, run `bd dolt
remote list` and confirm it shows no `origin` entry — if it does, remove
it with `bd dolt remote remove origin` first. In an environment that uses
a Dolt remote, push periodically at session end, not per-ticket.

**`bd import` silently defaults a missing `priority` field to 0 (P0, the highest lane).**
Out-of-range values (e.g. `9`) are rejected with `priority must be between 0 and 4` — same for
`bd create -p 5` / `bd update -p 7`, which reject with `invalid priority (expected 0-4 or
P0-P4)` — but an entirely *missing* `priority` field on import is not treated as an error; it is
silently filled in as `0` (confirmed on bd 1.2.1 while investigating bdboard-2czx / PR #305, in
an isolated scratch bd repo). This repo doesn't use `bd import` in normal operation (see the
anti-pattern note above), so there's no current exposure — but if you ever import from JSONL or
another tool for recovery, fill in `priority` explicitly on every row first, or imported issues
can land in the highest-priority lane indistinguishable from a real P0. This is a different failure
mode from bdboard's own `missing_priority` health check (removed in bdboard-2czx): that check could
never fire via the normal `bd` CLI path because `src/infrastructure/bd/bd-issue-schema.ts`'s
`priority` field is *required*, not merely 0–4-bounded — a bd-CLI row missing `priority` is dropped
whole at the mapper (`[schema-mismatch] ... priority: Required`) rather than reaching hygiene as a
missing-priority issue. `bd import`'s silent-zero-fill only matters for whatever downstream (JSONL,
other tools) reads the imported issue before it round-trips back through that same schema.

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
  rebase → CI 再走を強制しない。strict を on にすると main が動くたびに全 PR の
  update-branch + CI 再走が要り、S0 で枠の中にあった待ちを GitHub 側へ移すだけになる。
  「CI が見た木 = 着地する木」は S1 では PRED_BASE の CAS と着地後検証の台帳
  (`bdboard/landed-verify`) で担保する (bdboard-ulxa §3.3)。Merge queue は user-owned の
  private/public repo では使えない。
- **force push 禁止** (`non_fast_forward`)、**ブランチ削除禁止** (`deletion`)。
- **bypass = Repository admin (always)**。オーナーだけが唯一の例外 (CI 復旧) を直接
  コミットできる。bypass は「規約上の例外を打てる」ためであって、通常の変更を main に
  直接 push してよい意味ではない。

確認・変更は API から:

```bash
gh api repos/xiaotiantakumi/bdboard/rules/branches/main --jq '.[].type'   # 効いている rule
gh api repos/xiaotiantakumi/bdboard/rulesets                             # ruleset 一覧 (id を取る)
gh api -X PUT repos/xiaotiantakumi/bdboard/rulesets/<id> --input ruleset.json
```

required checks の **名前はジョブ名と一致していなければならない**。ci.yml のジョブ名を
変えるときは ruleset 側も同じ PR の流れで更新すること (名前がずれると、その check が
永遠に「待ち」のままマージできなくなる — bypass で押し通すのは規約違反)。
