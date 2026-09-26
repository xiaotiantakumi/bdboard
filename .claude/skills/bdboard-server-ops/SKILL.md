---
name: bdboard-server-ops
description: bdboard の常時稼働ローカルサーバー (メインチェックアウト・BDBOARD_PORT 既定 8787) の起動確認・起動・再起動・停止判断が要るときに読む。ヘルスチェックが 000 だった / リスナーは居るのに応答しない / マージ後にサーバーを作り直す / worktree から preview_start・npm run dev を打ちたくなった / web だけ変わったマージで再起動を省きたくなった / 再起動後の health 確認をループで待つ / cloudflared トンネルが同居している、のいずれかに当たったらこの skill の手順に従う。再起動の唯一の入口 scripts/always-on-server.sh (議長のみ・BDBOARD_SERVER_CALLER=chair 宣言・--expect-pid の CAS・cloudflared 確認・監査ログ) と、サブエージェントの main checkout での pull/start/Edit を止める isolation:"worktree" と kill を止める permissions.deny の説明、pkill・killall によるパターンマッチ kill の禁止理由もここ。
---

# bdboard-server-ops — 常時稼働ローカルサーバーの運用

The main checkout (the repository root checkout, not worktrees) must be serving the board on
localhost whenever an agent session is active. Default port: `BDBOARD_PORT`
(8787). This is an agent operational rule, not an OS daemon — do NOT create a
launchd plist or any persistent daemon for this; if true 24/7 hosting is ever
wanted, that is a separate, explicitly user-approved change.

## 再起動の入口は `scripts/always-on-server.sh` (議長だけ)

2026-09-20 に、PR をマージしたサブエージェントが「マージ後に再起動」の手順どおり main
checkout を pull し 8787 を kill・再起動する事故が 3 件続いた (bdboard-hpu8)。以来、
**サーバーを止める・起こす・作り直す操作はすべてこのスクリプト経由で、議長 (トップレベル
セッション) だけが行う**。下の各節の手動手順は「スクリプトが何をしているか」の参照であり、
手で真似る手順ではない。スクリプトで止められないときは手で止めない — ユーザーに PID と
理由を伝え、ユーザー自身の端末で止めてもらう（下の「スクリプトで対処できない場面」参照）。

```bash
scripts/always-on-server.sh status                         # 誰でも可: PID / HEAD / health / cloudflared
BDBOARD_SERVER_CALLER=chair scripts/always-on-server.sh deploy  --expect-pid <PID>   # マージ後: pull → (install) → build:web → 必要なら再起動
BDBOARD_SERVER_CALLER=chair scripts/always-on-server.sh restart --expect-pid <PID> [--pull] [--verify]
BDBOARD_SERVER_CALLER=chair scripts/always-on-server.sh start                        # 000 (停止) のときだけ
```

- `BDBOARD_SERVER_CALLER=chair` は身元の証明ではなく**宣言と監査**。bdboard-worker は
  `isolation: "worktree"` で隔離されているため、Command working
  directory / Git redirects のチェックでそもそも main checkout を cwd や対象にできず、
  このスクリプト実行・main checkout での `git pull` / `npm run start` に到達しない。
  listener PID の直接 `kill` は `permissions.deny` (`Bash(kill *)` 等) が全エージェントで拒否する。
  bdboard-worker による main checkout 対象の `git checkout`/`commit`/`reset`/`merge`/
  `stash` 等と Edit/Write は、同じ `isolation: "worktree"` の Git redirects / File edits
  チェックが塞ぐ。cursor-implementer / codex-implementer / general-purpose など非隔離の子は
  これらを機械的には止められず、文書の規律のみ — bdboard-cm2q.10 で旧 hook 規則 7/8 (`server-guard.sh`) から移した
  (bdboard-kxqb・bdboard-hpu8)。動機・詳細は `hooks/README.md`「deny・隔離・merge-pr との
  分担」を参照。
- `--expect-pid` は `status` で見た PID を渡す。実際の listener と一致しなければ exit 3 で
  何もしない (別セッションが直前に再起動した新プロセスを巻き込まない CAS)。
- cloudflared が動いていれば exit 2 で止まる。ユーザーへ「トンネル URL が失効する」と伝えた
  うえで `--tunnel-ack` を付けて再実行する (下の「cloudflared トンネルの同居確認」)。
