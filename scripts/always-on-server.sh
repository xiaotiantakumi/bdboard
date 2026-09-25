#!/usr/bin/env bash
# always-on-server.sh — 常時稼働サーバー (main checkout の npm run start, 既定 8787) の
# 唯一の再起動入口 (bdboard-hpu8)。
#
# 背景: 2026-09-20 に「PR をマージしたサブエージェントが CLAUDE.md の後片付け手順どおり
# main checkout を pull し、8787 を kill して起動し直す」事故が 3 件続いた。再起動そのものは
# 議長の仕事で、手順 (skill bdboard-server-ops) は文章としては正しかったが、誰が実行して
# よいかを機械的に区別する手段が無かった。このスクリプトは:
#   - 呼び出し元に BDBOARD_SERVER_CALLER=chair の宣言を要求する (身元の証明ではなく宣言 +
#     監査ログ。hook 側 (harness pack 規則 7) はサブエージェントからのこのスクリプト実行を
#     agent_id で止める)
#   - --expect-pid で「いま動いている listener がこの PID のときだけ」再起動する (CAS)。
#     2 つの議長セッションが同時に再起動しようとしても片方は止まる
#   - cloudflared が動いていれば止まる (--tunnel-ack で承知のうえ続行)
#   - mkdir ロックで同時実行を排他する
#   - どの cwd (worktree 含む) から呼んでも git common dir から main checkout を解決する
#   - 監査ログ ${BDBOARD_SERVER_AUDIT_LOG:-/tmp/bdboard-server-restarts.log} に 1 行残す
#
# 使い方:
#   scripts/always-on-server.sh status [--port N]
#   BDBOARD_SERVER_CALLER=chair scripts/always-on-server.sh start   [--port N] [--dry-run]
#   BDBOARD_SERVER_CALLER=chair scripts/always-on-server.sh restart --expect-pid <pid> \
#       [--pull] [--build|--no-build] [--verify] [--tunnel-ack] [--port N] [--dry-run]
#   BDBOARD_SERVER_CALLER=chair scripts/always-on-server.sh deploy  --expect-pid <pid> \
#       [--verify] [--tunnel-ack] [--port N] [--dry-run]
#     deploy = pull --ff-only → lockfile が変わっていれば npm install → web/・
#              docs/help-content.json・package.json が変わっていれば build:web →
#              src/・web/・docs/help-content.json か依存が変わっていれば restart
#              (テストファイル・__fixtures__・test-support 系は判定から除外)、そうでなければ
#              health だけ
#
# 終了コード: 0 成功 / 1 使い方 / 2 前提不成立 (トンネル稼働・ロック中・health 不通・
#             build 失敗) / 3 --expect-pid 不一致 / 4 BDBOARD_SERVER_CALLER 未宣言
set -u

usage() {
  cat <<'USAGE'
always-on-server.sh — 常時稼働サーバー (main checkout の npm run start) の唯一の再起動入口

  scripts/always-on-server.sh status [--port N]
  BDBOARD_SERVER_CALLER=chair scripts/always-on-server.sh start   [--port N] [--dry-run]
  BDBOARD_SERVER_CALLER=chair scripts/always-on-server.sh restart --expect-pid <pid> \
      [--pull] [--build|--no-build] [--verify] [--tunnel-ack] [--port N] [--dry-run]
  BDBOARD_SERVER_CALLER=chair scripts/always-on-server.sh deploy  --expect-pid <pid> \
      [--verify] [--tunnel-ack] [--port N] [--dry-run]

  deploy = pull --ff-only → lockfile が変わっていれば npm install → web/・
           docs/help-content.json・package.json が変わっていれば build:web →
           src/・web/・docs/help-content.json か依存が変わっていれば restart
           (テストファイル・__fixtures__・test-support 系は判定から除外)、そうでなければ
           health 確認だけ

  --expect-pid  いま listen している PID がこれと一致するときだけ進む (CAS)。status で確認する
  --verify      kill の前に main checkout で契約の検証コマンド (npm run verify) を通す。赤なら触らない
  --tunnel-ack  cloudflared 稼働中でも続行する (trycloudflare URL が失効する旨をユーザーに伝えた後)
  --dry-run     何もせず手順を表示する

終了コード: 0 成功 / 1 使い方 / 2 前提不成立 (トンネル稼働・ロック中・health 不通・build 失敗)
            3 --expect-pid 不一致 / 4 BDBOARD_SERVER_CALLER 未宣言
USAGE
}

