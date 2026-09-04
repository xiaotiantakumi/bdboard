---
name: bdboard-server-ops
description: bdboard の常時稼働ローカルサーバー (メインチェックアウト・BDBOARD_PORT 既定 8787) の起動確認・起動・再起動・停止判断が要るときに読む。ヘルスチェックが 000 だった / リスナーは居るのに応答しない / マージ後にサーバーを作り直す / worktree から preview_start・npm run dev を打ちたくなった / cloudflared トンネルが同居している、のいずれかに当たったらこの skill の手順に従う。pkill・killall によるパターンマッチ kill の禁止理由もここ。
---

# bdboard-server-ops — 常時稼働ローカルサーバーの運用

The main checkout (the repository root checkout, not worktrees) must be serving the board on
localhost whenever an agent session is active. Default port: `BDBOARD_PORT`
(8787). This is an agent operational rule, not an OS daemon — do NOT create a
launchd plist or any persistent daemon for this; if true 24/7 hosting is ever
wanted, that is a separate, explicitly user-approved change.

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
  Workflow cleanup): `git pull --ff-only` → `npm install` /
  `npm --prefix web install` if lockfiles changed → `npm run build:web` →
  restart the server → re-check with the status-code command above.
  `npm run start` runs tsx without watch and serves a static `web/dist`, so
  neither server nor UI changes are picked up without this rebuild+restart.
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
  user request). Kill には **pkill / killall 等のパターンマッチ kill を使わない** —
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
