# 検証 (Build & Test) の詳細

AGENTS.md「Build & Test」から分離した詳細。**`npm run verify` を回す前に読む必要は無い** —
必要になるのは次のときだけ:

- 個別の tsc プロジェクト構成を触る / 新しい設定ファイルを足す（下の「tsc プロジェクトの表」）
- `npm run verify` が待たされている・スロット関連のメッセージが出た（下の「Verify slots」）
- ローカルの起動 (`npm run start` / `dev` / `dev:web`) の違いを確認したい
- e2e を足した・変えた / verify が通ったのに e2e がどうなったか分からない（下の「e2e は verify に含まれない」）
- ローカルの `npm run check:commits` が exit 1 なのに CI の commit-parse は緑（下の「ローカルが exit 1 なのに…」）
- `npm run check:file-size` が落ちた・巨大ファイルを足した/育てた（下の「ファイルサイズガード」）

AGENTS.md 側に残っている 1 行要約と食い違ったら、**この文書が詳細の正**。ただし slot の実装挙動は
`scripts/verify.mjs` / `scripts/verify-slot.mjs` が正で、この文書はその要約。

## 全体

コミット前 (server / web どちらの変更でも) に、フル検証チェーンをクリーンに通すこと:

```bash
npm run verify   # check:file-size + lint + build (server tsc) + build:web (web tsc + vite build) + test:server + test:web + check:boundaries
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
npm run check:file-size  # git ls-files 対象のファイル行数ガード (baseline との突き合わせ)
npm run lint             # ESLint + typescript-eslint (src/ web/src/ scripts/、max-lines はラチェット許可リスト)
npm run build            # tsc --noEmit x3 (src/, vitest.config.ts, test/e2e/)
npm run build:web        # web tsc --noEmit x2 + vite build
npm run test:server      # vitest run (src/)
npm run test:web         # vitest run (web/src/)
npm run check:boundaries # dependency-cruiser (architecture layering)
```

## ファイルサイズガード (`npm run check:file-size`)

**趣旨: 行数そのものが目的ではない。** 1ファイルの行数が既定の目安を超えているのは、
「そのファイルが複数の無関係な変更理由を同居させている」ことの代理指標として扱う。放置すると
巨大ファイルが並行 PR の衝突点になり続ける (この節を追加した bdboard-jygp の調査時点で、直近
120 コミットの変更回数上位はそのまま行数上位と一致していた)。超えたときにやることは2つに1つ:
**ファイルを分割する**か、**理由を書いて baseline に登録する**。理由を書かずに黙って通す抜け道
は用意していない (`--update-baseline` のような自動書き換えフラグは無い)。

対象は `git ls-files --cached --others --exclude-standard`（ファイルシステム走査ではない。
`node_modules` / `web/dist` 等は `.gitignore` 経由で自然に除外され、`git add` 前の新規ファイルも
拾う）で `src/` `web/src/` `scripts/` `harness/` `test/` 配下の `.ts` `.tsx` `.mjs` `.js` `.css`
`.sh` を集める。`fixtures/` 配下と生成物は対象外。

**ESLint との住み分け (bdboard-sso1.8)**: `src/` `web/src/` `scripts/` 配下の `.ts`/`.tsx`/`.mjs`/`.js`
の行数上限は `npm run lint` (`eslint.config.mjs` の `max-lines` + `MAX_LINES_ALLOWLIST`) に一本化した
— この3ディレクトリではそれらの拡張子はこのガードの対象外になる。このガードはそれ以外
(`web/src/index.css` のような ESLint が見ない拡張子)、および `harness/` (ESLint の `ignores`
対象) と `test/` (ESLint の lint 対象外) の全拡張子を引き続き見る。

既定上限・baseline (登録済みファイルの個別上限と理由) は両方とも
[`scripts/file-size-baseline.json`](../scripts/file-size-baseline.json) に置き、スクリプト本体
(`scripts/check-file-size.mjs`) には数値を埋め込まない。並行 PR がファイルを少し育てても、
baseline の limit は現行行数に 200 行の余白を足した上で 100 行単位で切り上げた値にしてある
(既定 100 行の余白は、行数が多い方から見て高頻度に更新されるファイルでは1コミットの純増分
(観測ベースで数十〜100行超) より小さく、頻繁な (b) 再発を招くと判明したため — bdboard-jygp の
レビューで判明。以後 baseline を新規登録・調整する際もこの200行余白を踏襲すること)。
`ratchetWarningThreshold` も同じ理由で既定 400 にしてあり、上記の余白を確保した直後の baseline が
(d) 警告を出さない程度の余裕を持たせてある。