die() {
  # $1 = exit code, 残り = メッセージ行
  code="$1"
  shift
  for line in "$@"; do
    printf 'always-on-server: %s\n' "$line" >&2
  done
  exit "$code"
}

[ $# -ge 1 ] || { usage >&2; exit 1; }
ACTION="$1"
shift

case "$ACTION" in
  -h | --help | help) usage; exit 0 ;;
  status | start | restart | deploy) ;;
  *) die 1 "unknown action: $ACTION" 'actions: status | start | restart | deploy (--help で詳細)' ;;
esac

# main checkout: git common dir の親。worktree からでも同じ場所を指す。
COMMON_DIR="$(git rev-parse --git-common-dir 2>/dev/null)" ||
  die 2 'git リポジトリの中で実行してください (main checkout を git common dir から解決します)'
case "$COMMON_DIR" in
  /*) ;;
  *) COMMON_DIR="$PWD/$COMMON_DIR" ;;
esac
MAIN="$(cd "$COMMON_DIR/.." 2>/dev/null && pwd -P)" ||
  die 2 "main checkout を解決できません: $COMMON_DIR"
[ -f "$MAIN/package.json" ] || die 2 "main checkout に package.json がありません: $MAIN"

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" && pwd -P)" ||
  die 2 '自身のディレクトリを解決できません'

# --- 自分の置き場所が main checkout の scripts/ でなければ、main 側の現在版へ委譲し直す
# (bdboard-9nah)。案内どおり相対パスで (`scripts/always-on-server.sh ...`) 呼んでも、
# 議長の cwd が古い worktree のままだと、その worktree に取り残された旧版が動いてしまい、
# main に入った以後の修正 (安全策も含む) が効かない事故につながる
# (bdboard-flpp の設計レビューで指摘)。git common dir で解決した MAIN の scripts/ 配下に
# 同名ファイルがあり、かつ自分がそれでなければ、元の引数のまま exec し直す。
# MAIN 側に同名ファイルが無いとき (テスト用の使い捨てリポジトリ、この安全策より前の
# main など) は fail-open で自分自身のまま続行する — 「main の版が存在するのに自分が
# それでない」ときだけ委譲する、の意図。BDBOARD_SERVER_SKIP_SELF_EXEC=1 は委譲後の
# プロセスへの再帰防止と、テストで意図的にこの動作を止めるための脱出口。
if [ -z "${BDBOARD_SERVER_SKIP_SELF_EXEC:-}" ]; then
  SELF_BASENAME="$(basename -- "${BASH_SOURCE[0]:-$0}")"
  MAIN_SCRIPT="$MAIN/scripts/$SELF_BASENAME"
  MAIN_SCRIPT_DIR_CANON="$(CDPATH= cd -- "$MAIN/scripts" 2>/dev/null && pwd -P)" || MAIN_SCRIPT_DIR_CANON=''
  if [ -n "$MAIN_SCRIPT_DIR_CANON" ] && [ "$SCRIPT_DIR" != "$MAIN_SCRIPT_DIR_CANON" ] && [ -f "$MAIN_SCRIPT" ]; then
    printf 'always-on-server: %s は main checkout ( %s ) の版ではありません。%s へ委譲します (stale worktree 対策, bdboard-9nah)\n' \
      "$SCRIPT_DIR/$SELF_BASENAME" "$MAIN" "$MAIN_SCRIPT" >&2
    BDBOARD_SERVER_SKIP_SELF_EXEC=1 exec "$MAIN_SCRIPT" "$ACTION" "$@"
  fi
fi

. "$SCRIPT_DIR/deploy-changed.sh" ||
  die 2 "deploy-changed.sh を読み込めません: $SCRIPT_DIR/deploy-changed.sh"

PORT="${BDBOARD_PORT:-8787}"
EXPECT_PID=''
DO_PULL=''
BUILD_MODE='auto'
TUNNEL_ACK=''
DRY_RUN=''
DO_VERIFY=''
while [ $# -gt 0 ]; do
  case "$1" in
    --expect-pid) [ $# -ge 2 ] || die 1 '--expect-pid needs a value'; EXPECT_PID="$2"; shift 2 ;;
    --expect-pid=*) EXPECT_PID="${1#--expect-pid=}"; shift ;;
    --port) [ $# -ge 2 ] || die 1 '--port needs a value'; PORT="$2"; shift 2 ;;
    --port=*) PORT="${1#--port=}"; shift ;;
    --pull) DO_PULL='yes'; shift ;;
    --build) BUILD_MODE='always'; shift ;;
    --no-build) BUILD_MODE='never'; shift ;;
    --tunnel-ack) TUNNEL_ACK='yes'; shift ;;
    --verify) DO_VERIFY='yes'; shift ;;
    --dry-run) DRY_RUN='yes'; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die 1 "unknown option: $1" ;;
  esac
done

case "$PORT" in
  '' | *[!0-9]*) die 1 "--port must be a number: $PORT" ;;
esac
case "$EXPECT_PID" in
  '' | *[!0-9]*) [ -z "$EXPECT_PID" ] || die 1 "--expect-pid must be a number: $EXPECT_PID" ;;
esac

SERVER_LOG="${BDBOARD_SERVER_LOG:-/tmp/bdboard-server.log}"
AUDIT_LOG="${BDBOARD_SERVER_AUDIT_LOG:-/tmp/bdboard-server-restarts.log}"
LOCK_DIR="${BDBOARD_SERVER_LOCK_DIR:-/tmp/bdboard-server-restart.lock.d}"
HEALTH_URL="http://127.0.0.1:$PORT/api/health"

listener_pids() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | tr '\n' ' ' | sed 's/ $//'
  elif command -v ss >/dev/null 2>&1; then
    ss -ltnpH "sport = :$PORT" 2>/dev/null | grep -Eo 'pid=[0-9]+' | cut -d= -f2 | tr '\n' ' ' | sed 's/ $//'
  fi
}

health_code() {
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$HEALTH_URL" 2>/dev/null)"
  printf '%s' "${code:-000}"
}

tunnel_running() {
  pgrep -x cloudflared >/dev/null 2>&1
}

audit() {
  printf '%s\t%s\tcaller=%s\told=%s\tnew=%s\thead=%s\tresult=%s\n' \
    "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$ACTION" "${BDBOARD_SERVER_CALLER:-unset}" \
    "${1:-}" "${2:-}" "$(git -C "$MAIN" rev-parse --short HEAD 2>/dev/null)" "${3:-}" \
    >>"$AUDIT_LOG" 2>/dev/null || true
}

print_status() {
  pids="$(listener_pids)"
  printf 'main checkout : %s\n' "$MAIN"
  printf 'HEAD          : %s\n' "$(git -C "$MAIN" log -1 --format='%h %s' 2>/dev/null)"
  printf 'port          : %s\n' "$PORT"
  if [ -n "$pids" ]; then
    printf 'listener PID  : %s\n' "$pids"
    for pid in $pids; do
      printf '  %s started : %s\n' "$pid" "$(ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^ *//')"
    done
  else
    printf 'listener PID  : (not listening)\n'
  fi
  printf 'health        : HTTP %s (%s)\n' "$(health_code)" "$HEALTH_URL"
  if tunnel_running; then
    printf 'cloudflared   : running (再起動すると trycloudflare URL が失効します)\n'
  else
    printf 'cloudflared   : not running\n'
  fi
  if [ -d "$LOCK_DIR" ]; then
    printf 'restart lock  : held (%s)\n' "$(cat "$LOCK_DIR/pid" 2>/dev/null)"
  fi
}

