# shellcheck shell=bash
# server-guard.sh — pre-bash-guard.sh の規則 7「常時稼働サーバーの保護」(bdboard-hpu8)。
#
# 単独では実行しない。pre-bash-guard.sh の規則 6 の直後から `.` で読み込まれ、呼び出し元の
#   COMMAND / HOOK_CWD / REPO_ROOT / CONTRACT / JSON_TOOL / AGENT_ID
#   deny() / matches()
# を前提にする。別ファイルなのは pre-bash-guard.sh の行数上限 (file-size-baseline 900 行)
# を守るため。判定できないものは `return 0` で呼び出し元へ戻す (fail-open)。
#
# 契約 (.claude/bdboard-harness.json) に alwaysOnServer.port があるときだけ有効になる。
#
#   7a. サブエージェント (hook 入力に agent_id がある) から main checkout での git pull
#   7b. サブエージェントから main checkout でのサーバー起動 (npm run start / tsx src/main.ts)
#       と、再起動スクリプト (alwaysOnServer.restartScript) の呼び出し (cwd を問わない)
#   7c. 呼び出し元を問わず、常時稼働サーバーの listener (とその親 npm/node) を PID で
#       直接 kill する / `$(lsof ... <port> ...)` の結果を kill に渡す / パイプで kill へ流す
#
# 2026-09-20 に 3 件連続で起きた「PR をマージしたサブエージェントが CLAUDE.md の後片付け
# 手順どおり main checkout を pull して 8787 を kill・再起動した」事故の機械的な再発防止。
# 議長の再起動はスクリプト経由 (alwaysOnServer.restartScript) に一本化する。スクリプトの
# 中の kill/pull/start は hook には見えないので、スクリプト呼び出しは議長なら通る。
#
# 限界 (hooks/README.md「規則 7」に明記): 実効ディレクトリは cwd と `cd` の静的追跡、変数は
# 同一コマンド内の `NAME=値` 代入だけ解決する。別ファイルに書いて実行する迂回は見えない。
# preview_start (MCP) は Bash ではないのでこの hook の対象外。

# --- 0. 前置フィルタ: 関係しうる語が無ければ何もしない (git status 等の頻出コマンドは
#        契約を読む前に通す。契約の読み取りは jq/python3 の起動を伴う)。
matches '(^|[^[:alnum:]_./-])(kill|git|npm|npx|tsx|node|pushd)([^[:alnum:]_-]|$)|\.sh([^[:alnum:]_-]|$)' || return 0

server_contract_field() {
  case "$JSON_TOOL" in
    jq)
      printf '%s' "$CONTRACT" | jq -r --arg key "$1" '
        try (.alwaysOnServer[$key]) catch null
        | if type == "string" or type == "number" then tostring else "" end
      ' 2>/dev/null
      ;;
    python3)
      printf '%s' "$CONTRACT" | python3 -c '
import json, sys
try:
    doc = json.load(sys.stdin)
except Exception:
    sys.exit(0)
node = doc.get("alwaysOnServer") if isinstance(doc, dict) else None
value = node.get(sys.argv[1]) if isinstance(node, dict) else None
if isinstance(value, bool):
    value = None
if isinstance(value, (str, int, float)):
    sys.stdout.write(str(value))
' "$1" 2>/dev/null
      ;;
  esac
}

SG_PORT="$(server_contract_field port)"
case "$SG_PORT" in
  '' | *[!0-9]*) return 0 ;;
esac
SG_SCRIPT="$(server_contract_field restartScript)"
SG_SCRIPT_BASE="${SG_SCRIPT##*/}"

# --- 1. main checkout の場所: git common dir の親。worktree からでも同じ場所に解決する。
sg_canon() {
  (cd "$1" 2>/dev/null && pwd -P) || printf '%s' "$1"
}

