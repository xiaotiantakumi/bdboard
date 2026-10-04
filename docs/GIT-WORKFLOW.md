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

## 待ち方

長い処理は `run_in_background` で投げて完了通知を待つ。Bash の同期実行は
既定 2 分、`timeout` を付けても最長 10 分で打ち切られる。verify のスロット待ち (`waiting for a verify slot`) は
FIFO 待ちであってハングではない — kill して再実行しない。

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
`.claude/agents/bdboard-worker.md` の手順3で作るブランチ `bd/<ticket-id>` の方で識別する。
merge-pr とマージ後の片付けは、`git worktree list --porcelain` の
`branch refs/heads/bd/<ticket-id>` で引いた worktree に対して行う。実測 (bdboard-cm2q.5、
議長が片付け、2026-09-26): この worktree は `locked` になっている — `lsof -a -d cwd +D <path>`
で使用中でないことを確かめてから `git worktree remove -f -f <path>` で消し、同時に
`worktree-agent-<id>` ブランチと、手順3で作ったローカルの `bd/<ticket-id>` ブランチも
`git branch -D` で消す (worktree が残っている間は `--delete-branch` がローカル側を消せないため、
worker の `bd/<ticket-id>` はここで消さないと残り続ける。bdboard-cm2q.12)。
「Cleanup after merge」節にも同じ手順を書いてある (bdboard-cm2q.11)。

途中で止めた worker の片付け (bdboard-kmoe): 議長が引き取る・チケットを分ける・human gate・
打ち切るのどれにするかと claim の扱いは `.claude/agents/bdboard-worker.md` の「予算」節。
worktree を消すのは「打ち切る」と、範囲内が進んでいないまま「分ける」ときだけで、引き取る・
human gate では残す。消す前に、worker が残した `logs/progress.md` の要旨を `bd comment <ticket-id>`
でチケットに写す (logs/ は gitignore 済みで、worktree と一緒に消える)。消し方は上と同じで、
`lsof` に何か出たら (worker が run_in_background で回した verify など) 終わるまで待ち、kill しない。
PR を作っていたら先に `gh pr close <N>`、push 済みなら `git push origin --delete bd/<ticket-id>` で
リモートも消す。ローカルかリモートに `bd/<ticket-id>` が残っていると、同じチケットで起動し直した
worker は手順2-3 で precheck-failed になる (human gate の回答後に新しい worker を起動せず、同じ
worker に SendMessage するか議長が引き取るのも同じ理由)。
「打ち切る」の `bd unclaim` は、この片付けが済んでから最後に打つ。「議長が引き取る」ときも、先に `lsof -a -d cwd +D <path>` で worker の background verify が残っていないか見て、残っていれば終わるまで待つ。

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
2. **進捗コメント**: 起票（bd チケット化した時点）・着手の節目では、紐付けた GitHub issue
   側にもコメントで進捗を書いてよい。ただし **close は手でしない** — external-ref が
   `gh-<N>` 形式のチケットは、対応 PR の本文に closing keyword を書けば squash
   マージで issue が自動的に閉じる（下記「PR 本文で external-ref の issue を閉じる」節。
   `npm run merge-pr -- prepare` が機械的に強制する）。
3. **判断が残る場合**: 対応方針の判断がまだ残っている（要確認・要議論）なら、その旨を
   issue にコメントして次のセッションに引き継ぐ（自動close の対象外にしたいときは、その旨も
   書く）。
4. **公開リポジトリの注意**: このリポジトリは public なので、issue コメントに内部パス・
   端末固有の設定・非公開の運用履歴やシークレットを書かない。

### PR 本文で external-ref の issue を閉じる