if [ "$ACTION" = 'status' ]; then
  print_status
  exit 0
fi

# --- ここから副作用のある action。呼び出し元の宣言を要求する。
if [ "${BDBOARD_SERVER_CALLER:-}" != 'chair' ]; then
  die 4 \
    "$ACTION は議長 (トップレベルセッション) だけが行います。BDBOARD_SERVER_CALLER=chair を前置してください。" \
    'サブエージェントは再起動せず、最終報告に「議長で再起動が必要」と書いてください。'
fi

CURRENT_PIDS="$(listener_pids)"
CURRENT_PID="${CURRENT_PIDS%% *}"

# 期待 PID の照合 (CAS)。restart/deploy では必須: 「いま動いているのが自分の知っている
# プロセスか」を確かめずに kill すると、別セッションが直前に再起動した新プロセスを巻き込む。
if [ "$ACTION" = 'restart' ] || [ "$ACTION" = 'deploy' ]; then
  [ -n "$EXPECT_PID" ] ||
    die 1 "$ACTION には --expect-pid <現在の listener PID> が必要です (status で確認)。"
  if [ "$CURRENT_PIDS" != "$EXPECT_PID" ]; then
    audit "$CURRENT_PIDS" '' 'pid-mismatch'
    die 3 \
      "PID MISMATCH: 期待 $EXPECT_PID / 実際 ${CURRENT_PIDS:-(not listening)}。別セッションが再起動した可能性があります。" \
      'status で現在の PID を確認し、必要なら改めて --expect-pid を指定してください。'
  fi