SG_COMMON="$(git -C "$HOOK_CWD" rev-parse --git-common-dir 2>/dev/null)"
[ -n "$SG_COMMON" ] || return 0
case "$SG_COMMON" in
  /*) ;;
  *) SG_COMMON="$HOOK_CWD/$SG_COMMON" ;;
esac
SG_MAIN="$(cd "$SG_COMMON/.." 2>/dev/null && pwd -P)"
[ -n "$SG_MAIN" ] || return 0

# そのディレクトリが属する checkout が main checkout か。worktree は main の下
# (.claude/worktrees/) に置かれるので前方一致では判定できず、git に toplevel を答えさせる。
# 存在しない dir (未知の変数など) は偽 = fail-open。
sg_dir_is_main() {
  sg_top="$(git -C "$1" rev-parse --show-toplevel 2>/dev/null)" || return 1
  [ -n "$sg_top" ] || return 1
  [ "$(sg_canon "$sg_top")" = "$SG_MAIN" ]
}

SG_IS_SUB=''
[ -n "$AGENT_ID" ] && SG_IS_SUB='yes'

# 議長だけの逃げ道。規則 6 の BDBOARD_ROUTE_OVERRIDE と同じく、コマンド先頭の前置きだけ見る。
SG_OVERRIDE=''
if printf '%s\n' "$COMMAND" | grep -Eq '^[[:space:]]*BDBOARD_SERVER_OVERRIDE=[^[:space:]]' 2>/dev/null; then
  SG_OVERRIDE='yes'
fi

# deny の記録。hook の stderr は 3 行しか出せないので、あとから「誰が何を止められたか」を
# 追えるように 1 行残す。書けなくても判定には影響しない。
sg_audit() {
  sg_log_dir="${TMPDIR:-/tmp}"
  sg_flat="$(printf '%s' "$COMMAND" | tr '\n\r\t' '   ')"
  printf '%s\t%s\tagent=%s\tcwd=%s\tcmd=%s\n' \
    "$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)" "$1" "${AGENT_ID:-top-level}" \
    "$HOOK_CWD" "${sg_flat:0:300}" \
    >>"${sg_log_dir%/}/bdboard-server-guard.log" 2>/dev/null || true
}

sg_restart_hint() {
  if [ -n "$SG_SCRIPT" ]; then
    printf '%s' "再起動は議長が BDBOARD_SERVER_CALLER=chair $SG_SCRIPT restart --expect-pid <現PID> で行います。"
  else
    printf '%s' '再起動は議長が skill bdboard-server-ops の手順で行います。'
  fi
}

sg_deny_sub() {
  sg_audit "$1"
  deny \
    "bdboard-harness: サブエージェントから main checkout ($SG_MAIN) の$2は禁止です (常時稼働サーバー port $SG_PORT の再配備は議長の仕事)。" \
    'worktree で作業を完結させ、マージ後の pull/build/再起動が要るなら最終報告に「議長で再起動が必要」と書いてください。' \
    "$(sg_restart_hint)"
}

sg_deny_kill() {
  sg_audit '7c-kill-listener'
  if [ -n "$SG_IS_SUB" ]; then
    deny \
      "bdboard-harness: $1 は常時稼働サーバー (port $SG_PORT) のプロセスです。サブエージェントは kill も再起動もできません。" \
      '最終報告に「議長で再起動が必要」と書いてください。' \
      "$(sg_restart_hint)"
  fi
  deny \
    "bdboard-harness: $1 は常時稼働サーバー (port $SG_PORT) のプロセスです。直接 kill せず再起動スクリプトを使ってください。" \
    "$(sg_restart_hint)" \
    'どうしても手で止めるなら理由付きで BDBOARD_SERVER_OVERRIDE="<理由>" を前置してください (議長のみ)。'
}

# --- 2. listener PID とその親 (npm run start → node(tsx) → listener)。kill を含む
#        セグメントのときだけ 1 回引く (lsof は数十 ms)。lsof が無ければ ss、どちらも
#        無ければ空 = PID 直指定の判定はしない。
SG_LIVE_PIDS=''
SG_LIVE_PIDS_LOADED=''
sg_live_pids() {
  if [ -n "$SG_LIVE_PIDS_LOADED" ]; then
    printf '%s\n' "$SG_LIVE_PIDS"
    return 0
  fi
  SG_LIVE_PIDS_LOADED='yes'
  sg_listeners=''
  if command -v lsof >/dev/null 2>&1; then
    sg_listeners="$(lsof -nP -iTCP:"$SG_PORT" -sTCP:LISTEN -t 2>/dev/null)"
  elif command -v ss >/dev/null 2>&1; then
    sg_listeners="$(ss -ltnpH "sport = :$SG_PORT" 2>/dev/null | grep -Eo 'pid=[0-9]+' | cut -d= -f2)"
  fi
  sg_result=''
  for sg_pid in $sg_listeners; do
    sg_result="$sg_result $sg_pid"
    sg_cur="$sg_pid"
    sg_depth=0
    while [ "$sg_depth" -lt 3 ]; do
      sg_parent="$(ps -o ppid= -p "$sg_cur" 2>/dev/null | tr -d ' ')"
      case "$sg_parent" in '' | 0 | 1 | *[!0-9]*) break ;; esac
      sg_comm="$(ps -o comm= -p "$sg_parent" 2>/dev/null)"
      case "${sg_comm##*/}" in
        node* | npm* | sh | bash | zsh | tsx) sg_result="$sg_result $sg_parent" ;;
        *) break ;;
      esac
      sg_cur="$sg_parent"
      sg_depth=$((sg_depth + 1))
    done
  done
  SG_LIVE_PIDS="$sg_result"
  printf '%s\n' "$SG_LIVE_PIDS"
}

