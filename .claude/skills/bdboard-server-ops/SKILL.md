---
name: bdboard-server-ops
description: bdboard の常時稼働ローカルサーバー (メインチェックアウト・BDBOARD_PORT 既定 8787) の起動確認・起動・再起動・停止判断が要るときに読む。ヘルスチェックが 000 だった / リスナーは居るのに応答しない / マージ後にサーバーを作り直す / worktree から preview_start・npm run dev を打ちたくなった / web だけ変わったマージで再起動を省きたくなった / 再起動後の health 確認をループで待つ / cloudflared トンネルが同居している、のいずれかに当たったらこの skill の手順に従う。再起動の唯一の入口 scripts/always-on-server.sh (議長のみ・--expect-pid の CAS・cloudflared 確認・監査ログ) と、サブエージェントの pull/start/kill を止める hook 規則 7 の説明、pkill・killall によるパターンマッチ kill の禁止理由もここ。
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
セッション) だけが行う**。下の各節の手動手順は「スクリプトが何をしているか」の参照と、
スクリプトが使えないときの `BDBOARD_SERVER_OVERRIDE="<理由>"` 付きの例外手順である。

```bash
scripts/always-on-server.sh status                         # 誰でも可: PID / HEAD / health / cloudflared
BDBOARD_SERVER_CALLER=chair scripts/always-on-server.sh deploy  --expect-pid <PID>   # マージ後: pull → (install) → build:web → 必要なら再起動
BDBOARD_SERVER_CALLER=chair scripts/always-on-server.sh restart --expect-pid <PID> [--pull] [--verify]
BDBOARD_SERVER_CALLER=chair scripts/always-on-server.sh start                        # 000 (停止) のときだけ
```

- `BDBOARD_SERVER_CALLER=chair` は身元の証明ではなく**宣言と監査**。hook 規則 7 が
  サブエージェント (hook 入力に `agent_id` がある) からのこのスクリプト実行・main checkout
  での `git pull` / `npm run start`・listener PID の `kill` を deny するので、宣言を書き写しても
  サブエージェントからは通らない。
- `--expect-pid` は `status` で見た PID を渡す。実際の listener と一致しなければ exit 3 で
  何もしない (別セッションが直前に再起動した新プロセスを巻き込まない CAS)。
- cloudflared が動いていれば exit 2 で止まる。ユーザーへ「トンネル URL が失効する」と伝えた
  うえで `--tunnel-ack` を付けて再実行する (下の「cloudflared トンネルの同居確認」)。
- 実行のたびに `/tmp/bdboard-server-restarts.log` に 1 行 (時刻 / action / caller / 旧→新 PID /
  HEAD / 結果) が残る。hook 側の deny は `${TMPDIR:-/tmp}/bdboard-server-guard.log`。
- worktree の cwd から呼んでよい。main checkout は git common dir から解決する
  (`cd` しない — 常時稼働サーバーの居場所へ作業を移さない)。
- `--dry-run` は何もせず手順を表示する。手順の詳細は `scripts/always-on-server.sh --help`。