fi
if [ "$ACTION" = 'start' ] && [ -n "$CURRENT_PIDS" ]; then
  die 2 "port $PORT は既に PID $CURRENT_PIDS が listen しています。restart を使ってください。"
fi

if tunnel_running && [ -z "$TUNNEL_ACK" ]; then
  die 2 \
    'cloudflared が稼働中です。サーバーを再起動するとトンネルの子プロセスが死に、trycloudflare の URL が失効します。' \
    'ユーザーに先に伝えたうえで、承知のうえなら --tunnel-ack を付けて再実行してください。'
fi

if [ -n "$DRY_RUN" ]; then
  printf '[dry-run] action=%s main=%s port=%s current_pid=%s expect_pid=%s\n' \
    "$ACTION" "$MAIN" "$PORT" "${CURRENT_PIDS:-none}" "${EXPECT_PID:-none}"
  if [ -n "$DO_PULL" ] || [ "$ACTION" = 'deploy' ]; then
    printf '[dry-run] git -C %s pull --ff-only\n' "$MAIN"
  fi
  printf '[dry-run] build:web mode=%s\n' "$BUILD_MODE"
  [ -z "$DO_VERIFY" ] || printf '[dry-run] cd %s && npm run verify\n' "$MAIN"
  if [ "$ACTION" != 'start' ]; then
    printf '[dry-run] kill %s (TERM → 最大 10 秒待って KILL) → port %s の解放を待つ\n' "${CURRENT_PIDS:-<pid>}" "$PORT"
  fi
  printf '[dry-run] cd %s && nohup npm run start > %s 2>&1 </dev/null &\n' "$MAIN" "$SERVER_LOG"
  printf '[dry-run] curl %s を最大 30 秒リトライ → 新 PID と "Serving static web UI from %s/web/dist" を確認\n' "$HEALTH_URL" "$MAIN"
  exit 0
fi

# --- 排他ロック (mkdir はアトミック)。持ち主が死んでいれば stale として引き継ぐ。
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  holder="$(cat "$LOCK_DIR/pid" 2>/dev/null)"
  if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
    die 2 "別の再起動が進行中です (PID $holder, $LOCK_DIR)。終わるのを待ってください。"
  fi
  rm -rf "$LOCK_DIR"
  mkdir "$LOCK_DIR" 2>/dev/null || die 2 "ロックを取れません: $LOCK_DIR"