sg_pid_is_live_server() {
  for sg_live in $(sg_live_pids); do
    [ "$sg_live" = "$1" ] && return 0
  done
  return 1
}

# --- 3. コマンドを「1 コマンド」単位に割る。; && || & と改行で切り、パイプ | は残す
#        (パイプの先の kill を同じセグメントで見るため)。行継続 (\改行) は空白に潰す。
SG_NL=$'\n'
SG_SEGMENTS="${COMMAND//\\$SG_NL/ }"
SG_SEGMENTS="${SG_SEGMENTS//&&/$SG_NL}"
SG_SEGMENTS="${SG_SEGMENTS//\|\|/$SG_NL}"
SG_SEGMENTS="${SG_SEGMENTS//;/$SG_NL}"
SG_SEGMENTS="${SG_SEGMENTS//&/$SG_NL}"

# 同一コマンド内の NAME=値 代入を覚え、`cd $NAME` の類を解決する (改行区切り name=value)。
# 値が `$(...)` でポート番号を含むものは「listener PID 由来」として別に覚える。
SG_VARS=''
SG_PORT_VARS=''
SG_DIR="$(sg_canon "$HOOK_CWD")"
SG_PREV_DIR="$SG_DIR"
SG_SUBSHELL_DIR=''

sg_expand() {
  sg_out="$1"
  case "$sg_out" in
    *'$'* | '~' | '~/'*) ;;
    *) printf '%s' "$sg_out"; return 0 ;;
  esac
  while IFS= read -r sg_var_line; do
    [ -n "$sg_var_line" ] || continue
    sg_var_name="${sg_var_line%%=*}"
    sg_var_value="${sg_var_line#*=}"
    sg_out="${sg_out//\$\{$sg_var_name\}/$sg_var_value}"
    sg_out="${sg_out//\$$sg_var_name/$sg_var_value}"
  done <<SG_VARS_EOF
$SG_VARS
SG_VARS_EOF
  case "$sg_out" in
    '~' | '~/'*) sg_out="${HOME}${sg_out#\~}" ;;
  esac
  printf '%s' "$sg_out"
}

