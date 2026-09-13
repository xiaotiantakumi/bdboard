# 検証 (Build & Test) の詳細

AGENTS.md「Build & Test」から分離した詳細。**`npm run verify` を回す前に読む必要は無い** —
必要になるのは次のときだけ:

- 個別の tsc プロジェクト構成を触る / 新しい設定ファイルを足す（下の「tsc プロジェクトの表」）
- `npm run verify` が待たされている・スロット関連のメッセージが出た（下の「Verify slots」）
- ローカルの起動 (`npm run start` / `dev` / `dev:web`) の違いを確認したい

AGENTS.md 側に残っている 1 行要約と食い違ったら、**この文書が詳細の正**。ただし slot の実装挙動は
`scripts/verify.mjs` / `scripts/verify-slot.mjs` が正で、この文書はその要約。

## 全体

コミット前 (server / web どちらの変更でも) に、フル検証チェーンをクリーンに通すこと:

```bash
npm run verify   # build (server tsc) + build:web (web tsc + vite build) + test:server + test:web + check:boundaries
```

Node が `package.json` の `engines.node` を満たさないと、verify は子プロセス (tsc / vite / vitest) を
1 つも起動せず、要求版・現在版・`.nvmrc` の案内を出して exit 1 する (bdboard-eu2k,
`scripts/node-version-guard.mjs`)。`.nvmrc` は自動では適用されない (非対話シェルは nvm を読み込まない
ことがある) ので、PATH の先頭に engines を満たす v22 の bin を置く (または
`. "${NVM_DIR:-$HOME/.nvm}/nvm.sh" && nvm use`) してから回す。ガード自体は v14.13.1 以上でパースできる。
CI の ubuntu `verify` job は `BDBOARD_OLD_NODE` で実 Node 14.15.0 を
`scripts/node-version-guard.old-node.test.mjs` に渡すため、ガードの import graph に Node 14.15.0 が
パースできない構文や、ガードより前に評価される新しい API が紛れれば CI は赤くなる (同 job は
`BDBOARD_OLD_NODE_REQUIRED=1` も立てるので、旧 Node の設定が抜けると skip ではなく失敗する)。
環境変数がないローカル実行ではこのテストは skip される。再現するには
`BDBOARD_OLD_NODE=$HOME/.nvm/versions/node/v14.15.0/bin/node npm run test:server -- scripts/node-version-guard.old-node.test.mjs` を使う。

`engines.node` の下限は、ルート・`web` の直接依存が宣言する `engines.node` のうち、22.x 系で最も高い
要求に揃える (bdboard-ugt1、現状はサーバー側テストの vitest が使うルートの Vite 7)。
`scripts/engines-coverage.test.mjs` がコミット済みの lockfile から直接依存の engines を読み、下限を
受け付けない依存があれば落ちる。推移依存は対象外 — rollup の optional なプラットフォーム別バイナリの
ように特定 OS/CPU でしか入らず engines が厳しいものがあり、それに合わせると利用者を不要に締め出すため。

## tsc プロジェクトの表

`npm run build` は**サーバー側**を型チェックする。3 つの別々の tsc プロジェクトを直列に走らせる。
前提 (`rootDir`, `lib`, `types`) が両立しないため 1 つの config にまとめられない:

| project | covers | why separate |
|---|---|---|
| `tsconfig.json` | `src/**/*` | server. `rootDir: src` |
| `tsconfig.node.json` | `vitest.config.ts` | `lib: ["ES2023"]` + `types: ["node"]`, **no DOM** |
| `test/e2e/tsconfig.json` | `test/e2e/**/*.ts` (recursive — `fixtures/` included) | needs `DOM` for `page.evaluate`, so it can't share the row above |