判定は4種類:

| 記号 | 条件 | 結果 |
|---|---|---|
| (a) | baseline に無いファイルが既定上限 (非テスト 500 行 / テスト `*.test.*`・`*.spec.*` 1500 行) 超 | fail — 分割するか、理由を添えて baseline に登録する |
| (b) | baseline にあるファイルが自分の `limit` 超 | fail — 分割するか、`limit` と `reason` を書き換える |
| (c) | baseline にあるのに既定上限以下まで縮んだ、または対象ファイルが見つからない (削除・リネーム・対象ディレクトリ外への移動) | fail — baseline の `entries` から外す |
| (d) | baseline の `limit` が現行行数より `ratchetWarningThreshold` (既定 400) 行以上大きい | warn のみ (exit には影響しない) — ラチェットを締める余地がある通知 |

**baseline エントリの書き方**: `reason` は1ファイルずつ中身を見て書く。「ChatPanel コンポーネント
1関数で約3665行 (449〜4114行目)。分割判断チケット bdboard-78ve は見送りで close 済み」のように、
何が同居しているか・分割の検討状況を書く。同文のコピペは意図的に赤面するような値ではないが、
レビューで指摘対象になる (機械的なテンプレ流用は「実態を見ていない」のと同義)。パスは常に
POSIX 区切り (`/`) で書く — Windows でも git は `/` 区切りでファイルを返すので、baseline 側で
バックスラッシュを使うと `check-file-size.mjs` が形式エラーとして拒否する (`verify-windows`
対策)。行数のカウントは CRLF でも LF でも同じ値になるように正規化してある。
パスは対象ディレクトリ・対象拡張子の範囲内、かつ `fixtures/` 配下でない必要もある —
範囲外のパスを登録すると、走査結果に一度も現れず永久に「対象ファイルが見つからない」(c) 扱いに
なる前に、baseline 読み込み時点で形式エラーとして拒否される (bdboard-ihf6)。

**リネームは自動で引き継がれない。** 旧パスは baseline に残ったまま「見つからないファイル」
(c) として fail し、新パスは baseline 未登録のまま既定上限を超えていれば (a) として fail する
— 両方が赤くなるので、コミット時に確実に baseline を書き直す必要がある。「リネームで大きい
ファイルの行数チェックだけ逃げる」という抜け道は無い。逆に「対象ディレクトリ外 (`src/` 等の
配下から外れる場所) や `fixtures/` 配下へ動かすと対象外になる」のは、このガードのスコープ設計
上の既知の限界であり検知できない — 対象ディレクトリ・拡張子の一覧そのものを変える場合は
`scripts/check-file-size/constants.mjs` の `TARGET_DIRS` / `TARGET_EXTENSIONS`
(入口の `scripts/check-file-size.mjs` が re-export している) を見直すこと。

**並行 PR との衝突**: 複数の PR が同時に同じ大きいファイルを少しずつ育てていると、先にマージ
された側の baseline 更新が後発 PR の rebase 後に (b) を再発させることがある。マージ直前の
rebase 後には必ず `npm run check:file-size` を単体で再実行し、他 PR のマージで limit を超えて
いたら baseline をその時点の実態に合わせ直す。

一覧が欲しいだけなら `npm run check:file-size -- --report` で、baseline の有無を添えた全対象
ファイルを行数降順で表示できる (これは診断用で、pass/fail の判定自体は変えない)。

## e2e は verify に含まれない (`npm run test:e2e`)

`npm run verify` が回すのは build / build:web / test:server / test:web / check:boundaries だけで、
Playwright の e2e は**含まない** (`test/e2e/*.test.ts` の vitest 単体テスト — ポート採番などの補助 — だけは
test:server に入る)。e2e は CI の別ジョブ `e2e` (`npm run test:e2e`) で走り、`verify` /
`commit-parse` と並ぶ required status check になっている ([GIT-WORKFLOW.md](GIT-WORKFLOW.md))。
したがって:

- **「verify が exit 0」は e2e が通った根拠にならない。** e2e の spec を足した・変えた PR、あるいは
  既存 spec が見ている UI (レイアウト・スクロール・ビューポート・フォーカス順など) を変える PR では、
  PR 上の CI `e2e` ジョブが pass していることを根拠にする。手元で先に確かめたいときは
  `npm run test:e2e` を回す (回し方・前提は [test/e2e/README.md](../test/e2e/README.md))。
- **逆に `npm run test:e2e` は型検査をしない。** e2e spec の型エラーは verify 側の `npm run build`
  (上の表の `test/e2e/tsconfig.json` の行) でしか出ない。