- 実行のたびに `/tmp/bdboard-server-restarts.log` に 1 行 (時刻 / action / caller / 旧→新 PID /
  HEAD / 結果) が残る。`permissions.deny` / `isolation: "worktree"` による拒否には専用の
  ログファイルが無く、トランスクリプトにしか残らない (bdboard-cm2q.10 で旧 hook 側の
  `${TMPDIR:-/tmp}/bdboard-server-guard.log` を廃止)。
- worktree の cwd から呼んでよい。main checkout は git common dir から解決する
  (`cd` しない — 常時稼働サーバーの居場所へ作業を移さない)。
- **相対パス呼び出し (`scripts/always-on-server.sh ...`) は議長の cwd が古い worktree でも
  安全 (bdboard-9nah)。** スクリプトは起動直後、自分の置き場所が git common dir から解決した
  main checkout の `scripts/` と一致するかを確認し、一致しなければ (=古い worktree に取り残された
  版から呼ばれた) main 側の現在の版へ元の引数のまま `exec` し直す。main 側に同名ファイルが
  無いとき (テスト用の使い捨てリポジトリ等) は fail-open で自分のまま続行する。再帰防止と
  テスト用の脱出口は `BDBOARD_SERVER_SKIP_SELF_EXEC=1`。
- `--dry-run` は何もせず手順を表示する。手順の詳細は `scripts/always-on-server.sh --help`。

サブエージェントとして作業していて再起動が必要になったら、**最終報告に「議長で再起動が必要
(PR #N)」と書いて終える**。自分で pull・kill・start を試みない (hook に止められる)。

### スクリプトで対処できない場面

次の場面は `scripts/always-on-server.sh` では対処できない。手で kill/start しない —
ユーザーに listener PID と状況を伝え、**ユーザー自身の端末で**止めてもらってから
`status` で確認し、必要なら `start` する。

- **listener が2つ以上ある**: `--expect-pid` は1つの PID しか受け取れない。
- **`port-still-bound`**: 停止後も port が解放されない (下の「再起動後の health 待ち」
  手順1・「失敗時の終了コード」参照)。
- **main checkout に壊れたスクリプトが入った**: `scripts/always-on-server.sh` 自身が
  動かない、または誤動作する。

## セッション開始時のヘルスチェック

- **At session start**: check the server with

  ```bash
  curl -sS -o /dev/null -w '%{http_code}\n' --max-time 5 http://localhost:8787/api/health
  ```

  **Judge by the status code, not by curl's exit status.** Local direct
  requests bypass Basic auth, so a healthy server answers **200** regardless
  of whether auth is configured. A **401/503** still proves an HTTP server is
  listening but means the request was not classified as local direct access;
  investigate Host/proxy configuration instead of starting a second server.
  Do **not** use `curl -f`, because it hides the response body/status distinction.

  Only a **connection failure** means the server is down: curl prints `000`
  and exits 7. In that case start it with
  `BDBOARD_SERVER_CALLER=chair scripts/always-on-server.sh start` — from the
  chair, from any cwd (the script resolves the main checkout itself, so a
  worktree session does not need to `cd` anywhere first). Do not use
  `preview_start` or a hand-typed `nohup npm run start`; see the
  `preview_start` entry below for why `preview_start` specifically must
  never run from a worktree.

  Before starting anything, confirm with

  ```bash
  lsof -nP -iTCP:8787 -sTCP:LISTEN
  ```

  A **listening socket that still answers nothing** is the known SIGTERM
  quirk, not a dead server: with an SSE client attached, `server.close()`
  never drains, so the listener closes while the process keeps running and
  holds the port. Recovery there is the chair running
  `BDBOARD_SERVER_CALLER=chair scripts/always-on-server.sh restart --expect-pid <PID>`
  (`<PID>` from `status`) — it terminates the stuck process, force-stopping it
  after a 10 s budget if the drain never finishes, then starts fresh and
  confirms health on a new PID; starting a second server would just fail to
  bind. If `lsof` prints nothing, the port really is free and it is safe to
  start.

## Never call `preview_start` from a worktree session

**Never call `preview_start` from a worktree session** (measured
2026-08-29). `preview_start {name: "start"}` resolves
`.claude/launch.json` relative to *the session's* cwd, and that file is
tracked, so every worktree has one. From a worktree it therefore runs
`npm run start` **in the worktree**, which binds port 8787 — the main
checkout's port. What gets served then depends on that worktree, because
`webDistDir` is resolved by `resolveWebDistDir()` from the executing
`src/main.ts`'s `repoRoot` (derived from `import.meta.url`) — i.e. from
*which checkout's `src/main.ts` is executing*. Session cwd is the upstream
cause (it picks which `src/main.ts` runs via `npm run start` resolving
`package.json`), not a direct input to static file resolution; `serveStatic`
receives an absolute path. `BDBOARD_WEB_DIST`, if set, overrides the default
`<repoRoot>/web/dist`.

- **A worktree that has never run `npm run build:web`** (a fresh one, or
  one whose `npm run verify` has not finished) has no `web/dist`, so the
  server logs `web/dist not found; serving API only`. `/api/health`
  answers **200** and `/` answers **404**.
- **A worktree that has run `npm run verify`** does have a `web/dist`
  (`web/dist/` is gitignored but `build:web` writes it), so it serves
  **that branch's stale UI**. Both `/api/health` and `/` answer **200**.
  This is the common case, not the exception: verify is mandatory before
  opening a PR, so most worktrees have a `web/dist` — measured 2026-08-29,
  9 of 12.

So **status codes alone cannot detect this.** The 200/404 pair catches only
the first case; the second looks completely healthy while serving a board
built from someone else's branch. The reliable check is the startup log
line:

```
Serving static web UI from <path>/web/dist
```

If that path is not the main checkout, the wrong server is running
(`lsof -p <pid> -d cwd` answers the same question for an already-running
process).

From a worktree, use the script instead of a hand-typed start — it resolves
the main checkout on its own, so which checkout's `src/main.ts` runs (and
therefore which `web/dist` is served) is never in question:

