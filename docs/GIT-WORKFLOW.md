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

`bdboard-worker` サブエージェント (bdboard-cm2q.3) は、この節で説明した通常の per-ticket
worktree ではなく、Claude Code 組み込みの `isolation: worktree` で動く一時 worktree の中で
実装する。ディレクトリ名も Claude Code が付ける任意の slug (`bd/<ticket-id>` 由来ではない)
なので、その worktree がどのチケットの作業かはディレクトリ名では分からない。
`.claude/agents/bdboard-worker.md` の手順1で作り直すブランチ `bd/<ticket-id>` の方で識別する。
merge-pr とマージ後の片付けは、`git worktree list --porcelain` の
`branch refs/heads/bd/<ticket-id>` で引いた worktree に対して行う。実測 (bdboard-cm2q.5、
議長が片付け、2026-09-26): この worktree は `locked` になっている — `lsof -a -d cwd +D <path>`
で使用中でないことを確かめてから `git worktree remove -f -f <path>` で消し、同時に
`worktree-agent-<id>` ブランチも `git branch -D` で消す。それ以外の文書への反映は H-8
(bdboard-cm2q.11) に任せる。

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
merge (this is **S0**, the procedure while `merge.mode` is `"S0"`; S1 and S2 follow):

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
`S1` / `S2` = the steps below. Switching and rolling back are one-line edits of that key,
landed through a normal PR; agents dispatched after the switch use the new steps.

### S1 — hold the slot only for the CAS and the merge (`merge.mode: "S1"`)

Measured on 2026-09-23 (bdboard-iaqg): with S0 the slot was held 7.6 of 11 hours
(≈70%), because the rebase → CI (5–9 min) → CAS retry loop and the post-merge
verify all ran inside it; merges were ≈12 minutes apart. S1 moves everything except
`acquire → git ls-remote → gh pr merge → release` out of the slot (design:
bdboard-ulxa §2 A; S2 — verifying a predicted landed tree instead of rebasing — is the
next subsection, S3 is bdboard-ulxa.3). From the PR worktree (a linked worktree made by
`git worktree add` — the landed verify refuses to run in the main checkout, because detaching it
would also replace the `web/dist` the always-on server serves):

```bash
npm run merge-pr -- prepare <N>   # outside the slot: PR open, local HEAD == PR head,
                                  # required checks green, origin/main is an ancestor of HEAD
                                  # → records PRED_BASE (= origin/main) in <git common dir>/bdboard-merge/pr-<N>.json
BDBOARD_MERGER=chair npm run -s merge-pr -- gate <N>   # layer 3: bdboard/landed-verify on PRED_BASE must be success
                                  # → bd merge-slot acquire --holder "<id> / PR#<N>" → ls-remote == PRED_BASE
                                  # → prints the merge line on stdout and exits holding the slot
gh pr merge <N> --squash --delete-branch --match-head-commit <head> --subject '<title> (#<N>)'
BDBOARD_MERGER=chair npm run merge-pr -- finish <N>    # always, merged or not: release first → (if merged) detach-checkout
                                  # the landed SHA in this worktree → npm run verify → commit status
```

(`-s` keeps npm's `> bdboard@… merge-pr` banner off stdout, so stdout is exactly the one
`gh pr merge …` line; everything else goes to stderr.)

- **Exit codes**: `2` precondition failed (no review record / ticket not found in bd); `7` caller is not the chair.
  `3` main moved (class R) → `git rebase origin/main` (or `git merge origin/main`)
  → push → wait for CI → `prepare` again. `75` start over from `prepare` (CAS lost, main moved
  while waiting, `ls-remote` failed, slot not free within `merge.slotWaitMinutes`, CI pending or
  the GitHub API unreachable). `4` / `6` main is broken → below. `5` finish found the PR unmerged
  (and returned the slot, except under `--repair`). `1` could not run at all (bd unusable, dirty
  worktree, run from the main checkout, `npm ci` failed, untracked files not `.gitignore`d by the
  tree about to be verified, …) — the message says what to fix; for a landed verify that could not
  run, fix it and run `npm run merge-pr -- verify <sha>`.
- **The merge line is printed, not run by the script** (decision 4 of bdboard-ulxa §6): if the
  permission classifier refuses `gh pr merge`, running it from inside a script would be a
  bypass. Refused → do not retry, run `finish` (it returns the slot), then the human gate
  (ticket-flow). `--match-head-commit` makes GitHub reject the merge (409) if someone pushed to
  the branch after `prepare`; that also ends in `finish` + `prepare`.