e2e については verify と test:e2e が互いの穴を埋める関係なので、e2e を触る変更では両方を見る
(bdboard-wdwa / PR #301 のレビュー指摘)。

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

## vitest worker RPC タイムアウトの既知 flake 判別 (撤去済み)

Vitest 3 では worker → main の RPC (`onTaskUpdate`) の応答待ちが birpc の既定 60 秒で
打ち切られ、テストが全件成功していても `[vitest-worker]: Timeout calling "onTaskUpdate"` が
unhandled error として計上されて verify が非ゼロで落ちることがあった (bdboard-c6nv)。
これを実失敗と見分けるため、リーダーモード (`scripts/verify.mjs --group-leader`) が子の出力を
pipe で溜めて判定する `scripts/verify-flake-detector.mjs` を置いていた (bdboard-8rl8)。

Vitest 4 (bdboard-cd1v で 4.1.11 へ更新) に合わせてこの判別器は撤去した (bdboard-4agr)。
birpc 自体の既定は今も 60 秒だが、`vitest run` が使う worker 側 (`createRuntimeRpc`) と
プール側 (PoolRunner) の birpc には Vitest が `timeout: -1` を明示して渡しており、タイマー自体が
張られない。そのため同じ経路のタイムアウトエラー (Vitest 4 の文言では
`[birpc] timeout on calling "…"`) は起きず、Vitest 3 の文言は Vitest 4 の dist に存在しない。
あわせて、リーダーモードの子 (`npm run verify:steps`) の stdio は判別用の pipe + tee をやめて
`inherit` に戻した。

birpc の外には固定のタイムアウトが残っている (worker の起動・停止待ちの
`[vitest-pool-runner]: Timeout waiting for worker to respond`、ランナー起動待ちの
`[vitest-pool]: Timeout starting … runner.` など)。これらや teardown 時の
`[vitest-worker]: Closing rpc while "…" was pending` で verify が落ちた場合は既知 flake と
みなさず、実失敗として原因を調べる。Vitest を上げて `createRuntimeRpc` / PoolRunner が birpc に
渡す `timeout: -1` が変わったら、この節の前提を見直す。

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

`scripts/check-commit-parse/constants.mjs` exposes a `KNOWN_UNPARSABLE` allowlist
for this (re-exported by the entry point, `scripts/check-commit-parse.mjs`).
The check scans `v<last-release>..HEAD`, so an unparsable commit leaves
the range by itself once the next tag is cut — the list is only for the
temporary window where such a commit sits on `main` and turns every push red.
New occurrences are kept off `main` by the `pull_request` arm of the same job
(`base.sha..head.sha`, bdboard-qhsb), so an entry here covers history that can
no longer be fixed without rewriting `main`.

**Base of the default range when the tag is missing** (bdboard-zoxs): the
default base is the `v<version>` tag for the `"."` version in
`.release-please-manifest.json`. If that tag does not exist, the script falls
back to the commit on `HEAD` that set the manifest to that version — walking
back past later edits that keep the same version (reformatting, a new key), so
the base is never "whatever touched the manifest last". That commit is the one
release-please tags (the release PR's squash commit; true for v0.1.0–v0.1.2), so
the range is identical to `v<version>..HEAD`. It exists for the release race:
merging the release PR pushes `main` with the bumped manifest, and ci.yml's
commit-parse runs in parallel with release-please.yml, which creates the tag
through the API some seconds later (on v0.1.2 the Release appeared ~11s after
both runs started; commit-parse did not exist yet then). Checking out inside
that window would make the job exit 2 and turn `main` red. The fallback is never silent: it prints
`commit-parse: リリースタグ v<version> が見つからないため、… を範囲の起点にします`
before the findings. Exit 2 remains for when neither works: no tag and no
commit with the checked-out manifest version (e.g. the manifest was only edited
locally), or a shallow clone — its oldest commit looks like it added the
manifest, which would silently narrow the range (`git fetch --unshallow --tags`).
Accepted risk: a non-release commit that bumps the version by hand also becomes
the base; the notice prints that commit's subject, so it shows in the log.

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

Not part of `npm run verify` (needs the full git history, and the release tags
for the normal path).

### ローカルが exit 1 なのに CI の commit-parse が緑のとき

ローカルと CI は**見ているコミットの範囲が違う**ので、結果が食い違うのは異常ではない。

| 実行のしかた | 範囲 | 何が入るか |
|---|---|---|
| ローカルで引数なし `npm run check:commits` | `v<last-release>..HEAD` (版はチェックアウト中の `.release-please-manifest.json` から。タグが手元に無ければ manifest をその版に上げたコミット`..HEAD` — 同じ範囲) | 自分のブランチのコミット**と**、ブランチの土台に含まれる `v<last-release>` 以降の `main` のコミット |
| CI の `pull_request` 分岐 | `base.sha..head.sha` | その PR が足すコミットだけ |
| CI の `push` 分岐 (main) | `v<last-release>..HEAD` (リリース PR マージ直後でタグ未作成なら manifest を上げたコミット`..HEAD` — 同じ範囲、bdboard-zoxs) | `main` 上のリリース以降の全コミット |

そのため、ローカルでは `main` 由来の解析不能コミットまで拾って exit 1 になるが、PR の
commit-parse は緑、ということが起きる。実例は bdboard-z7ah / PR #367: ローカルの exit 1 の原因は
既に `main` にあった `5d3be46` (PR #260, `feat`) で、当時は `KNOWN_UNPARSABLE` が空だった。PR の
commit-parse は緑だった。`5d3be46` はその後 bdboard-721p / PR #372 で allowlist に入った。

exit 1 を見たら、「CI が赤くなるかも」と判断する前に次の順で切り分ける (委譲先がそう報告してきた
ときも同じ):

0. **先に `git fetch origin --tags` する。** 以下はどれも `origin/main` とリリースタグが手元で
   最新であることを前提にしている。
1. **exit code と、どの見出しの下に出たかを確かめる。** exit 1 の原因は
   `CHANGELOG から落ちる解析不能コミットが N 件あります:` の下に並んだコミットだけ
   (CHANGELOG 対象の型 — feat / fix / perf / revert / deps か `!` 付き — で allowlist に無いもの)。
   `参考 — CHANGELOG 対象外の…` の下の行は exit code に効かないので、手順 2 に渡すのは前者の sha。
   exit 2 は範囲自体を作れなかったとき (リリースタグも、manifest をその版に上げたコミットも
   見つからない、タグが無いうえ shallow clone、`--range` の ref が解決できない等)。タグが無いだけなら exit 2 にはならず、
   `…を範囲の起点にします` の通知を出して manifest を上げたコミットから調べる (bdboard-zoxs)。
2. **flag されたコミットが自分のものか確かめる。**
   `git merge-base --is-ancestor <sha> origin/main && echo main由来` が `main由来` を出せば、
   そのコミットは既に `main` にあり、この PR の責任ではない (直すのは `main` 側の話で、
   上の `KNOWN_UNPARSABLE` の運用に乗る)。
3. **CI の PR 分岐とほぼ同じ範囲で回し直す。**
   `npm run check:commits -- --range origin/main..HEAD` が exit 0 なら、PR の commit-parse も緑に
   なる。ここで flag されたコミットは自分のものなので、メッセージを直す。CI が見るのは
   `base.sha..head.sha` なので、手元の HEAD と PR に push した head が違う (未 push・amend 後) と
   結果もずれる。

別 PR のブランチに積んだブランチでは、土台の PR が squash マージされても元のコミットは
`origin/main` の祖先にならない (squash で別の sha になる)。そのため手順 2 で main 由来と判定されず、
手順 3 の範囲にも残る。`git rebase --onto origin/main <旧土台>` で外してから手順 3 を回す。

### 書いた瞬間に弾く: `scripts/commit-message-guard.mjs` (bdboard-ekj3)

The two CI arms above both find the problem *after* the commit exists, and each
checks a different range. The `pull_request` arm scans `base.sha..head.sha`,
the PR branch's own pre-squash commits exactly as authored; because this repo
keeps 1 PR = 1 commit, that message is normally what will land on `main` too,
so this arm normally checks the to-be-merged message before it lands
(bdboard-qhsb). It has a gap the `push` arm then closes: on a multi-commit
branch the squash subject becomes the PR title (or whatever is typed on the
merge screen), not any individual branch commit, and a commit that reaches
`main` without a PR (the sole exception in docs/GIT-WORKFLOW.md, a CI-recovery
commit) skips the `pull_request` arm entirely — both surface only once the
`push` arm scans `v<last-release>..HEAD` after the fact. The `PreToolUse(Bash)`
hook registered in `.claude/settings.json` looks at something earlier than
either arm: **every commit written locally**, before `git commit` even runs —
before a PR exists, before anything is pushed, whatever its type, and whether
or not it survives a later squash. It pulls the message out of the command
line, runs it through the same `checkCommitMessage()` from
`scripts/check-commit-parse.mjs`, and exits 2 with the offending line, column
and caret. It is not a third copy of the CI check — it catches problems before
either CI arm runs, regardless of commit type or whether a PR exists yet.

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