チケットの external-ref (`gh-<N>`) が持つ GitHub issue #N は、対応 PR の本文に GitHub の
closing keyword (`Closes` / `Fixes` / `Resolves`。大小文字は無視) か `Refs` を `#N` 付きで
書けば、squash マージで自動的に閉じる (`Refs` は閉じずにリンクだけ残す)。手でコメントして
手で閉じる運用 (#432 や #437 で行っていたもの) はもうしない — PR はもともと公開なので、新しく
公開される情報は増えない。

**1 つの issue に複数チケットがある場合** (例: gh-432 に bdboard-jzla と bdboard-4sku の 2 件):
最後にマージする PR だけ `Closes #N` (issue を閉じる) を書き、それ以外の PR は `Refs #N`
(閉じずに参照だけ) を書く。どちらを書くかは担当の判断 — 「最後の PR かどうか」を機械的に
決める情報が bd 側に無いため、スクリプトは判定しない。

**機械的な強制 (bdboard-4y8q.8)**: `npm run merge-pr -- prepare <N>` が、対象チケットの
external-ref が `gh-<N>` 形式のときだけ、PR 本文 (コードブロックを除く) に `Closes #N` /
`Fixes #N` / `Resolves #N` / `Refs #N` のいずれか (大小文字無視。`Fixed #N` 等 GitHub が閉じる
活用形も可) があるかを確かめる。無ければ既存の前提条件エラーと同じ exit code (2) で止め、
どのキーワードを書けばよいかをメッセージに示す。本文を直すだけでよい (head は変わらないので
push も CI のやり直しも要らない) — 直したら prepare をやり直す。external-ref がそもそも無い
チケット、または `gh-<N>` 形式でない external-ref (例: URL 形式) は対象外 (何もしない)。
走るのは `merge.mode` が S1 / S2 / S3 の prepare だけ。rebase が要る (exit 3) PR と必須チェックが
green でない PR では、それを直して prepare し直したときに初めて走る。S2 / S3 クラス F の着地予定ツリー
verify と S3 クラス L の軽量チェックよりは前に走る (本文だけの不備で verify スロットを使わない)。S0 の prepare (分類表示だけ)
と `--dry-run` では走らない。チケットは prepare のレビュー記録の確認
(`bdboard.model.review`) が読んだものを使う (bd は 1 回だけ読む)。bd が読めない (bd 未接続・
タイムアウト等) ときは、このチェックに来る前にレビュー記録の確認が止める (fail-open はしない)。
実装: `scripts/merge-pr/external-ref.mjs`
と `scripts/merge-pr/prepare.mjs`。詳細な手順は
harness/packs/bdboard-harness/references/worktree-pr-flow.md「PR 作成」節。

## Direct-to-main の禁止 (例外なし)

**Direct-to-main commits are banned, with no exception** — not even a
CI-recovery commit touching only `.github/workflows/`. Even a one-line
fix goes through a PR; the consistency is what makes "main is always
PR-gated" a reliable invariant for concurrent sessions. Since 2026-09-26
the GitHub ruleset's bypass mode is "pull requests only" (see "ブランチ保護"
below), so even the repository owner cannot push straight to `main` any
more — CI recovery too goes in as a PR, merged via the ruleset bypass only
when Actions itself cannot run (a PR that edits a workflow normally runs its
own version and needs no bypass; a renamed check is fixed in the ruleset, see
"ブランチ保護").

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
merge (this is **S0**, the procedure while `merge.mode` is `"S0"`; S1, S2 and S3 follow):

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
`S1` / `S2` / `S3` = the steps below. Switching and rolling back are one-line edits of that key,
landed through a normal PR; agents dispatched after the switch use the new steps.

### S1 — hold the slot only for the CAS and the merge (`merge.mode: "S1"`)