`web/` has its own pair of `tsc --noEmit` steps inside `npm run build:web` (`tsconfig.json` for
`web/src` + `web/vitest.setup.ts`, `tsconfig.node.json` for `web/vite.config.ts` +
`web/vitest.config.ts`), ahead of the Vite
build — a real type error there is invisible to `npm run build` and to `npm run test:web` (vitest
doesn't full-type-check). `npm run verify` runs all of it, plus the web Vite build itself, so nothing
can silently drift broken (see bdboard-419 for the incident that prompted this, bdboard-ruf for the
`web/` config files, and bdboard-u97 for the root ones).

The rule behind the table: **a config file that is never imported by anything still has to belong to
some tsc project, or it is unchecked.** `include` is what puts a file in a project; being reachable
by import is not enough, and neither is sitting next to files that are checked.

## 個別コマンド

サブセットだけ回したいとき:

```bash
npm run build            # tsc --noEmit x3 (src/, vitest.config.ts, test/e2e/)
npm run build:web        # web tsc --noEmit x2 + vite build
npm run test:server      # vitest run (src/)
npm run test:web         # vitest run (web/src/)
npm run check:boundaries # dependency-cruiser (architecture layering)
```

## Verify slots (max 2 concurrent `npm run verify` per machine)

`npm run verify` throttles itself: before running anything, `scripts/verify.mjs`
takes a slot in a machine-local FIFO ticket queue (holder files under
`$TMPDIR/bdboard-verify-slots/`, logic in `scripts/verify-slot.mjs`), and at
most **2** verifies run at once per machine. This is the fix for the
2026-08-18 incident where 6 concurrent verifies self-amplified into load
average 190–258 for hours (bdboard-d48) — the per-run vitest worker caps
(bdboard-255) cannot prevent that alone, because more *submissions* still
pile up. Unlike `bd merge-slot`, this is not a cooperative convention you
must remember to follow: the lock lives inside the only sanctioned entry
point, so every `npm run verify` is throttled automatically, and there is no
bead behind it (nothing new to exclude from `bd ready`).

What this means operationally:

- **Always run the full chain via `npm run verify`.** Never run
  `npm run verify:steps` directly — it is the wrapper's internal entry point
  and bypasses both the process-group kill (bdboard-kia) and the slot.
  Running individual steps (`npm run build`, `npm run test:server`, …) while
  iterating is still fine; the slot only guards the full chain.
- **Queue waits are normal, not hangs.** While waiting, verify prints
  `verify: waiting for a verify slot (queue position N/M, holders: pid …)`
  every 10s on stderr. Leave it queued — the queue is FIFO, so the wait is
  bounded, and killing + re-running re-enters the queue at the back. Give
  the command a generous timeout instead of assuming it wedged.
- **Stale handling is automatic.** A holder whose pid is dead is reclaimed
  immediately (covers SIGKILLed verifies); a live holder in the queue for
  >30 min stops counting toward the limit (logged, file left alone). If a
  wait exceeds 15 min, verify exits non-zero naming the holder pids —
  investigate those pids (hung verify?) rather than disabling the slot.
- **Env knobs are for tests and emergencies only**: `BDBOARD_VERIFY_SLOTS`
  (default 2; `0` disables gating), `BDBOARD_VERIFY_SLOT_DIR`,
  `BDBOARD_VERIFY_SLOT_WAIT_MS`. Do not raise or disable them just to run
  more verifies in parallel — that recreates the incident. CI needs no
  special casing (one verify per runner; the slot is acquired instantly).

## 既知 flake の判別 (`[vitest-worker]: Timeout calling "onTaskUpdate"`)

`npm run verify` が非ゼロで終了したとき、その原因が bdboard-c6nv で追跡している vitest
本体の未解決 upstream バグ (birpc の RPC ACK タイムアウトが 60 秒でハードコードされており
プール側から上書きできない) による既知の偽陽性かどうかを、リーダーモード
(`scripts/verify.mjs --group-leader`) が `npm run verify:steps` の出力から自動判定する
(判定ロジック本体は `scripts/verify-flake-detector.mjs`、テストは
`scripts/verify-flake-detector.test.mjs` — bdboard-8rl8)。

判定は次の 2 条件が両方そろったときだけ「既知 flake」とみなし、ログ末尾に
`verify: known flake detected (bdboard-c6nv)` の説明ブロックを追加で出す:

- vitest の `Tests` サマリ行 (`Test Files` 行ではない) の failed 件数の合計が 0 件
- 出力に `Timeout calling "onTaskUpdate"` を含む

**実失敗が 1 件でもあれば、`onTaskUpdate` が同居していても実失敗として扱う**
(2026-09-06 の bdboard-6y5b で per-test timeout の実失敗と onTaskUpdate の unhandled error
が同居した実例があるため、向きを間違えると実バグを握り潰す)。`Tests` サマリ行が 1 行も
見つからない場合 (出力の書式が変わった、vitest 自体が走っていない等) は「判定不能」として
安全側に倒し、既知 flake とは表示しない。

**このメッセージは表示を追加するだけで、`npm run verify` の終了コードの意味は変えない** —
既知 flake であっても exit は非ゼロのまま返る。自動 rerun も行わない (実失敗を握り潰す方向の
自動化は明示的にスコープ外)。

判定のためリーダーモードの子プロセス (`npm run verify:steps`) の stdio は `inherit` ではなく
pipe にしてテキストを溜め込み、実画面へは従来どおり tee で流している。ローカルの対話端末
(TTY) で色付き出力が変わらないよう `FORCE_COLOR` を補っているが、CI はもともと非TTYなので
影響はない。

## ローカル起動コマンドの違い

`npm run start` serves the backend + built `web/dist` together on `BDBOARD_PORT` (default `8787` —
`.claude/launch.json`'s preview port must match this, not 3000). `npm run dev` / `npm run dev:web` are
for local iteration (server watch mode / Vite dev server, respectively).

worktree での起動可否・常時稼働サーバーの扱いは skill `bdboard-server-ops`
(`.claude/skills/bdboard-server-ops/SKILL.md`) を参照。

## lockfile と npm の版

コミットする `package-lock.json` / `web/package-lock.json` は **Node 22 同梱の npm 10 系 (10.9.x)** が
書く形に揃える (bdboard-m4sl)。CI (ubuntu / windows の `node-version: 22`) とメインチェックアウトの
Node 22 がこの npm を使うため。`packageManager` / `devEngines` で npm を固定しないのは、release-please
の publish ジョブだけが trusted publishing のために npm 11 へ上げており、固定するとそこと食い違うため。

npm 11 系は、新しく解決したプラットフォーム別バイナリ (rollup / lzma の linux 版など) のエントリに
`"libc": ["glibc"|"musl"]` を書き足す。npm 10 系はこのフィールドを書かず、`npm install` のたびに
消すので、npm 11 で依存を足した lockfile をコミットすると、以後の worktree で `npm install` するたびに
lockfile が modified になり、無関係な PR に紛れ込む。CI の `npm ci` は lockfile を書き換えないので
このズレに気付けない。`scripts/lockfile-npm-version.test.mjs` が両 lockfile に `libc` が無いことを
検査する。落ちたら npm 10 で lockfile を再生成する — Node 24 以降の同梱 npm は 11 系なので、手元の
Node に依らない次のコマンドが確実 (依存の解決結果は変わらず、`libc` の行だけが消える):

```bash
npx -y npm@10 install --package-lock-only
npx -y npm@10 --prefix web install --package-lock-only
```

Dependabot のセキュリティ更新 PR も lockfile を書き換えるので、将来その npm が `libc` を書くように
なればこのテストで落ちる。その場合も同じコマンドで Dependabot のブランチ上の lockfile を作り直す。

## コミットのパースチェック (`npm run check:commits`)

on each main push, CI scans
`v<last-release>..HEAD` with the same `@conventional-commits/parser` that
release-please uses. If a commit body opens `(` on one line and closes `)` on
the next, the parser fails and release-please silently drops that commit from
CHANGELOG — permanently once the release tag is cut. Fix or hand-restore before
tagging.

`scripts/check-commit-parse.mjs` exposes a `KNOWN_UNPARSABLE` allowlist for
this. The check scans `v<last-release>..HEAD`, so an unparsable commit leaves
the range by itself once the next tag is cut — the list is only for the
temporary window where such a commit sits on `main` and turns every push red.
New occurrences are kept off `main` by the `pull_request` arm of the same job
(`base.sha..head.sha`, bdboard-qhsb), so an entry here covers history that can
no longer be fixed without rewriting `main`.

Entries are objects, not strings, and `recovery` is **required** (bdboard-721p):

```js
{ sha: '<full sha>', subject: '<commit subject>', ticket: 'bdboard-xxxx',
  recovery: '<what to hand-restore before the tag is cut>' }
```

An entry without a usable `recovery` is not honoured — it stays a failure. The
script re-prints every excluded entry's `recovery` on each run under
`=== リリース (タグ生成) の前にやること ===`, so silencing the exit code never
silences the reminder. When the default range is used and an entry matches no
commit in it, the run says so: the tag has been cut and the entry should be
deleted. (The earlier rule "hand-restore the CHANGELOG line *before* adding an
entry" was unenforceable — release-please runs with `always-update: true`
(bdboard-2tch) and regenerates the release PR branch on every `main` push, so a
pre-emptive edit is overwritten. `recovery` replaces it with a condition the
script can actually check.)

Current entry: `5d3be46` (bdboard-ym9r) — its CHANGELOG line must be added to
release PR #258 immediately before that PR is merged. (The original `15651d3`
entry was removed once the `v0.1.2` tag put it out of range — bdboard-r5we,
bdboard-tbgj.)

Not part of `npm run verify` (needs git tags).

### 書いた瞬間に弾く: `scripts/commit-message-guard.mjs` (bdboard-ekj3)

The two CI arms above both find the problem *after* the commit exists, and they
only ever see the **squashed** commit that lands on `main` (the `pull_request`
arm sees `base..head`, but the branch is squashed on merge, so what reaches
`main` is a message nobody has checked in that form). The `PreToolUse(Bash)`
hook registered in `.claude/settings.json` looks at something different: **every
commit written locally**, before `git commit` runs, whatever its type and
whether or not it survives the squash. It pulls the message out of the command
line, runs it through the same `checkCommitMessage()` from
`scripts/check-commit-parse.mjs`, and exits 2 with the offending line, column
and caret. It is not a third copy of the CI check — it watches a different set
of commits.

What actually breaks, and why it is invisible: the parser treats a `(` that
directly follows a word character (`採った(縦積み`) as the start of a *scope*
that has to close before the line ends. Put a single space in front of the same
`(` and it parses fine. Nothing in the rendered message tells the author which
one they wrote, and the cost of getting it wrong is that release-please drops
the commit from the CHANGELOG — permanently, once the tag is cut.

**What the hook denies, and what it deliberately does not.** It denies only
parse failures where the parser was waiting for a closing `)` — the error text
ends in `valid tokens [)]`, which can only happen after a `(` was consumed as a
scope. Of the 40 unparsable commits on `main`, 38 are this class (35 broke at
the newline, 3 at a nested `(` such as `なっている(clear() の…)`). The other two
have a subject that is not conventional at all (`bd/bdboard 3tw.149 (#83)`).
Everything outside the paren class — `wip`, `Revert "…"`, `Merge branch …`,
`fixup!` / `squash!`, an empty message — is **allowed**, with a single warning
line on stderr. The hook is not a conventional-commit style enforcer: someone
who types `wip` knows they typed `wip`, and a guard that sits on every `Bash`
call in every worktree would get an override made permanent, disabling the one
thing it is actually for.

Why the real parser instead of a regex: a lexical "line ends with an unclosed
`(`" rule was measured against all 383 commits on `main` and flagged **198 of
them (52%)** — Japanese bodies wrap parenthetical asides across lines all the
time. The parser rejects 40 (10.4%), of which 38 are the unclosed-paren class.
Only the real parser separates the harmful from the ordinary. That 10.4% is not
the day-to-day firing rate, though: it covers the whole of `main`, including old
history from before the allowlist existed. Over the release range that actually
matters, `v0.1.2..HEAD` (130 commits), only 2 are unparsable (**1.5%**), and one
of those is already allowlisted. Expect this hook to stay silent almost always.

Why not a `commit-msg` git hook: `core.hooksPath` already points at
`.beads/hooks` (beads installs five hooks there). Adding one would mean writing
into a directory `bd init` regenerates and PRs may not touch, or repointing
`core.hooksPath` — which would silently disable all five beads hooks for the
main checkout and every worktree at once, since that config lives in the shared
`.git`. It would also need a per-clone install step.

**Fail-open by design.** The hook allows the command whenever it cannot be sure:
the message comes from a variable or an unrelated substitution; an unquoted
heredoc delimiter means the body still expands; a heredoc is unterminated or a
quote unclosed; `-F -` cannot be tied to exactly one heredoc opened by that same
command; `-F` points at a file it cannot read, is not a regular file, or is over
1 MiB; there is no `-m` / `-F` at all (editor, `--amend --no-edit`,
`git commit -C <sha>`, `cherry-pick`, `rebase` — which is also why replaying an
already-unparsable historical commit never trips it); the parse failure is not
about parens; `@conventional-commits/parser` is not installed yet; stdin is not
valid hook JSON; or anything throws. A guard that blocks commits because it
could not read its own input is worse than no guard.

Known limitation: the hook reads the command line, not the shell's semantics, so
a command that merely *mentions* `git commit -m '<unclosed paren>'` — `echo`, a
grep pattern, a snippet in a doc being written with a heredoc — is denied too.
Separating mention from execution needs shell semantics the tokenizer
deliberately does not have; use the override on the rare occasions it bites.

Escape hatch: `BDBOARD_COMMIT_GUARD_OVERRIDE="<reason>"` as an assignment in the
**same simple command** as `git` — `BDBOARD_COMMIT_GUARD_OVERRIDE="reason" git
commit …` or `env BDBOARD_COMMIT_GUARD_OVERRIDE="reason" git commit …`. A
separate `export …` statement, or `VAR=x && git commit …`, does not reach the
hook, which only sees the one command line it was invoked for. An empty reason
does not count. It is honoured from the environment or from that inline
assignment only — never from anywhere inside the message body, or the denial
text itself (which names the variable) could be pasted into a commit body to
disarm the guard. When it does fire, the hook writes one line to stderr saying
it let an unclosed-paren message through, so the bypass leaves a trace.