fi
printf '%s\n' "$$" >"$LOCK_DIR/pid"
trap 'rm -rf "$LOCK_DIR"' EXIT

OLD_HEAD="$(git -C "$MAIN" rev-parse HEAD 2>/dev/null)"

# --- pull (deploy は常に、restart/start は --pull のとき)。
if [ -n "$DO_PULL" ] || [ "$ACTION" = 'deploy' ]; then
  printf '== git -C %s pull --ff-only\n' "$MAIN"
  git -C "$MAIN" pull --ff-only || { audit "$CURRENT_PIDS" '' 'pull-failed'; die 2 'git pull --ff-only に失敗しました (main checkout に未コミットの変更や分岐がないか確認)。'; }
fi
NEW_HEAD="$(git -C "$MAIN" rev-parse HEAD 2>/dev/null)"

changed() {
  [ "$OLD_HEAD" != "$NEW_HEAD" ] || return 1
  [ -n "$(git -C "$MAIN" diff --name-only "$OLD_HEAD" "$NEW_HEAD" -- "$@" 2>/dev/null)" ]
}

if changed package-lock.json package.json; then
  printf '== npm install (package-lock.json changed)\n'
  (cd "$MAIN" && npm install) || die 2 'npm install に失敗しました。'
fi
if changed web/package-lock.json web/package.json; then
  printf '== npm --prefix web install (web/package-lock.json changed)\n'
  (cd "$MAIN" && npm --prefix web install) || die 2 'npm --prefix web install に失敗しました。'
fi

NEED_BUILD=''
case "$BUILD_MODE" in
  always) NEED_BUILD='yes' ;;
  never) ;;
  auto)
    if [ "$ACTION" = 'deploy' ] || [ -n "$DO_PULL" ]; then
      # docs/help-content.json is bundled into the web UI too (web/src/helpContent.ts
      # imports it directly), not just read server-side at startup, so a
      # docs/help-content.json-only change needs a rebuild here as well as the
      # restart below (bdboard-kpim).
      changed web/ package.json docs/help-content.json && NEED_BUILD='yes'
    fi
    [ -f "$MAIN/web/dist/index.html" ] || NEED_BUILD='yes'
    ;;
esac
if [ -n "$NEED_BUILD" ]; then
  printf '== npm run build:web\n'
  (cd "$MAIN" && npm run build:web) || { audit "$CURRENT_PIDS" '' 'build-failed'; die 2 'npm run build:web に失敗しました。サーバーは触っていません。'; }
fi

if [ -n "$DO_VERIFY" ]; then
  printf '== npm run verify (in %s)\n' "$MAIN"
  (cd "$MAIN" && npm run verify) || { audit "$CURRENT_PIDS" '' 'verify-failed'; die 2 'main checkout の npm run verify が赤です。サーバーは触っていません (旧プロセスのまま)。'; }
fi

# deploy: 再起動が必要な範囲 (deploy-changed.sh の DEPLOY_RESTART_PATHSPEC) に変更がなければ
# 再起動しない。web/dist の大半のファイルは serveStatic が毎リクエスト disk から返すので
# 再起動なしで反映されるが、SPA フォールバック (src/bootstrap/wire-feature-routes.ts) は
# web/dist/index.html を起動時に 1 回だけ読むため web/ の変更は再起動が要る。
# docs/help-content.json も src/infrastructure/chat/help-content.ts が起動時に 1 回だけ読む
# ため同様 (bdboard-kpim)。
if [ "$ACTION" = 'deploy' ] && [ -n "$CURRENT_PIDS" ]; then
  if ! deploy_relevant_changed "$MAIN" "$OLD_HEAD" "$NEW_HEAD" "${DEPLOY_RESTART_PATHSPEC[@]}"; then
    printf '== server-side unchanged (%s..%s); keeping PID %s. health=HTTP %s\n' \
      "$(git -C "$MAIN" rev-parse --short "$OLD_HEAD")" "$(git -C "$MAIN" rev-parse --short "$NEW_HEAD")" \
      "$CURRENT_PIDS" "$(health_code)"
    audit "$CURRENT_PIDS" "$CURRENT_PIDS" 'no-restart-needed'
    exit 0
  fi