Measured on 2026-09-23 (bdboard-iaqg): with S0 the slot was held 7.6 of 11 hours
(≈70%), because the rebase → CI (5–9 min) → CAS retry loop and the post-merge
verify all ran inside it; merges were ≈12 minutes apart. S1 moves everything except
`acquire → git ls-remote → gh pr merge → release` out of the slot (design:
bdboard-ulxa §2 A; S2 — verifying a predicted landed tree instead of rebasing — is the
next subsection, S3 — a light check for PRs that do not overlap main — follows it). From the PR worktree (a linked worktree made by
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

- **Exit codes**: `2` precondition failed (no review record / ticket not found in bd / the PR body
  does not reference the ticket's `gh-<N>` external-ref issue — see "PR 本文で external-ref の issue
  を閉じる" above); `7` caller is not the chair.
  `3` main moved (class R) → `git rebase origin/main` (or `git merge origin/main`)
  → push → wait for CI → `prepare` again. `75` start over from `prepare` (CAS lost, main moved
  while waiting, `ls-remote` failed, slot not free within `merge.slotWaitMinutes`, CI pending or
  the GitHub API unreachable). `4` / `6` main is broken → below. `5` finish found the PR unmerged
  (and returned the slot, except under `--repair`). `1` could not run at all (bd unusable, dirty
  worktree, run from the main checkout, `npm ci` failed, untracked files not `.gitignore`d by the
  tree about to be verified, the verify slot wait timed out, …) — the message says what to fix; for a
  landed verify that could not run, fix it and run `npm run merge-pr -- verify <sha>`.
- **The merge line is printed, not run by the script** (decision 4 of bdboard-ulxa §6): if the
  permission classifier refuses `gh pr merge`, running it from inside a script would be a
  bypass. Refused → do not retry, run `finish` (it returns the slot), then the human gate
  (ticket-flow). `--match-head-commit` makes GitHub reject the merge (409) if someone pushed to
  the branch after `prepare`; that also ends in `finish` + `prepare`.
- **Exit code `8`: a stale `refs/remotes/origin/main.lock` is not a 75** (bdboard-1syo). If the
  `git fetch origin main` that opens every phase fails because a lock file is in the way
  (`Unable to create '….lock': File exists` — a fetch only takes the lock when it has a ref to
  update, so this starts once `origin/main` moves) and the named lock file still exists, retrying
  cannot help, so it is a human-looking failure: the message prints the lock path and tells you to
  confirm that no other `git` is running (`ps -axo pid,etime,command | grep '[g]it '`) before
  `rm -f`-ing it, then to start over from `prepare`. merge-pr **never deletes the lock itself** — a
  live fetch or push may be holding it. If the lock is already gone when merge-pr looks, it was a
  brief race with another git and the failure stays 75. So does `cannot lock ref '…': is at X but
  expected Y` (another fetch moved the ref first; Git 2.51 words it `incorrect old value provided`),
  which names no lock file. The fetch runs with `LC_ALL=C` so that git's wording is never
  translated (a German git says `Konnte '…' nicht erstellen`). `finish` (which carries on from
  the local `origin/main` so it can still return the slot) only prints the advice, without the
  "run it again" line. Mid-run refetches (`refetchMain`, used while waiting) do the same: print
  once per lock, never abort — the CAS against `git ls-remote` is what guards the merge, and
  aborting inside `finish` would skip the landed verify. Typical sources: a Bash-tool timeout
  killing merge-pr's own fetch, a Ctrl-C on a manual `git fetch`, a SIGTERM between creating a
  lock and registering it for cleanup (bdboard-rlvz).
- **Layer 3 ledger** = GitHub commit status `bdboard/landed-verify` on each main SHA
  (`gh api repos/xiaotiantakumi/bdboard/commits/<sha>/status`). `finish` checks out the landed tree
  in the PR worktree (`git checkout --detach <sha>`; `npm ci` first if a lockfile differs from what
  that worktree last installed — a failing `npm ci` is reported, not recorded as `failure`; neither is
  a verify whose slot wait timed out, which `npm run verify` reports as exit 75 — no verify ran, so
  only `pending` stays on the ledger, bdboard-wj9m), posts
  `pending`, runs the contract's `verify` while re-posting `pending` every `leaseMinutes / 3` (so a
  verify queued behind the machine-wide verify slots does not look abandoned), posts `success` /
  `failure`, and checks the branch out again. It never touches the main checkout. The verify log
  is `<git common dir>/bdboard-merge/landed-verify-<sha>.log`. The landed verify runs alone in the
  machine-wide verify slots (`landed` is exclusive, docs/VERIFY.md "Priorities", bdboard-xdk8).
- **One retry for a load-induced landed failure** (bdboard-xdk8; `finish`, manual `verify`, and the
  gate self-heal — not S2's predicted-tree verify). On 2026-10-04 a docs-only PR's landed verify
  failed twice under machine load and the main-broken slot stopped every merge. When the landed
  verify fails, `scripts/merge-pr/load-retry.mjs` reads its log: only if the failing step is a
  vitest run and *every* error headline is a timeout (`Test/Hook timed out in Nms`, vitest's pool
  start/terminate timeouts, birpc call timeouts, `spawnSync … ETIMEDOUT`) does it rename the first
  log to `landed-verify-<sha>.first-attempt-<UTC time>.log`, append `landed-verify-retry` (exit,
  timeout count, 1-min load average, CPU count, kept log) to the audit log, post `pending`
  ("retrying after load-induced failure"), and run the verify once more. The second result is
  recorded as usual, with `(retried after load-induced failure: N timeouts)` in the status
  description; a second failure is a `failure` (main-broken) as before, and a slot-wait timeout on
  the retry is "could not run" (exit 75, nothing but `pending` recorded). Any other failure — an
  assertion, a type error, a failing non-vitest step, an unrecognized headline, a test whose
  `spawnSync` child was killed and so compares `null` to an exit code — is recorded right away, as
  before. The decision uses the failure's shape only, not the load average: under high load a
  real race can also fail with an assertion, and a load threshold would retry it too, while a
  deterministic regression (including a hang that always times out) fails the retry and is still
  recorded.
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
- **A second `finish` while one is running exits 75** (`verifyingPid` in the state file is alive). The
  record is stamped with `verifyingAt` and the process start time `verifyingStart` (`ps -p <pid> -o
  lstart=`, bdboard-ky9l). If the live process was started at the recorded time it is the same `finish`:
  it stays 75 however long it has been running (a verify past 2 hours, a laptop that slept). If it was
  started at another time the PID was reused, the record is stale even when fresh, and `finish` ignores
  it with a notice and goes on. When the start time cannot be compared (a record from before
  bdboard-ky9l, no usable `ps`, **Windows** — no `ps`, so it is not read there), the old rule applies:
  older than 2 hours (`VERIFYING_PID_MAX_AGE_MS`) means stale (bdboard-2hj4).
- **A `finish` killed with SIGKILL leaves its verify running.** The verify is started `detached`
  (its own process group), so SIGKILL of `finish` skips the cleanup above and the group survives. The
  verify's group id is stamped in the state file (`verifyPgid`, with `verifyPgidStart` and
  `verifyPgidAt`); a rerun of `finish` that finds that group still alive exits 75 with `pgrep -g <pgid>`
  and `kill -TERM -<pgid>` hints instead of starting a second verify in the same worktree (bdboard-ky9l).
  Kill the group (or wait for it), then rerun `finish`. A group whose leader has exited but which still
  has members is the original group (POSIX does not reuse the number while the group exists); a live
  leader is compared by start time like `verifyingPid`. There are no process groups on Windows, so
  nothing is recorded or checked there.
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
building / linting / testing the landed tree catches a semantic conflict) — under S2 it is only logged; S3 uses it to choose a light check.

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