sg_resolve_dir() {
  sg_target="$(sg_expand "$1")"
  case "$sg_target" in
    '') printf '%s' "${HOME:-$SG_DIR}" ;;
    -) printf '%s' "$SG_PREV_DIR" ;;
    /*) sg_canon "$sg_target" ;;
    *) sg_canon "$SG_DIR/$sg_target" ;;
  esac
}

sg_port_mentioned() {
  printf '%s\n' "$1" | grep -Eq "(^|[^0-9])$SG_PORT([^0-9]|$)" 2>/dev/null
}

# 引数: 元セグメント (引用符除去前), 以降 kill の引数列。
sg_check_kill_segment() {
  sg_raw="$1"
  shift
  # `$(... <port> ...)` / バッククォートの結果、または `lsof ... <port> | xargs kill` の形。
  if sg_port_mentioned "$sg_raw"; then
    case "$sg_raw" in
      *'$('* | *'`'*) sg_deny_kill "\$(...) で port $SG_PORT から引いた PID" ;;
      *'|'*) sg_deny_kill "パイプで port $SG_PORT から流した PID" ;;
    esac
  fi
  sg_skip_next=''
  for sg_arg in "$@"; do
    if [ -n "$sg_skip_next" ]; then
      sg_skip_next=''
      continue
    fi
    case "$sg_arg" in
      -0 | -l | -L | --list | --table) return 0 ;;
      -s | -n | --signal) sg_skip_next='yes' ;;
      -*) ;;
      '$'*)
        sg_var_ref="${sg_arg#\$}"
        sg_var_ref="${sg_var_ref#\{}"
        sg_var_ref="${sg_var_ref%\}}"
        case " $SG_PORT_VARS " in
          *" $sg_var_ref "*) sg_deny_kill "\$$sg_var_ref (port $SG_PORT の listener から代入した PID)" ;;
        esac
        ;;
      *[!0-9]*) ;;
      '') ;;
      *)
        if sg_pid_is_live_server "$sg_arg"; then
          sg_deny_kill "PID $sg_arg"
        fi
        ;;
    esac
  done
  return 0
}

# 引数: 実効 dir, 規則ラベル, 説明。サブエージェントかつ main checkout なら deny。
sg_check_main_action() {
  [ -n "$SG_IS_SUB" ] || return 0
  sg_dir_is_main "$1" || return 0
  sg_deny_sub "$2" "$3"
}

sg_effective_port_is_server() {
  sg_env_port="$(sg_expand '$BDBOARD_PORT')"
  [ "$sg_env_port" = '$BDBOARD_PORT' ] || [ "$sg_env_port" = "$SG_PORT" ]
}

set -f
while IFS= read -r sg_seg; do
  # 先頭の空白と ( { を落とす。( で始まるサブシェルは閉じ ) で cd を巻き戻す。
  sg_seg="${sg_seg#"${sg_seg%%[![:space:]]*}"}"
  [ -n "$sg_seg" ] || continue
  case "$sg_seg" in
    '('*)
      SG_SUBSHELL_DIR="$SG_DIR"
      sg_seg="${sg_seg#\(}"
      sg_seg="${sg_seg#"${sg_seg%%[![:space:]]*}"}"
      ;;
    '{'*)
      sg_seg="${sg_seg#\{}"
      sg_seg="${sg_seg#"${sg_seg%%[![:space:]]*}"}"
      ;;
  esac
  sg_closes_subshell=''
  case "$sg_seg" in *')') sg_closes_subshell='yes' ;; esac

  # 先頭の NAME=値 (export 付き含む) を記録して剥がす。値に $(…) と port があれば PID 由来。
  while printf '%s\n' "$sg_seg" | grep -Eq '^(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*=' 2>/dev/null; do
    sg_seg="${sg_seg#export}"
    sg_seg="${sg_seg#"${sg_seg%%[![:space:]]*}"}"
    sg_assign_name="${sg_seg%%=*}"
    sg_rest="${sg_seg#*=}"
    case "$sg_rest" in
      '$('* | '`'*)
        sg_port_mentioned "$sg_rest" && SG_PORT_VARS="$SG_PORT_VARS $sg_assign_name"
        sg_seg=''
        ;;
      '"'* | "'"*)
        sg_quote="${sg_rest:0:1}"
        sg_rest="${sg_rest#?}"
        sg_assign_value="${sg_rest%%$sg_quote*}"
        sg_seg="${sg_rest#*$sg_quote}"
        SG_VARS="$SG_VARS$SG_NL$sg_assign_name=$(sg_expand "$sg_assign_value")"
        ;;
      *)
        sg_assign_value="${sg_rest%%[[:space:]]*}"
        sg_seg="${sg_rest#"$sg_assign_value"}"
        SG_VARS="$SG_VARS$SG_NL$sg_assign_name=$(sg_expand "$sg_assign_value")"
        ;;
    esac
    sg_seg="${sg_seg#"${sg_seg%%[![:space:]]*}"}"
    [ -n "$sg_seg" ] || break
  done
  if [ -z "$sg_seg" ]; then
    if [ -n "$sg_closes_subshell" ] && [ -n "$SG_SUBSHELL_DIR" ]; then
      SG_DIR="$SG_SUBSHELL_DIR"
      SG_SUBSHELL_DIR=''
    fi
    continue
  fi

  sg_raw_seg="$sg_seg"
  sg_clean="$(printf '%s' "$sg_seg" | tr -d '"'"'"')')"
  # shellcheck disable=SC2086
  set -- $sg_clean

  # nohup / exec / command / time / sudo / env VAR=x の前置きを飛ばして本体のコマンド語へ。
  while [ $# -gt 0 ]; do
    case "$1" in
      nohup | exec | command | builtin | time | sudo | caffeinate) shift ;;
      env)
        shift
        while [ $# -gt 0 ]; do
          case "$1" in *=*) shift ;; *) break ;; esac
        done
        ;;
      *) break ;;
    esac
  done
  [ $# -gt 0 ] || continue
  sg_word="${1##*/}"

  # 再起動スクリプトの呼び出し (bash path/to/script.sh ... / ./script.sh ...)。
  # bdboard-wa48: 以前はセグメント中の全引数位置に basename 一致を見ていたため、
  # ファイル名を検索語や grep パターン、コミットメッセージに含めただけの
  # `bd search "always-on-server.sh"` / `grep always-on-server.sh` /
  # `git log -S always-on-server.sh` まで誤って deny していた。
  # 通常のコマンド (grep/cat/bd/git 等) はコマンド語そのもの、または
  # インタプリタ/ラッパー語の直後の引数だけを見る。逆に bash/sh/zsh 等の
  # インタプリタや timeout/env/nice/xargs/watch/stdbuf のようなラッパー、
  # `$(...)`/バッククォートで始まる未解決のコマンド語のときは、迂回
  # (`bash -x script.sh`、`timeout 600 script.sh`、`env -i bash script.sh`、
  # `source script.sh` 等) を見逃さないよう元の全引数走査に戻す。
  # レビュー (opus, 2026-09-25) で両方の抜けが実測されている。
  if [ -n "$SG_SCRIPT_BASE" ] && [ -n "$SG_IS_SUB" ]; then
    sg_restart_wide_scan=''
    case "$sg_word" in
      bash | sh | zsh | dash | ksh | . | source | timeout | nice | env | xargs | watch | stdbuf)
        sg_restart_wide_scan='yes'
        ;;
      '$('* | '`'*)
        sg_restart_wide_scan='yes'
        ;;
      -*)
        # 未知のフラグが残っている = 手前の env/timeout 等のフラグをこの関数の
        # プレフィックス剥がしが解決しきれなかった (例 `env -i bash script.sh`)。
        # コマンド語が確定していないので安全側 (全引数走査) に倒す。
        sg_restart_wide_scan='yes'
        ;;
    esac
    if [ -n "$sg_restart_wide_scan" ]; then
      for sg_tok in "$@"; do
        if [ "${sg_tok##*/}" = "$SG_SCRIPT_BASE" ]; then
          sg_deny_sub '7b-restart-script' "再起動スクリプト ($SG_SCRIPT_BASE) の実行"
        fi
      done
    elif [ "$sg_word" = "$SG_SCRIPT_BASE" ]; then
      sg_deny_sub '7b-restart-script' "再起動スクリプト ($SG_SCRIPT_BASE) の実行"
    fi
  fi

  case "$sg_word" in
    cd | pushd)
      SG_PREV_DIR="$SG_DIR"
      SG_DIR="$(sg_resolve_dir "${2:-}")"
      ;;
    popd)
      SG_DIR="$SG_PREV_DIR"
      ;;
    git)
      shift
      sg_git_dir="$SG_DIR"
      while [ $# -gt 0 ]; do
        case "$1" in
          -C) sg_git_dir="$(sg_resolve_dir "${2:-}")"; shift; shift ;;
          -c | --git-dir | --work-tree | --namespace) shift; shift ;;
          -*) shift ;;
          *) break ;;
        esac
      done
      if [ "${1:-}" = 'pull' ]; then
        sg_check_main_action "$sg_git_dir" '7a-git-pull' 'git pull'
      fi
      ;;
    npm)
      shift
      sg_npm_dir="$SG_DIR"
      while [ $# -gt 0 ]; do
        case "$1" in
          --prefix | -C) sg_npm_dir="$(sg_resolve_dir "${2:-}")"; shift; shift ;;
          --prefix=*) sg_npm_dir="$(sg_resolve_dir "${1#--prefix=}")"; shift ;;
          -*) shift ;;
          *) break ;;
        esac
      done
      sg_npm_script=''
      case "${1:-}" in
        start) sg_npm_script='start' ;;
        run | run-script) sg_npm_script="${2:-}" ;;
      esac
      # BDBOARD_PORT=<別ポート> の前置きがあれば常時稼働サーバーの port ではない (worktree
      # の一時サーバー)。ただし main checkout の判定はそのまま効く。
      if [ "$sg_npm_script" = 'start' ] && sg_effective_port_is_server; then
        sg_check_main_action "$sg_npm_dir" '7b-npm-start' 'サーバー起動 (npm run start)'
      fi
      ;;
    npx | tsx | node)
      for sg_tok in "$@"; do
        case "$sg_tok" in
          */src/main.ts | src/main.ts)
            sg_main_dir="$SG_DIR"
            case "$sg_tok" in /*) sg_main_dir="${sg_tok%/src/main.ts}" ;; esac
            if sg_effective_port_is_server; then
              sg_check_main_action "$sg_main_dir" '7b-tsx-main' 'サーバー起動 (tsx src/main.ts)'
            fi
            ;;
        esac
      done
      ;;
    kill)
      if [ -z "$SG_OVERRIDE" ] || [ -n "$SG_IS_SUB" ]; then
        shift
        sg_check_kill_segment "$sg_raw_seg" "$@"
      fi
      ;;
    *)
      # `lsof ... <port> ... | xargs kill` のようにコマンド語が kill でないパイプ。
      case "$sg_raw_seg" in
        *'|'*kill*)
          if [ -z "$SG_OVERRIDE" ] || [ -n "$SG_IS_SUB" ]; then
            sg_check_kill_segment "$sg_raw_seg"
          fi
          ;;
      esac
      ;;
  esac

  if [ -n "$sg_closes_subshell" ] && [ -n "$SG_SUBSHELL_DIR" ]; then
    SG_DIR="$SG_SUBSHELL_DIR"
    SG_SUBSHELL_DIR=''
  fi
done <<SG_SEGMENTS_EOF
$SG_SEGMENTS
SG_SEGMENTS_EOF
set +f

return 0