fi

# --- 停止: PID 指定で TERM、消えるまで待ち、消えなければ KILL。pkill/killall は使わない。
if [ -n "$CURRENT_PIDS" ]; then
  printf '== stopping PID %s\n' "$CURRENT_PIDS"
  # shellcheck disable=SC2086
  kill $CURRENT_PIDS 2>/dev/null || true
  waited=0
  while [ "$waited" -lt 100 ]; do
    alive=''
    for pid in $CURRENT_PIDS; do
      kill -0 "$pid" 2>/dev/null && alive='yes'
    done
    [ -n "$alive" ] || break
    sleep 0.1
    waited=$((waited + 1))
  done
  if [ -n "$alive" ]; then
    printf '== still alive after 10s; sending KILL\n'
    # shellcheck disable=SC2086
    kill -9 $CURRENT_PIDS 2>/dev/null || true
    sleep 1
  fi
  waited=0
  while [ -n "$(listener_pids)" ] && [ "$waited" -lt 50 ]; do
    sleep 0.1
    waited=$((waited + 1))
  done
  [ -z "$(listener_pids)" ] || { audit "$CURRENT_PIDS" '' 'port-still-bound'; die 2 "port $PORT がまだ解放されていません: $(listener_pids)"; }
fi

# --- 起動: main checkout から。ログは固定の場所 (skill bdboard-server-ops と同じ)。
printf '== starting: cd %s && nohup npm run start > %s 2>&1 </dev/null &\n' "$MAIN" "$SERVER_LOG"
# `(cd X && nohup cmd >log 2>&1 &)` と 1 行に書いてはいけない: & は `cd && cmd` のリスト全体に
# 掛かり、リダイレクトされていない待ち受け用サブシェルが親の stdout を握ったまま生き残る。
# このスクリプトを spawn した側 (Claude Code の Bash ツール、テストの spawn) はそのパイプの
# EOF を待って戻ってこない。& を nohup の行だけに掛け、stdin も /dev/null に切り離す。
(
  cd "$MAIN" || exit 1
  BDBOARD_PORT="$PORT" nohup npm run start >"$SERVER_LOG" 2>&1 </dev/null &
)

code='000'
waited=0
while [ "$waited" -lt 60 ]; do
  code="$(health_code)"
  [ "$code" = '200' ] && break
  sleep 0.5
  waited=$((waited + 1))
done
NEW_PIDS="$(listener_pids)"
if [ "$code" != '200' ] || [ -z "$NEW_PIDS" ]; then
  audit "$CURRENT_PIDS" "$NEW_PIDS" "health-$code"
  die 2 "起動後 30 秒以内に $HEALTH_URL が 200 になりません (HTTP $code, listener=${NEW_PIDS:-none})。$SERVER_LOG を確認してください。"
fi
if [ -n "$CURRENT_PIDS" ] && [ "$NEW_PIDS" = "$CURRENT_PIDS" ]; then
  audit "$CURRENT_PIDS" "$NEW_PIDS" 'pid-unchanged'
  die 2 "listener PID が変わっていません ($NEW_PIDS)。古いプロセスが残っている可能性があります。"
fi
if ! grep -q "Serving static web UI from $MAIN/web/dist" "$SERVER_LOG" 2>/dev/null; then
  printf '== warning: %s に "Serving static web UI from %s/web/dist" が見当たりません (別の checkout から起動?)\n' "$SERVER_LOG" "$MAIN"
fi
audit "$CURRENT_PIDS" "$NEW_PIDS" 'ok'
printf '== OK: PID %s -> %s, HEAD %s, health HTTP %s\n' "${CURRENT_PIDS:-none}" "$NEW_PIDS" \
  "$(git -C "$MAIN" rev-parse --short HEAD 2>/dev/null)" "$code"
exit 0