### S3 — a light check for PRs that do not overlap main (`merge.mode: "S3"`)

S3 is S2 plus one more class (bdboard-ulxa.3, design §2.3 / §5). Under S2 every moved-main PR that is
not R pays a full `npm run verify` (2–4 minutes plus the slot queue) on its predicted tree, even when
main's changes and the PR's never touch the same file. Under S3, `prepare` splits S2's class F:

| Class | When | What `prepare` does |
|---|---|---|
| N / R | as in S2 | as in S2 (file overlap does not decide R either) |
| F | S2's F **and** (main's changes and yours share a file, or either side touches a `merge.hotFiles` file or the merge procedure itself — one side is enough — or **both** sides touch `merge.lightBlindFiles` — any pattern on each side — default `scripts/**`) | as in S2: the full `verify` on the predicted tree |
| L | S2's F, no shared file, no hot file and no merge-procedure file on either side, and not both sides in `merge.lightBlindFiles` | builds the same predicted commit and runs only `merge.lightCheck` (default `npm run verify -- --light` = `verify:light`: check:file-size, lint:verify, build, build:web, check:boundaries — no tests) on it, in the same slot queue (priority `merge`) with the same abandon-on-main-move. Green → records PRED_BASE and the light result; red → exit 3, like a failed predicted verify |