```bash
BDBOARD_SERVER_CALLER=chair scripts/always-on-server.sh start
```

(Startup logs go to `/tmp/bdboard-server.log`, truncated on every restart —
save a copy first if you need to keep an earlier run's output.)

A separate, independently-possible failure was seen just before this one:
`preview_start` returned a serverId, but the port answered **connection
refused**, `lsof` showed no listener, and the entry had vanished from
`preview_list`. That is a different symptom — a listener that never came
up, versus one that is up and serving the wrong thing — and is best
explained as a startup race (the success reply arriving before the bind
completes). Retrying can plausibly help there; it cannot help with the
worktree-cwd case above, where every attempt reproduces (2/2).

## ブラウザのタブは生存証明にならない

- **Do not trust the opened browser tab as proof the server is up.** A tab
  left over from an earlier load can still render a fully populated board
  (from cache/bfcache) with only a quiet "disconnected" badge as the tell,
  which looks like a working app at a glance. Verify liveness by `curl`
  status codes (and `lsof`), never by what the tab shows.

## マージ後の再起動

- **After merging a PR into main** (right after the fast-forward in the Git
  Workflow cleanup) the chair runs
  `BDBOARD_SERVER_CALLER=chair scripts/always-on-server.sh deploy --expect-pid <PID>`,
  which runs this sequence: `git pull --ff-only` → `npm install` /
  `npm --prefix web install` if lockfiles changed → `npm run build:web` if
  `web/`, `docs/help-content.json`, or `package.json` changed (or
  `web/dist/index.html` is missing) → restart the listener if the diff is
  relevant (see below) → wait for health as described in the next section.
  `npm run start` runs tsx without watch and serves a static `web/dist`, so
  neither server nor UI changes are picked up without this rebuild+restart.
  **This includes merges that change only `web/`** — see
  "web だけの変更でも再起動が要る" below for the measurement.
  - **After `deploy`, also bring the chair's own session checkout up to
    date** (bdboard-flpp): `deploy` updates the main checkout, not the
    worktree the chair session was started in, and hooks are read from the
    latter for the chair and every subagent. Follow the command that the
    `worktree-freshness.sh` warning prints (usually
    `git -C <chair checkout> merge --ff-only origin/main`); it never runs on
    its own. Details: docs/GIT-WORKFLOW.md "Cleanup after merge".
  - **The restart step is conditional; the pull/install/build steps each
    have their own, separate change-detection** (they are not simply
    unconditional). `deploy` restarts the listener only when
    `scripts/deploy-changed.sh`'s `DEPLOY_RESTART_PATHSPEC` /
    `deploy_relevant_changed` finds a non-test-only diff under `src/`,
    `web/`, `docs/help-content.json`, `package.json`, `package-lock.json`,
    or `.env` between the old and new `HEAD` (test files, `__fixtures__/`,
    and `*test-support*` paths are excluded — bdboard-cdoj; `.env` is
    gitignored so in practice it never appears in this diff — a local
    `.env`-only edit still needs a manual `restart`). Before bdboard-kpim,
    `web/` and `docs/help-content.json` were missing from that pathspec, so
    a `web/`-only or `docs/help-content.json`-only merge left the old
    process — and its startup-cached `web/dist/index.html`
    (`src/bootstrap/wire-feature-routes.ts`) / chat help text
    (`src/infrastructure/chat/help-content.ts`) — running.
    `docs/help-content.json` is also bundled directly into the web UI
    (`web/src/helpContent.ts` imports it), so the `build:web` gate covers
    it too, not just the restart gate.
  - **A `git pull --ff-only` here can be blocked by an uncommitted local
    diff to `.claude/bdboard-packs.json`** (measured 2026-08-29, bdboard-8okb):
    `Your local changes to the following files would be overwritten by
    merge`. The always-on server appears to self-heal a stale injected-pack
    version/timestamp in that file at runtime, without going through git —
    the file's mtime lined up exactly with the server's own uptime, not with
    any manual edit. Before discarding, run `git diff -- .claude/bdboard-packs.json`
    and confirm the local diff really is only a `version`/`injectedAt`
    value change consistent with the pack files already on disk (not
    something else). If so, it's safe to `git checkout -- .claude/bdboard-packs.json`
    and retry the pull — the incoming commit's value supersedes it. If the
    diff looks like anything other than that, stop and investigate instead
    of discarding.

## 再起動後の health 待ち

再起動・作り直しは常に `scripts/always-on-server.sh restart`（マージ直後は `deploy`）に任せる
— 議長のみ、`--expect-pid <status で見た PID>` が必須。以下はスクリプトが内部で何をして
いるかの参照であり、手で真似る手順ではない: "止めた直後" と "健康" の間には2つの罠があり
(待ちゼロで判定を早まる／ステータスコードだけで判定して早まる)、スクリプトはその両方を
避ける形で書かれている。

0. **cloudflared の同居確認を先に** — `pgrep -x cloudflared`（下の「再起動の前に」節）。動いて
   いればスクリプトも `--tunnel-ack` 無しでは exit 2 で止まるが、ユーザーへの警告はその前に
   出す。

1. **停止と生存確認**: スクリプトは対象 PID (`--expect-pid` で CAS 済み) に TERM を送る。
   `src/interface/http/graceful-shutdown.ts` の `drain()` (watcher / tunnel / cache cleanup)
   が終わるまで `server.close()` は呼ばれないため、この間は旧プロセスがまだ `/api/health` に
   **200 を返し続ける** (測定: 2026-09-13、#466 マージ直後。kill 直後の health poll が死に
   つつある旧プロセスから 200 を受け、成功と誤判定した — `lsof` はその後で listener 無しを
   示し、新 PID は約5秒後にようやく listen し始めた)。最大 10 秒（スクリプト側の固定値。
   アプリの `BDBOARD_SHUTDOWN_TIMEOUT_MS` とは連動しない）待って消えなければ強制停止し、
   port の解放も確認する (解放されなければ `port-still-bound` で止まる — 下の「失敗時の
   終了コード」参照)。強制停止しても消えない場合は SSE drain の話ではない —
   `bdboard-3tw.91` のタイムアウト経路は `closeAllConnections()` を呼んで確定的に終わる
   ため、それより長く生き残るのはイベントループの詰まりを疑う。restart する前に
   `/tmp/bdboard-server.log` を退避する (スクリプトは起動時にログを空にする)。LISTEN が
   残っていれば restart で対処し、LISTEN だけ閉じてプロセスが生きているなら `status` が
   not listening と示すので、上の「スクリプトで対処できない場面」に従ってユーザーに止めて
   もらう。生存確認を自分の手で行いたいとき (例: スクリプト実行中の別ターミナルからの様子見)
   は `ps -p <pid> >/dev/null 2>&1; echo $?` (`0` = まだ生きている) を使う — `kill -0` と
   同じ判定だが `permissions.deny` の kill 系パターンには当たらない。
2. **起動して health を待つ**: 新しい `npm run start` を起動し、`/api/health` が **200**
   になるまで待つ (0.5 秒間隔で最大 60 回 = 30 秒。この間 PID は見ない)。200 になった、
   またはタイムアウトしたその時点で listener PID を1回だけ取得し、旧 PID と異なるかを
   確認する — ステータスコードだけでは手順1の偽陽性 200 を拾ってしまうため、この一度きりの
   PID 比較が要る。冷起動の実測は 15 秒 (2026-09-13、並列 verify 実行下、bdboard-pkr6.22.5)。
   30 秒を過ぎても `000`/非200 なら `/tmp/bdboard-server.log` を読み、
   `lsof -nP -iTCP:8787 -sTCP:LISTEN -t | wc -l` で複数リスナーが無いか数える。勘でもう1つ
   起動しない — 2026-09-05 には待ちゼロのリトライが即座に「成功」と誤判定し、裏で本来の
   サーバーが数秒後に正常起動していたところへ2つ目の `npm run start` を重ね、
   `/tmp/bdboard-server.log` を空にした直後に `EADDRINUSE` で落ちた実例がある。
3. **起動ログの確認**: `Serving static web UI from <main checkout>/web/dist` が出ているかを
   スクリプトが確認する (出ていなければ別 checkout から起動した可能性の警告を出す)。

失敗時の終了コード (詳細は `scripts/always-on-server.sh --help`): `3` = `--expect-pid`
不一致、`4` = `BDBOARD_SERVER_CALLER` 未宣言 — いずれも旧プロセスは無傷。

`2` (前提不成立) は2種類ある:
- **停止前の失敗** — トンネル稼働・ロック中・`pull` 失敗・`install` 失敗・`build:web`
  失敗・`--verify` の赤。この場合サーバーは無傷 (旧プロセスがまだ動いている)。
- **停止後の失敗** — `port-still-bound`・health 不通・pid 不変。この場合**旧プロセスは
  既に止まっている**。新しいプロセスが起動中の可能性もある。手でもう一度 `start` しない
  — まず `status` を見直し、`/tmp/bdboard-server.log` を読む。起動中らしければ待ち、それ
  でも上がらなければ上の「スクリプトで対処できない場面」に従ってユーザーに伝える。

## web だけの変更でも再起動が要る

- **A web-only merge needs `npm run build:web` *and* a restart.** Rebuilding
  without restarting leaves the server half-updated, and the half that stays
  stale breaks the page rather than showing an old one. Measured
  2026-09-13 in a worktree on test port 18787 (bdboard-pkr6.22.5): build,
  start, then add a probe line to `web/src/main.tsx` and rebuild, which
  changed the JS asset from `index-5wcYSvcy.js` to `index-BRjlTLQz.js`
  (CSS `index-B9YzvpfB.css` unchanged).

  | Request | after rebuild, no restart | after restart |
  | --- | --- | --- |
  | `/`, `/index.html`, `/?probe=1` | new `index-BRjlTLQz.js` | new |
  | `/pkr6-probe/deep/link` (any non-API path with no file in `web/dist`) | **old `index-5wcYSvcy.js`** | new |
  | `/assets/index-5wcYSvcy.js` (the old asset) | **200 `text/html`** (index HTML) | still `200 text/html`, but no longer referenced |
  | `/build-meta.json` | new `builtAt` | new |

  The split comes from `src/main.ts`: `serveStatic` reads `web/dist` from
  disk on every request, so `/`, `/index.html` and every real file are
  fresh; every other non-API path falls through to the SPA fallback, which
  returns `spaIndexHtml` — `web/dist/index.html` read **once at startup**.
  And because `vite build` empties `web/dist` first, the old asset that
  stale HTML points to no longer exists, so its request *also* falls
  through to the fallback and comes back as `200 text/html`. A browser
  refuses to run a `text/html` response as a module script, so a non-root
  URL should render blank (inferred from that MIME mismatch; the
  measurement used curl, not a browser) — while `/api/health` and `/` both
  look perfect.

- **Why this was believed unnecessary**: the evidence was that
  `/build-meta.json` served the new sha after `build:web` alone. That
  file goes through `serveStatic`, i.e. the half that *is* fresh, so it
  cannot show whether the startup-cached HTML is stale. Neither can a
  check of `/`. Docs-only merges are not exempt either:
  `src/infrastructure/chat/help-content.ts` reads `docs/help-content.json`
  once at module load for the chat system prompt, so a help change reaches
  chat only after a restart.
- **Why normal use rarely hits it**: the board's deep links are hash-based
  (`/#…`), so the browser requests `/`. Any URL with a real path — typed by
  hand, an old bookmark, a link from elsewhere — still gets the stale HTML.
  That is enough to keep the rule simple: restart after every merge, and
  let SSE clients reconnect.

## 再起動の前に: cloudflared トンネルの同居確認

- **Before restarting the server**, check whether a tunnel is running with

  ```bash
  pgrep -x cloudflared
  ```

  **`-x` (exact match on the process name), not `-f`.** `-f` matches the whole
  command line, so it also fires on any process that merely *mentions*
  cloudflared — and the project rules require every delegation brief to carry the
  "do not start a cloudflared tunnel" prohibition, so a brief sitting in a
  child agent's argv matches. That makes `-f` misfire precisely while parallel
  delegation is running, which is most of the time (measured 2026-09-04,
  bdboard-e761: it reported a tunnel when none existed; the match was a
  delegated agent's own brief. Reproduced deliberately the same day — a
  `python3` process carrying that text in its argv is matched by `-f` and not
  by `-x`).

  The misfire is safe-side (it claims a tunnel might exist when none does), but
  it is not harmless: it produces a false "restarting will kill your tunnel"
  warning, and skipping the restart on that basis leaves the always-on server
  serving a stale post-merge build. Worse, once the check is known to cry wolf
  it starts getting ignored, which fails in the *unsafe* direction.

  If it is running, tell the user first that restarting will
  kill the tunnel child process and invalidate the current trycloudflare.com
  URL — quick tunnels get a new subdomain each time, so a phone-side reload
  will not recover access and the QR code must be scanned again. After
  restart, offer to start a new tunnel only if the user wants one (starting a
  tunnel is an explicit public-exposure action; agents must not start one
  unilaterally). On the next boot the board shows that the previous session
  ended while a tunnel was active (bdboard-8v8), but that post-hoc notice is
  not a substitute for this advance warning. See bdboard-8v8.

## 停止・kill の禁止事項

- **Never kill the server** except for that post-merge restart (or an explicit
  user request), and then only through `scripts/always-on-server.sh` from the
  chair. `permissions.deny` (`Bash(kill *)` / `Bash(pkill *)` / `Bash(killall *)`)
  は直接 `kill` を呼び出し元を問わず deny する (bdboard-cm2q.1)。旧 hook 規則 7
  (`server-guard.sh`、bdboard-cm2q.10 で削除) は `$(lsof … 8787 …)` や変数・パイプ経由で
  port から引いた PID の kill もリスナーの親 (npm / node) まで含めて追跡していたが、
  deny はコマンド行の文字列一致だけなのでその変数・パイプ追跡は無い (`hooks/README.md`
  「守らないもの」参照)。スクリプトで止められないとき (上の「スクリプトで対処できない場面」
  参照) も、議長は手で止めない — ユーザーに PID と理由を伝え、ユーザー自身の端末で止めてもらう。
- Kill には **pkill / killall 等のパターンマッチ kill を使わない** —
  worktree のテスト用プロセスを狙った `pkill -f 'tsx.*src/main.ts'` がこの常時稼働
  サーバーにも当たった実例がある。必ず対象の PID を特定して `--expect-pid` に渡すこと
  （委譲ブリーフにも毎回この禁止を明記する）。

## この規約が支えているもの

- This rule is the guarantee behind three existing conventions: worktrees must
  not run `npm run dev` (the port belongs to the main checkout — see
  `docs/GIT-WORKFLOW.md`) and must not call `preview_start` (which runs
  `npm run start` there, taking the same port — see above), and
  `npm run dev:web` in a worktree works because its Vite proxy targets this
  always-on server at `127.0.0.1:8787`. The mobile tunnel
  (mobile-preview-tunnel skill) also points at this server, so tunneling
  needs no separate server-start step — just the health check.