サブエージェントとして作業していて再起動が必要になったら、**最終報告に「議長で再起動が必要
(PR #N)」と書いて終える**。自分で pull・kill・start を試みない (hook に止められる)。

## セッション開始時のヘルスチェック

- **At session start**: check the server with

  ```bash
  curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:8787/api/health
  ```

  **Judge by the status code, not by curl's exit status.** Local direct
  requests bypass Basic auth, so a healthy server answers **200** regardless
  of whether auth is configured. A **401/503** still proves an HTTP server is
  listening but means the request was not classified as local direct access;
  investigate Host/proxy configuration instead of starting a second server.
  Do **not** use `curl -f`, because it hides the response body/status distinction.

  Only a **connection failure** means the server is down: curl prints `000`
  and exits 7. In that case start it — **from a session whose cwd is the
  main checkout**, prefer the Browser tool's `preview_start` with the `start`
  config in `.claude/launch.json`; otherwise run `npm run start` in the
  background. From a worktree session, neither: see the `preview_start`
  entry below.

  Before starting anything, confirm with

  ```bash
  lsof -nP -iTCP:8787 -sTCP:LISTEN
  ```

  A **listening socket that still answers nothing** is the known SIGTERM
  quirk, not a dead server: with an SSE client attached, `server.close()`
  never drains, so the listener closes while the process keeps running and
  holds the port. Recovery there is `kill -9` → `preview_stop` (to clear the
  stale serverId) → `preview_start`; starting a second server would just fail
  to bind. If `lsof` prints nothing, the port really is free and it is safe to
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

From a worktree, start the server in the main checkout instead — the `cd`
is load-bearing precisely because it selects which checkout's `src/main.ts`
runs (and therefore which `web/dist` is served):

```bash
cd /path/to/main/checkout && nohup npm run start > /tmp/bdboard-server.log 2>&1 &
```

(That log path is truncated on every restart; use a distinct name if you
need to keep an earlier run's output.)

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
  which does exactly this sequence: `git pull --ff-only` → `npm install` /
  `npm --prefix web install` if lockfiles changed → `npm run build:web` →
  restart the server → wait for health as described in the next section.
  `npm run start` runs tsx without watch and serves a static `web/dist`, so
  neither server nor UI changes are picked up without this rebuild+restart.
  **This includes merges that change only `web/`** — see
  "web だけの変更でも再起動が要る" below for the measurement.
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

Two separate traps sit between "kill" and "healthy": a wait with no delay
fails too early, and a wait that only looks at the status code succeeds too
early. The procedure below closes both. Run each step as its own Bash call.

0. **Do the cloudflared check first** — `pgrep -x cloudflared`, see
   "再起動の前に: cloudflared トンネルの同居確認" below. Warn the user
   before step 1 if a tunnel is running.

1. **Record the old PID, then kill it** (the PID, never a pattern):

   ```bash
   lsof -nP -iTCP:8787 -sTCP:LISTEN -t   # exactly one PID expected; note it as OLD
   kill <OLD>
   ```

2. **Wait until the old process is gone** — `kill -0 <OLD>` must *fail*
   before you start anything. On SIGTERM, `src/interface/http/graceful-shutdown.ts`
   runs `drain()` (watcher / tunnel / cache cleanup) first and only calls
   `server.close()` after it resolves, so for up to
   `DEFAULT_SHUTDOWN_TIMEOUT_MS` (5000 ms, overridable with
   `BDBOARD_SHUTDOWN_TIMEOUT_MS`) the old process is **still listening and
   still answers `/api/health` with 200**. Measured 2026-09-13 after
   merging #466: a health poll right after the kill got 200 from the dying
   process and reported success; `lsof` then showed no listener at all, and
   the new PID only started listening about 5 s later. Waiting here also
   keeps the old process's shutdown lines out of the new log: it keeps
   writing to the same file after the new start has truncated it.

   Check with `kill -0 <OLD> 2>/dev/null; echo $?` — `0` means still alive,
   `1` means gone. Repeat it as separate Bash calls rather than a foreground
   `sleep` loop (the agent Bash tool blocks foreground `sleep`). Budget
   about 10 s: the shutdown timeout plus margin (the startup log prints the
   effective value as `Shutdown timeout: <N>ms`; `.env` may override it).
   Past that budget, `kill -9 <OLD>`. Since the timeout path
   (bdboard-3tw.91) calls `closeAllConnections()` and exits, a process that
   outlives it is not the SSE drain case — suspect a blocked event loop and
   read the log after the `kill -9`.

3. **Start** the server (from the main checkout, as above). If the old
   server had been started with `preview_start`, run `preview_stop` first
   so the stale serverId does not make `preview_start` think it is already
   running.

4. **Wait for health with a real delay between attempts**, then confirm the
   listener is a *new* PID:

   ```bash
   curl -sS -o /dev/null -w '%{http_code}\n' \
     --connect-timeout 2 --max-time 5 \
     --retry 60 --retry-delay 1 --retry-connrefused --retry-max-time 90 \
     http://localhost:8787/api/health
   lsof -nP -iTCP:8787 -sTCP:LISTEN -t   # must differ from OLD
   ```

   Healthy means **200 *and* a listening PID different from OLD**; a 200
   with OLD still listening means step 2 was skipped.

   - **Why the delay**: a refused connection makes curl return `000` in
     **0 ms**, so a retry loop with no wait burns through all its attempts
     before the server has even bound the port, reports `000`, and invites
     a second `npm run start` (happened 2026-09-05: a 40-attempt loop
     finished instantly while the server came up fine seconds later; the
     second process died on `EADDRINUSE`, but only after truncating
     `/tmp/bdboard-server.log`).
   - **What**: the status code of `/api/health`, judged exactly as in the
     session-start section above (200 healthy; 401/503 listener present;
     `000` down). curl prints only the final attempt's code on stdout —
     judge by that last 3-digit line alone. A `curl: (7) Failed to connect`
     line on stderr for each refused attempt is normal. `--retry` also
     retries HTTP 408/429/500/502/503/504 (`man curl`), so where the
     request is answered `503` it waits out the budget before printing
     `503`; `401` is not retried and returns at once.
   - **Per-attempt cap**: `--max-time 5` stops a listener that accepts but
     never answers from hanging curl until the tool timeout (which would
     print nothing and look like "down"). A timeout counts as transient,
     so it is retried; `--retry-max-time 90` bounds the whole wait.
   - **Interval**: 1 second (`--retry-delay 1`). `--retry-connrefused` is
     what makes a refused connection count as retryable; without it curl
     gives up on the first `000`. Measured on a closed port: `--retry 3`
     returns after 3 s, no retry returns after 0 s.
   - **How long**: up to 60 seconds (`--retry 60`). A cold start measured
     **15 s** to the first 200 on 2026-09-13 with parallel verify runs
     loading the machine (bdboard-pkr6.22.5).
   - **Still `000` after 60 s**: read the server log first, then count
     listeners with `lsof -nP -iTCP:8787 -sTCP:LISTEN -t | wc -l`. Do not
     start another server on a guess, and do not reach for a pattern-match
     kill if you suspect a double start — pick the PID from that `lsof`.

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
  chair. Hook 規則 7 (`.claude/skills/bdboard-harness/hooks/server-guard.sh`) は
  listener PID とその親 (npm / node) への直接 `kill`、`$(lsof … 8787 …)` や変数・
  パイプ経由で port から引いた PID の kill を、呼び出し元を問わず deny する。議長が
  手で止めざるを得ないときだけ `BDBOARD_SERVER_OVERRIDE="<理由>" kill <PID>` と前置する。
- Kill には **pkill / killall 等のパターンマッチ kill を使わない** —
  worktree のテスト用プロセスを狙った `pkill -f 'tsx.*src/main.ts'` がこの常時稼働
  サーバーにも当たった実例がある。必ず対象の PID を特定してから kill すること
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