File overlap still never decides whether to merge without a rebase; it only picks full (F) or light (L).

- **What the light check cannot see (`merge.lightBlindFiles`, PR #854 review).** The light check
  inspects nothing in `scripts/`: tsc's projects include only `src/`, `vitest.config.ts` and
  `test/e2e`, depcruise only `src` and `web`, and the ESLint pass over `scripts/**/*.mjs` is untyped
  with no import-resolution rule — importing a missing export or module there exits 0 (measured).
  (`web/src` is not in the list: `build:web` runs `tsc --noEmit` over it, so the light check does
  type-check its imports.) If main renames an export in `scripts/commit-message-guard.mjs` while a
  PR imports the old name from a new `scripts/new-tool.mjs`, both PRs are green on their own, an L
  merge passes the light check, and main lands broken — only the full landed verify finds it. So a
  PR is F when **both** sides touch `merge.lightBlindFiles` (default `["scripts/**"]`; a contract
  value replaces the list) — any pattern in the list on each side, not necessarily the same one. It
  is a separate key from `merge.hotFiles` on purpose: a hot file also makes S2 rebase (R), which
  these files do not need. One side only stays L — the other side does not change those scripts,
  and the side that does has its own CI and the full landed verify. The merge procedure itself is F
  even when only one side touches it, because a broken one is worse than a broken main: every agent
  that pulls it gets a `merge-pr` that dies on start, including the one that has to merge the
  repair. That list is `MERGE_PROCEDURE_FILES` in `scripts/merge-pr/hot-files.mjs` (not in the
  contract): `scripts/merge-pr/**`, `scripts/merge-pr.mjs`, `scripts/check-drift/**`,
  `scripts/check-drift.mjs`, and the `scripts/` modules `merge-pr` imports
  (`scripts/process-identity.mjs`, `scripts/process-tree.mjs`, `scripts/verify-slot.mjs`,
  `scripts/verify-slot-files.mjs`, `scripts/verify-slot-queue.mjs`; `scripts/merge-pr.s3.test.mjs`
  walks the imports and fails when one is missing).

- **The light result is never a verify result.** Class L records `lightTree` / `lightCommit` /
  `lightCheck` / `lightCheckedAt` / `lightCheckSecs` (class F keeps `predictedTree` /
  `predictedVerifiedAt`); the audit event is `light-check` (F's is `predicted-verify`). Neither is
  written to the `bdboard/landed-verify` ledger (the predicted commit is not on GitHub). `gate` lets a
  record through only when its class and fields fit the current mode (`scripts/merge-pr/record.mjs`):
  N in S1–S3; F in S2/S3 with the full verify recorded; L in S3 only, with the light fields present and
  `lightCommit`'s tree and parents equal to `lightTree`, PRED_BASE and the PR head. Anything else
  (a missing field, a mismatch, an unknown class) is `gate-record-refused` in the audit log and exit 75
  → `prepare` again.
- **The landed verify stays the full `npm run verify`.** `finish` runs it on what lands exactly as in
  S1/S2, so what the light check cannot see (tests, e2e excepted as always) is still caught and
  recorded in the ledger. `finish` also compares the landed tree with `lightTree` and audits it as
  `light-tree … match=true|false|unknown` — a separate event from F's `predicted-tree`, so S2's
  measurements and its rollback rule keep counting class F only (a `light-tree … match=false` means
  the same thing, GitHub's merge and git's disagree, and is reported the same way) — and audits the
  landed verify as `light-landed … result=success|failure|error by=finish|manual|self-heal`. One
  landed SHA can get several `light-landed` lines (an `error` and then a re-verify); count the last
  `success` / `failure` per `new=`.
- **An L whose landed verify could not run stays L.** If `finish`'s landed verify ends in `error`
  (a verify-slot timeout, a failed `npm ci`, …), `finish` prints the slip rule, audits
  `light-landed … result=error` and keeps its record (`class: "L"`, `newMain` = the landed SHA) in
  `<git common dir>/bdboard-merge/` as it always does on `error`. The later `merge-pr verify <sha>`,
  or the next merger's `gate` self-healing that SHA as its PRED_BASE, finds the record by the landed
  SHA and treats a `failure` as the slip, exactly like `finish`.
- **A slip sends us back to S2.** A class-L merge whose landed verify fails is a slip of the light
  check (`light-landed … result=failure`; `finish` / `verify` / `gate` say "S3 のすり抜け"). First rule
  out a known flake (bdboard-241s, …) or a load-induced failure (a parallel verify timing out) in the
  log: then main is not broken and it is not a slip — `merge-pr verify <sha>` again. Otherwise it is
  handled as a broken main (below: `finish` holds the slot as `main-broken`, P0 bug, fix-forward or
  revert), **and** one slip is enough to roll back (design §6 decision 7): the repair PR also carries
  the one-line change setting `merge.mode` back to `"S2"` (so no other L lands while the light check is
  known to miss something; the contract is a hot file, so the repair PR itself is never L).
  Rollback needs nothing else — under S2 no PR is classified L, and a class-L record still waiting for
  `gate` is sent back to `prepare` (exit 75), where it becomes F and gets the full verify. A PR already
  gated finishes normally.
- **Exit codes** as in S2; `3` also means "the light check failed on the predicted tree" (log:
  `<git common dir>/bdboard-merge/light-check-pr<N>-<tree12>.log`).
- `prepare --dry-run` also prints the S3 class ("参考: merge.mode が S3 ならクラス=…") in S0–S2, and
  a normal S2 `prepare` prints it when the PR would be L — use it to see how often S3 would apply.
- Switching: a one-line PR setting `merge.mode` to `"S3"` (`merge.lightCheck` has a default). A
  branch cut before this script supported S3 rejects `"S3"` as an unknown mode in every phase (exit 1,
  "merge.mode は S0 / S1 / S2 のいずれかです (受領: \"S3\")") before it touches the slot or the ledger:
  `git merge origin/main` first. Since S3 the message itself says so for any later unknown mode. A
  `finish` that hits this (a PR gated on an old branch while main switched — normally impossible,
  since the slot is held from `gate` to `finish`) can be run from any worktree with the current
  script: the record lives in the git common dir.

### When main is broken (S0, S1, S2 and S3)

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
   for running it. Each ticket's isolated worker (`isolation: "worktree"` for the `bdboard-worker`
   agent) and the GitHub ruleset's bypass mode ("pull requests only") remain as secondary defenses.
5. Once the fix's landed-verify is `success` (and the slot is released), reopen the ticket of the
   breaking PR with the reason, and add the case to failure-catalog.md.

Other mergers that see `failure` stop; they neither merge nor take the slot.

## Cleanup after merge

(the merging session's responsibility):
`git worktree remove .claude/worktrees/<id>` → `git branch -d bd/<id>` →
`git remote prune origin`. For a `bdboard-worker` PR, find the worktree by
`branch refs/heads/bd/<id>` in `git worktree list --porcelain` (its directory name
is a Claude-chosen slug); it is `locked`, so after the `lsof` check remove it with
`git worktree remove -f -f <path>` and delete both `worktree-agent-<slug>` and the
local `bd/<id>` with `git branch -D` (see the bdboard-worker paragraph in "worktree"
above). Restarting the always-on server is **not** part of
the cleanup a subagent does: the chair (top-level session) runs
`BDBOARD_SERVER_CALLER=chair scripts/always-on-server.sh deploy --expect-pid <pid>`
(pull --ff-only / build:web / restart; see skill `bdboard-server-ops`). Kill commands
are blocked for every agent via `permissions.deny`; a `bdboard-worker` subagent's
main-checkout pull / start, when typed directly, is additionally blocked by its
`isolation: "worktree"` sandbox (bdboard-hpu8, bdboard-cm2q.10). Running
`scripts/always-on-server.sh` is not blocked by isolation (bdboard-25n3), and a non-isolated subagent has no such
backstop and relies on the written rules (AGENTS.md, this document, the agent
definitions). A subagent that merged a PR just
reports that a restart is needed. At session start,
sweep `git worktree list` for merged leftovers left behind by a prior
session.

**The chair also brings its own session checkout up to date** (bdboard-flpp).
Hooks and skills are read from the checkout the session was started in
(`$CLAUDE_PROJECT_DIR`), and every subagent the chair launches reads its hooks
from that same checkout — so a chair checkout left behind `origin/main` silently
runs old guards for everyone (in 2026-09 the since-removed hook rule 7 never
fired for a month this way). Nothing updates it automatically, on purpose: the chair may have work
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

**Primary: keep the originating checkout caught up with `origin/main`**
(the "chair also brings its own session checkout up to date" step just above,
bdboard-flpp). Claude Code reads the shared `.claude/settings.json` from the
directory the session was *started* in — a session started in a worktree gets
that branch's copy, and `EnterWorktree` does not change it — so a deny merged to
`main` does not reach a session whose originating checkout is older (observed
2026-09-26: a chair session started in a worktree from before cm2q.1 never saw
that PR's deny lines). Measured 2026-09-26: updating a chair session's
originating worktree with `git merge --ff-only origin/main` made that worktree's
new deny line (`aimix run *`) take effect immediately, with no restart. Prefer
this whenever the originating checkout can be fast-forwarded (no commits of its
own, clean tree).

**Fallback: mirror every `permissions.deny` line into the main checkout's
`.claude/settings.local.json`** (bdboard-cm2q.12), for a session whose
originating checkout cannot be fast-forwarded (mid-branch work, dirty tree).
`.claude/settings.local.json` is read from the main checkout's root even in a
worktree session (https://code.claude.com/docs/en/settings: "In a worktree, it
uses the file at the main checkout's root"; observed 2026-09-26: a deny line
added to the main checkout's `settings.local.json` took effect, without a
restart, in a chair session running in a worktree), so copying the lines there
makes them apply to every session at once. That file is outside git and
changing it needs the user's approval; a worktree-isolated session cannot write
it, so ask a session running in the main checkout. Upstream issue:
anthropics/claude-code#83953 (project settings are branch-local in worktrees).

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
  「main + PR」の木を prepare が手元で verify し、同じ CAS でその木が着地することを保証する。
  S3 のクラス L (main と重ならない PR) はその木で軽量チェック (build + lint + check:boundaries) だけを
  回し、テストは着地後検証のフル verify に任せる (すり抜け 1 件で S2 に戻す)。Merge queue は user-owned の
  private/public repo では使えない。
- **force push 禁止** (`non_fast_forward`)、**ブランチ削除禁止** (`deletion`)。
- **bypass = Repository admin、mode は pull requests only (2026-09-26 変更)**。
  admin であっても main への直接 push はできない — bypass が使えるのは PR
  のマージ時に必須チェック等を無視する場合だけ。CI 復旧もこの bypass 付き
  PR マージで入れる。

確認・変更は API から:

```bash
gh api repos/xiaotiantakumi/bdboard/rules/branches/main --jq '.[].type'   # 効いている rule
gh api repos/xiaotiantakumi/bdboard/rulesets                             # ruleset 一覧 (id を取る)
gh api -X PUT repos/xiaotiantakumi/bdboard/rulesets/<id> --input ruleset.json
```

required checks の **名前はジョブ名と一致していなければならない**。ci.yml のジョブ名を
変えるときは ruleset 側も同じ PR の流れで更新すること (名前がずれると、その check が
永遠に「待ち」のままマージできなくなる — bypass で押し通すのは規約違反)。