- **Layer 3 ledger** = GitHub commit status `bdboard/landed-verify` on each main SHA
  (`gh api repos/xiaotiantakumi/bdboard/commits/<sha>/status`). `finish` checks out the landed tree
  in the PR worktree (`git checkout --detach <sha>`; `npm ci` first if a lockfile differs from what
  that worktree last installed — a failing `npm ci` is reported, not recorded as `failure`), posts
  `pending`, runs the contract's `verify` while re-posting `pending` every `leaseMinutes / 3` (so a
  verify queued behind the machine-wide verify slots does not look abandoned), posts `success` /
  `failure`, and checks the branch out again. It never touches the main checkout, so hook rule 7
  does not apply. The verify log is `<git common dir>/bdboard-merge/landed-verify-<sha>.log`.
- **The next merger's gate** reads that ledger for its PRED_BASE: `success` → go on; `failure` →
  do not merge; `pending` / none → wait (30 s polls) until `merge.leaseMinutes` (8) after the last
  update (or the commit time), then verify that SHA itself and post the result (self-heal —
  also covers SHAs merged under S0, which never write the ledger). Two self-healers at once just
  verify the same tree twice.
- **Interrupting `finish` or `verify`** with SIGINT/SIGTERM (Ctrl-C, a Bash-tool timeout kill,
  session close) while the landed verify is running kills the verify's whole process group and
  checks the worktree back out to its original branch automatically (bdboard-2twf / bdboard-e8o1),
  the same guarantee S2's `prepare` class F documents below — this is not S2-specific, it applies
  to every call into the shared landed-verify code (`finish`, manual `verify`, and S2's predicted-
  tree verify). The message on the way out says exactly what to rerun (`finish <N>` or
  `verify <sha>`); nothing is posted to the ledger for an interrupted run, so re-running it is
  always safe. Only a SIGKILL (`kill -9`) or a crash can still leave the worktree detached, in
  which case `git checkout bd/<id>` and rerun. A contract whose `verify` is not `npm run verify`
  has no self-cleanup of its own descendants (`scripts/verify.mjs`'s leader mode is what folds
  `npm run verify`'s tsc/vitest workers), so the interrupt handler itself polls the process group
  until it is actually empty and resends `SIGKILL` while anything in it is still alive, instead of
  trusting the direct child's exit as a proxy for the whole tree being gone.
- **Never release someone else's slot.** If it stays held past `merge.slotWaitMinutes` (10),
  `gate` exits 75 and the agent reports the holder to the chair. A holder equal to
  `<id> / PR#<N>` (this PR's own interrupted gate) is taken over.
- Audit trail for occupancy (acquire → release seconds, CAS losses, self-heals):
  `${TMPDIR}/bdboard-merge-audit.log` (`BDBOARD_MERGE_AUDIT_LOG` overrides).
- If the PR worktree predates `scripts/merge-pr`, `git merge origin/main` first (it is class R
  anyway once main has moved).
- The chair deploys to the always-on server as before (see "Cleanup after merge"),
  preferably once the tip's `bdboard/landed-verify` is `success`.

### S2 — skip the rebase: verify the predicted landed tree (`merge.mode: "S2"`)

S2 is S1 plus bdboard-ulxa §2 B (bdboard-ulxa.2). The S1 trial (bdboard-ulxa.4, 20 merges, 0 exit
75, 0 broken main) showed that almost every `prepare` exit 3 was main simply moving ahead with no
conflict — each one cost a rebase, a push and a 5–9 minute CI rerun. Under S2, `prepare` classifies
the PR instead of always demanding a rebase when main has moved (design §2.3):

| Class | When | What `prepare` does |
|---|---|---|
| N | `origin/main` is an ancestor of the PR head (main did not move) | same as S1 — records PRED_BASE, no extra verify |
| R | main moved **and** (not exactly one merge-base / `git merge-tree` reports a text conflict or cannot run / main's changes and yours hit the same `merge.hotFiles` pattern / GitHub reports the PR `mergeable: false`) | exit 3, same as S1: rebase (or `git merge origin/main`) → push → CI → `prepare` |
| F | main moved, no conflict, no hot-file collision | builds the predicted landed tree with `git merge-tree --write-tree origin/main HEAD`, commits it locally (`git commit-tree`, parents PRED_BASE and the PR head — not pushed, no ref), detach-checks it out **in the PR worktree**, runs the contract's `verify`, checks the branch out again. Green → records PRED_BASE = origin/main and the predicted tree; red → exit 3 (demoted to R) |

`gate` and `finish` are the S1 ones. What makes "the tree we verified" equal "the tree that lands":
GitHub's squash commit is the 3-way merge of the PR head into the main it merges onto; `gate`'s CAS
(`ls-remote` == PRED_BASE, inside the slot) pins that main and `--match-head-commit` pins the head,
so the landed tree is `merge-tree(PRED_BASE, head)` — the one `prepare` verified — **as long as
GitHub's merge agrees with git's ort merge** (merge-tree runs with rename detection pinned to git's
defaults, `merge.renames=true` / `merge.directoryRenames=conflict`, so a merger's `~/.gitconfig` cannot
change the tree). `finish` measures that agreement: it compares the landed commit's tree with the
recorded one and prints / audits `predicted-tree … match=true|false|unknown`; a mismatch is reported
(to bdboard-ulxa.2), and the landed verify (layer 3, unchanged) still decides the ledger. If
`gh pr merge` answers 405 "not mergeable", GitHub sees a conflict ort did not: `finish` (returns the
slot), then rebase. File overlap is **not** a criterion (§3.2: overlap and merge-tree are textual; only
building / linting / testing the landed tree catches a semantic conflict) — it is only logged for S3.

- **Hot files** (`merge.hotFiles`, default in `scripts/merge-pr/hot-files.mjs`, a contract value
  replaces the whole list): each entry is one *kind*; R when main and the PR both touch the same kind
  (not only the same file): dependencies (`package.json` / `package-lock.json`, root and `web/`),
  `.github/workflows/**`, verify configs (`**/tsconfig*.json`, `.dependency-cruiser.*`,
  `scripts/verify*.mjs`, `vite.config.*`, `vitest.config.*`, the contract `.claude/bdboard-harness.json`),
  and the 8192-byte `SKILL.md` (canonical
  and injected copy). `eslint.config.mjs` and `scripts/file-size-baseline.json` are deliberately not
  hot (§6 decision 3): `lint` / `check:file-size` decide them on the predicted tree.
- **Exit codes** as in S1, plus: `3` also means "predicted tree failed `verify`" (a semantic conflict
  with main — read the log `<git common dir>/bdboard-merge/predicted-verify-pr<N>-<tree12>.log`; if it
  is a known flake such as bdboard-241s, `prepare` again, otherwise rebase and fix). `75` also means
  "main moved while the predicted tree was being verified" — the result could no longer be used, so
  since bdboard-ulxa.6 `prepare` does not wait for it: it reads the remote main with
  `git ls-remote` (not the fetched ref) every `BDBOARD_MERGE_POLL_MS` (30 s, asynchronously) while
  the verify queues or runs, and on a move kills the verify's
  process group, restores `bd/<id>` and exits 75 (audit `result=abandoned`, message "…途中でやめました").
  Just `prepare` again. `1` also covers a predicted verify that
  could not run (dirty worktree, `npm ci` failed). `4` also comes from `prepare` when PRED_BASE's
  ledger already says `failure` (class F would only verify on a broken main; a repair PR merges
  `origin/main` to become class N, then `gate --repair`). None of these touch the slot or the ledger,
  and the prepare record is removed before the predicted verify starts, so `gate` cannot run on a
  stale one (gate also re-checks head and PRED_BASE against any record it reads).
- `git merge-tree --write-tree` needs git ≥ 2.38; an older git makes every moved-main PR class R.
- `prepare` takes minutes under S2 class F (a full `npm run verify`, including the machine-wide
  verify-slot queue): run it in the foreground with a 600000 ms Bash timeout like `finish`.
- **Verify-slot priority (bdboard-ulxa.6).** The predicted verify queues with priority `merge` and the
  landed verifies (`finish`, gate self-heal, `merge-pr verify`) with `landed`, ahead of ordinary
  pre-PR verifies (`pr`), with a bounded wait for the lower tiers. A PR sent back by 75 keeps its
  place (up to 10 min of head start): `prepare` passes the time the PR first queued
  (`<git common dir>/bdboard-merge/pr-<N>-queue.json`, removed by `finish`). Details, the
  old/new-script compatibility and the simulation (`node scripts/verify-slot-sim.mjs`: at 7 parallel
  agents, wasted predicted runs per merge 3.4 → 1.2, worst-case redos 17 → 6) are in
  [VERIFY.md](VERIFY.md) "Verify slots". If it is
  interrupted with SIGINT/SIGTERM (Ctrl-C, a Bash-tool timeout kill, session close), the verify child
  process is killed and the worktree is restored to `bd/<id>` automatically (bdboard-2twf); only a
  SIGKILL (`kill -9`) or a crash can still leave it detached on the predicted commit, in which case
  `prepare` exits 2 and says `git checkout bd/<id>`.
- `prepare` refuses (exit 2) while this PR's record says it is gated and holds the slot — run
  `finish` first (applies to S1 too; otherwise the record `finish` needs to release the slot would be
  deleted).
- `npm run merge-pr -- prepare <N> --dry-run` prints the S2 class in every mode ("参考: merge.mode が
  S2 ならクラス=…") without verifying or writing anything — use it to preview S2 before switching.
- Switching: a one-line PR setting `merge.mode` to `"S2"` (rollback: back to `"S1"`). A `gate` that
  finds a class-F record while main says S1 sends the agent back to `prepare`. Branches cut before
  this script supported S2 reject `"S2"` as an unknown mode (exit 1): `git merge origin/main` first.
  Roll back to S1 after two reverts in a day, as soon as a landed verify fails on a PR whose
  predicted tree had passed (design §5 / §6 decision 7), or when `predicted-tree … match=false` shows
  up in the audit log (GitHub's merge and git's disagree — the guarantee above does not hold).

### When main is broken (S0, S1 and S2)

Detected by a `failure` in `bdboard/landed-verify`, a red `verify` / `e2e` in main's push CI
(`commit-parse` is not used as a gate), or a gate exiting 4. Squash merges make recovery one
revert:

1. The detector takes the slot and keeps it until main is green again — the only long hold in S1
   (`finish` does this itself when it records `failure`, holder `<id> / main-broken <sha12>`).
2. `bd create --type bug -p 0 "main 破損: <sha> <failing step>"`, first lines of the log in a comment.
3. Find the last `success` and the first `failure` from the per-SHA statuses (CI runs on main are
   `cancel-in-progress`, so they can be missing; statuses are not).
4. Fix-forward only if it is a one-liner doable in ~10 minutes; otherwise revert:
   `git switch -c bd/<bug-id> origin/main && git revert --no-edit <breaking squash sha>` (no `-m`
   needed: it is a squash) → PR → CI → merge. Under S1: `prepare` → `gate <N> --repair` (skips the
   ledger check, takes over the `… / main-broken <PRED_BASE sha12>` slot or takes it under that
   name) → the printed merge line → `finish`, which keeps the slot unless the fix's landed verify is
   `success`, and releases it when it is. `--repair` is only for the fix PR of the P0 bug.
   `--repair`, like `gate` generally, requires `BDBOARD_MERGER=chair`; only the chair is responsible
   for running it. Hook rule 9 (worktree ownership) remains a secondary defense where applicable.
5. Once the fix's landed-verify is `success` (and the slot is released), reopen the ticket of the
   breaking PR with the reason, and add the case to failure-catalog.md.

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

**The chair also brings its own session checkout up to date** (bdboard-flpp).
Hooks and skills are read from the checkout the session was started in
(`$CLAUDE_PROJECT_DIR`), and every subagent the chair launches reads its hooks
from that same checkout — so a chair checkout left behind `origin/main` silently
runs old guards for everyone (in 2026-09 hook rule 7 never fired for a month
this way). Nothing updates it automatically, on purpose: the chair may have work
in progress there. The pack hook `worktree-freshness.sh` (SessionStart /
UserPromptSubmit / PostToolUse(Agent)) warns the chair when that checkout is
behind and prints the safe command for its state — typically
`git -C <chair checkout> merge --ff-only origin/main` when it has no commits of
its own and a clean tree. Run it after `deploy`. If the warning says the
registration (`.claude/settings.json`) changed too, check `/hooks` afterwards and
restart the session if the new hook is not listed. A checkout with no common
ancestor with `origin/main` cannot catch up: move the work out and start the
session again from a new worktree. Sessions whose checkout predates this hook
get no warning at all; for those the board's Hygiene lane
(`nonTicketHarnessWorktrees`) is the only signal.

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
  (`bdboard/landed-verify`) で担保する (bdboard-ulxa §3.3)。S2 では CI が見ていない
  「main + PR」の木を prepare が手元で verify し、同じ CAS でその木が着地することを保証する。Merge queue は user-owned の
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
