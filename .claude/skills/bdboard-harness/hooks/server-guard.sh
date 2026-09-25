# shellcheck shell=bash
# server-guard.sh — pre-bash-guard.sh の規則 7「常時稼働サーバーの保護」(bdboard-hpu8) と
# 規則 8「main checkout の working tree/HEAD を変える git 操作」(bdboard-kxqb)。
#
# 単独では実行しない。pre-bash-guard.sh の規則 6 の直後から `.` で読み込まれ、呼び出し元の
#   COMMAND / HOOK_CWD / REPO_ROOT / CONTRACT / JSON_TOOL / AGENT_ID
#   deny() / matches()
# を前提にする。別ファイルなのは pre-bash-guard.sh の行数上限 (file-size-baseline 900 行)
# を守るため。判定できないものは `return 0` で呼び出し元へ戻す (fail-open)。
#
# 規則 7 は契約 (.claude/bdboard-harness.json) に alwaysOnServer.port があるときだけ有効。
#
#   7a. サブエージェント (hook 入力に agent_id がある) から main checkout での git pull
#       (alwaysOnServer.port 前提。サーバー再配備文脈の専用メッセージを持つ — 規則 8 の
#       pull 対応 (下記) とは目的が異なるので併存させている)
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
# 規則 8 は alwaysOnServer の有無に関係なく有効 (main checkout の working tree/HEAD を
# 保護すること自体は常時稼働サーバーの有無と独立の理由による — 議長が main checkout を
# 常用する運用 (bdboard-kxqb) では、サブエージェントの checkout / commit / reset / merge 等が
# 議長の作業ツリーを直接壊しうる)。サブエージェント (agent_id あり) が main checkout を
# 対象に git checkout / switch / commit / reset / merge / rebase / stash / restore /
# cherry-pick / revert / am / clean / bisect / apply / rm / mv / pull を実行するのを deny
# する (opus レビュー 2026-09-25 で clean/bisect/apply/rm/mv の抜けを指摘され追加)。pull は
# bdboard-rj7y (2026-09-26) で追加: alwaysOnServer.port を宣言しないパック配布先では 7a
# だけでは pull が fail-open のままだったため、working tree/HEAD 変更系として 7a とは独立に
# (port の有無に関係なく) 規則 8 でも塞ぐことにした — port ありの契約では 7a が先に発火する
# ので二重の deny メッセージにはならない。worktree add/remove/list・branch (削除含む)・
# push・fetch・remote・log 等の読み取り/非破壊系は引き続き対象外。
#
# 限界 (hooks/README.md「規則 7」「規則 8」に明記): 実効ディレクトリは cwd と `cd` の静的
# 追跡、変数は同一コマンド内の `NAME=値` 代入だけ解決する。別ファイルに書いて実行する迂回は
# 見えない。preview_start (MCP) は Bash ではないのでこの hook の対象外。

# --- 0. 前置フィルタ: 関係しうる語が無ければ何もしない (git status 等の頻出コマンドは
#        契約を読む前に通す。契約の読み取りは jq/python3 の起動を伴う)。
matches '(^|[^[:alnum:]_.-])(kill|git|npm|npx|tsx|node|pushd|sed|cp|mv|tee|aimix)([^[:alnum:]_-]|$)|\.sh([^[:alnum:]_-]|$)|>' || return 0

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

# SG_PORT が空/非数値なら規則 7 (port 依存の 7a/7b/7c) は無効化するだけで、ここでは
# return しない — 規則 8 (main checkout の git 保護) は alwaysOnServer の有無に関係なく
# 動く必要があるため (下の各呼び出し箇所で `[ -n "$SG_PORT" ]` を個別に見る)。
SG_PORT="$(server_contract_field port)"
case "$SG_PORT" in
  '' | *[!0-9]*) SG_PORT='' ;;
esac
SG_SCRIPT="$(server_contract_field restartScript)"
SG_SCRIPT_BASE="${SG_SCRIPT##*/}"

# --- 1. main checkout の場所判定は lib-main-checkout.sh に一本化する (bdboard-kxqb:
#        pre-edit-guard.sh の規則 2 と同じロジックを共有するため。二重実装しない)。
LIB_MAIN_CHECKOUT="$(dirname "$0")/lib-main-checkout.sh"
[ -r "$LIB_MAIN_CHECKOUT" ] || return 0
# shellcheck source=lib-main-checkout.sh
. "$LIB_MAIN_CHECKOUT"

sg_canon() { bh_canon "$1"; }

SG_MAIN="$(bh_main_checkout "$HOOK_CWD")"
[ -n "$SG_MAIN" ] || return 0

sg_dir_is_main() {
  bh_dir_is_main "$1" "$SG_MAIN"
}

# bdboard-1zrs: sg_dir_is_main に加えて main checkout の共有 .git/ 配下も真を返す版。
# このPRが追加した書き込み系チェック (sg_check_main_write / sg_check_main_write_targets)
# 専用。既存の git サブコマンド判定 (sg_check_main_git_mutate 等) は sg_dir_is_main のまま
# 変更しない (bdboard-1ef8 で明示的にスコープ外とした挙動を維持するため)。
sg_dir_is_main_or_git_internal() {
  bh_dir_is_main_or_git_internal "$1" "$SG_MAIN"
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

# bdboard-qj0t: 部品 (mask/dir/git/write) を lib に分割。ソースする順序は動作に影響しない
# (bash の関数解決は呼び出し時であり読み込み時ではない。4ファイルはトップレベルで互いを
# 参照しない)。読みやすさのためこの順で並べている。
LIB_SG_MASK="$(dirname "$0")/lib-sg-mask.sh"
[ -r "$LIB_SG_MASK" ] || return 0
# shellcheck source=lib-sg-mask.sh
. "$LIB_SG_MASK"
LIB_SG_DIR="$(dirname "$0")/lib-sg-dir.sh"
[ -r "$LIB_SG_DIR" ] || return 0
# shellcheck source=lib-sg-dir.sh
. "$LIB_SG_DIR"
LIB_SG_GIT="$(dirname "$0")/lib-sg-git.sh"
[ -r "$LIB_SG_GIT" ] || return 0
# shellcheck source=lib-sg-git.sh
. "$LIB_SG_GIT"
LIB_SG_WRITE="$(dirname "$0")/lib-sg-write.sh"
[ -r "$LIB_SG_WRITE" ] || return 0
# shellcheck source=lib-sg-write.sh
. "$LIB_SG_WRITE"

SG_MASKED_COMMAND="$(sg_mask_quoted_separators "$COMMAND")"
SG_SEGMENTS="${SG_MASKED_COMMAND//\\$SG_NL/ }"
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
  # bdboard-w8ad opus レビュー (B1, 2026-09-26): 末尾が ')' かどうかだけを見ると
  # `X=$(cmd)` のようにセグメント自身の中で閉じている $(...) の ')' まで
  # 「サブシェルを閉じた」と誤判定し、SG_DIR を早戻ししてしまう
  # (`(cd $MAIN && BR=$(git branch --show-current) && git checkout -b tmp)` で
  # 2番目のセグメントの誤判定により3番目の git checkout が main 判定から漏れる)。
  # 空白位置に依存せず、このセグメント内の '(' と ')' の個数を数え、')' が
  # '(' より多い場合だけ「外側の開いたサブシェルを閉じている」とみなす
  # ($(...) 等セグメント内で開閉が対になっているものは差し引きゼロになる)。
  sg_paren_open="${sg_seg//[^(]/}"
  sg_paren_close="${sg_seg//[^)]/}"
  sg_closes_subshell=''
  if [ "${#sg_paren_close}" -gt "${#sg_paren_open}" ]; then
    sg_closes_subshell='yes'
  fi

  # 先頭の NAME=値 (export 付き含む) を記録して剥がす。値に $(…) と port があれば PID 由来。
  sg_git_env_override=''
  while printf '%s\n' "$sg_seg" | grep -Eq '^(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*=' 2>/dev/null; do
    sg_seg="${sg_seg#export}"
    sg_seg="${sg_seg#"${sg_seg%%[![:space:]]*}"}"
    sg_assign_name="${sg_seg%%=*}"
    case "$sg_assign_name" in
      GIT_DIR | GIT_WORK_TREE) sg_git_env_override='yes' ;;
    esac
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

  # nohup / exec / command / time / sudo / env VAR=x 等の前置きを飛ばして本体のコマンド語へ。
  # bdboard-w8ad opus レビュー (R2, 2026-09-26): if/while/until/elif だけでなく、対になる
  # then/do/else と否定の ! も同じ理由 (予約語・演算子はコマンド語になり得ないので
  # 前置き扱いにしても誤許可のリスクがゼロ) で読み飛ばす対象に加える
  # (`if true; then git commit -m x; fi` / `for i in 1; do git commit -m x; done` /
  # `! git commit -m x` のような、本体が then/do/else の直後や ! の直後に来る形)。
  while [ $# -gt 0 ]; do
    case "$1" in
      nohup | exec | command | builtin | time | sudo | caffeinate | nice | if | while | until | elif | then | do | else | '!') shift ;;
      timeout)
        shift
        # bdboard-w8ad opus レビュー (B2, 2026-09-26): 無条件に次の1トークンを
        # 「DURATION」とみなして読み飛ばすと、`timeout -s KILL 600 cmd` のように
        # オプション付きの timeout ではオプション語 (-s) を DURATION と誤認して
        # 読み飛ばし、その次のオプション値 (KILL) が sg_word になってしまう。
        # KILL は後段の規則7bワイド走査トリガー一覧にもフラグ判定 (-*) にも
        # 引っかからないため、restart スクリプト保護がすり抜ける
        # (timeout -s KILL 600 scripts/always-on-server.sh restart 等)。
        # 次トークンが '-' 始まりのオプションに見える場合は読み飛ばさずループを
        # 打ち切る。$1 がオプション文字列のまま残るので、規則7bワイド走査の
        # 「未知のフラグが残っている ⇒ 全引数走査」フォールバック (-*) が
        # 正しく発火する (安全側)。DURATION らしい非オプション語のときだけ、
        # 従来どおり1トークン読み飛ばす。
        case "$1" in
          -*) ;;
          *) [ $# -gt 0 ] && shift ;;
        esac
        ;;
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
  case "$1" in \\*) set -- "${1#\\}" "${@:2}" ;; esac
  sg_word="${1##*/}"

  # --- bdboard-1zrs: リダイレクト検知。sg_word によるコマンド語ディスパッチとは独立に
  # このセグメントの全トークンを一度スキャンする (`exec > file` のように exec 剥がし後に
  # リダイレクト演算子そのものが $1 に来る形にも対応するため)。空白あり (`> file`) と
  # 空白なし (`>file`)、fd 接頭辞 (1>, 2>, &>) と追記形 (>>, 1>>, 2>>, &>>) の両方を見る。
  # 長い演算子を短い演算子より先にマッチさせる (例 `>>file` が `>` 側に誤って
  # マッチして "> file" を作らないよう、`>>` は `>` より前に判定する)。
  # `N>&M` / `>&-` のような fd 複製・close はファイルパスではないので対象外。
  # 引用符/ヒアドキュメント本体内の `>` は手順2のマスキングで既に空白化されている前提
  # (誤検知回避: コミットメッセージ中の "fix: a > b" 等)。
  sg_redirect_args=("$@")
  sg_redirect_argc=${#sg_redirect_args[@]}
  sg_redirect_i=0
  while [ "$sg_redirect_i" -lt "$sg_redirect_argc" ]; do
    sg_rtok="${sg_redirect_args[$sg_redirect_i]}"
    sg_rop_matched=''
    sg_rrest=''
    case "$sg_rtok" in
      '&>>'*) sg_rop_matched='yes'; sg_rrest="${sg_rtok#'&>>'}" ;;
      '&>'*) sg_rop_matched='yes'; sg_rrest="${sg_rtok#'&>'}" ;;
      '1>>'*) sg_rop_matched='yes'; sg_rrest="${sg_rtok#'1>>'}" ;;
      '1>'*) sg_rop_matched='yes'; sg_rrest="${sg_rtok#'1>'}" ;;
      '2>>'*) sg_rop_matched='yes'; sg_rrest="${sg_rtok#'2>>'}" ;;
      '2>'*) sg_rop_matched='yes'; sg_rrest="${sg_rtok#'2>'}" ;;
      '>>'*) sg_rop_matched='yes'; sg_rrest="${sg_rtok#'>>'}" ;;
      '>'*) sg_rop_matched='yes'; sg_rrest="${sg_rtok#'>'}" ;;
    esac
    if [ -n "$sg_rop_matched" ]; then
      sg_rtarget="$sg_rrest"
      if [ -z "$sg_rtarget" ]; then
        sg_rnext_i=$((sg_redirect_i + 1))
        if [ "$sg_rnext_i" -lt "$sg_redirect_argc" ]; then
          sg_rtarget="${sg_redirect_args[$sg_rnext_i]}"
        fi
      fi
      case "$sg_rtarget" in
        '&'[0-9]* | '&-') sg_rtarget='' ;;
      esac
      if [ -n "$sg_rtarget" ]; then
        sg_check_main_write_targets 'redirect' 'リダイレクトでの書き込み' "$sg_rtarget"
      fi
    fi
    sg_redirect_i=$((sg_redirect_i + 1))
  done

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
  # bdboard-qmum: status / --help / -h は SKILL.md (bdboard-server-ops) が「誰でも可」と
  # 明記する読み取り専用サブコマンド。再起動スクリプトの直後の引数がこの3つのどれかのときだけ
  # deny をスキップする。それ以外 (restart / start / deploy / 引数無し / 未知の引数) は
  # 従来どおり deny する。
  sg_restart_subcmd_is_safe() {
    case "$1" in
      status | --help | -h) return 0 ;;
      *) return 1 ;;
    esac
  }
  if [ -n "$SG_PORT" ] && [ -n "$SG_SCRIPT_BASE" ] && [ -n "$SG_IS_SUB" ]; then
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
      sg_restart_args=("$@")
      sg_restart_argc=${#sg_restart_args[@]}
      # bdboard-qmum (opus レビュー追加分): ワイド走査は「スクリプトパスの次の
      # トークン」を安全判定の材料にしているが、`bash -c '...' script.sh status`
      # のような -c 呼び出しでは、クォート除去後にフラットな引数列へ潰れた時点で
      # スクリプトパスの直後に来るトークンは「-c 文字列に渡る位置引数 ($0 等)」で
      # あって、実際にスクリプトへ渡る本当のサブコマンドではない (例: 上の例だと
      # -c 文字列の中の "restart" が本体で、"status" は無関係な位置引数)。位置関係
      # からは -c 文字列の中身を安全に復元できないため、このセグメントに -c/--command
      # トークンや $ で始まるトークン (位置引数・変数参照の疑い) が1つでもあれば、
      # 「隣のトークンで安全と判定する」のを諦めて無条件に deny する (安全側)。
      sg_restart_unsafe_ctx=''
      sg_restart_i=0
      while [ "$sg_restart_i" -lt "$sg_restart_argc" ]; do
        sg_tok="${sg_restart_args[$sg_restart_i]}"
        case "$sg_tok" in
          -c | --command) sg_restart_unsafe_ctx='yes' ;;
          '$'*) sg_restart_unsafe_ctx='yes' ;;
        esac
        sg_restart_i=$((sg_restart_i + 1))
      done
      sg_restart_i=0
      while [ "$sg_restart_i" -lt "$sg_restart_argc" ]; do
        sg_tok="${sg_restart_args[$sg_restart_i]}"
        if [ "${sg_tok##*/}" = "$SG_SCRIPT_BASE" ]; then
          sg_restart_next=''
          sg_restart_next_i=$((sg_restart_i + 1))
          if [ "$sg_restart_next_i" -lt "$sg_restart_argc" ]; then
            sg_restart_next="${sg_restart_args[$sg_restart_next_i]}"
          fi
          if [ -n "$sg_restart_unsafe_ctx" ] || ! sg_restart_subcmd_is_safe "$sg_restart_next"; then
            sg_deny_sub '7b-restart-script' "再起動スクリプト ($SG_SCRIPT_BASE) の実行"
          fi
        fi
        sg_restart_i=$((sg_restart_i + 1))
      done
    elif [ "$sg_word" = "$SG_SCRIPT_BASE" ]; then
      if ! sg_restart_subcmd_is_safe "${2:-}"; then
        sg_deny_sub '7b-restart-script' "再起動スクリプト ($SG_SCRIPT_BASE) の実行"
      fi
    fi
  fi

  case "$sg_word" in
    cd | pushd)
      sg_new_dir="$(sg_resolve_dir "${2:-}")"
      SG_PREV_DIR="$SG_DIR"
      SG_DIR="$sg_new_dir"
      ;;
    popd)
      SG_DIR="$SG_PREV_DIR"
      ;;
    git)
      sg_handle_git_tokens "$SG_DIR" "$sg_git_env_override" "$@"
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
      if [ -n "$SG_PORT" ] && [ "$sg_npm_script" = 'start' ] && sg_effective_port_is_server; then
        sg_check_main_action "$sg_npm_dir" '7b-npm-start' 'サーバー起動 (npm run start)'
      fi
      # bdboard-1zrs: npm install/ci は node_modules・package-lock.json を書き換える。
      # サーバー再配備 (規則7b) とは独立の理由 (working tree破壊) のため、SG_PORT の
      # 有無に関係なく常に有効 (git-mutate と同じ扱い)。
      case "${1:-}" in
        install | i | ci) sg_check_main_write "$sg_npm_dir" 'npm-install' "npm $1" ;;
      esac
      ;;
    sed)
      shift
      sg_sed_has_i=''
      sg_sed_targets=()
      sg_sed_saw_script=''
      while [ $# -gt 0 ]; do
        if sg_is_scan_stop_tok "$1"; then
          break
        fi
        if sg_is_skippable_redirect_tok "$1"; then
          if sg_redirect_tok_needs_next "$1"; then
            shift
            [ $# -gt 0 ] && shift
          else
            shift
          fi
          continue
        fi
        case "$1" in
          --e*=*) sg_sed_saw_script='yes'; shift ;;
          --e*) sg_sed_saw_script='yes'; shift; shift ;;
          --f*=*) sg_sed_saw_script='yes'; shift ;;
          --f*) sg_sed_saw_script='yes'; shift; shift ;;
          --i*) sg_sed_has_i='yes'; shift ;;
          --l*=*) shift ;;
          --l*) shift; shift ;;
          --*) shift ;;
          -*)
            sg_sed_parse_flag_group "$1"
            shift
            [ -n "$sg_sgf_consumed_next" ] && shift
            ;;
          *)
            if [ -z "$sg_sed_saw_script" ]; then
              sg_sed_saw_script='yes'
            else
              sg_sed_targets+=("$1")
            fi
            shift
            ;;
        esac
      done
      if [ -n "$sg_sed_has_i" ] && [ ${#sg_sed_targets[@]} -gt 0 ]; then
        sg_check_main_write_targets 'sed' 'sed -i での書き込み' "${sg_sed_targets[@]}"
      fi
      ;;
    cp | mv)
      shift
      sg_cpmv_dest=''
      sg_cpmv_last=''
      while [ $# -gt 0 ]; do
        if sg_is_scan_stop_tok "$1"; then
          break
        fi
        if sg_is_skippable_redirect_tok "$1"; then
          if sg_redirect_tok_needs_next "$1"; then
            shift
            [ $# -gt 0 ] && shift
          else
            shift
          fi
          continue
        fi
        case "$1" in
          -t | --target-directory) sg_cpmv_dest="${2:-}"; shift; shift ;;
          --target-directory=*) sg_cpmv_dest="${1#--target-directory=}"; shift ;;
          -*) shift ;;
          *) sg_cpmv_last="$1"; shift ;;
        esac
      done
      [ -n "$sg_cpmv_dest" ] || sg_cpmv_dest="$sg_cpmv_last"
      if [ -n "$sg_cpmv_dest" ]; then
        sg_check_main_write_targets "$sg_word" "$sg_word コマンドでの書き込み" "$sg_cpmv_dest"
      fi
      ;;
    tee)
      shift
      sg_tee_targets=()
      while [ $# -gt 0 ]; do
        if sg_is_scan_stop_tok "$1"; then
          break
        fi
        if sg_is_skippable_redirect_tok "$1"; then
          if sg_redirect_tok_needs_next "$1"; then
            shift
            [ $# -gt 0 ] && shift
          else
            shift
          fi
          continue
        fi
        case "$1" in
          -*) ;;
          *) sg_tee_targets+=("$1") ;;
        esac
        shift
      done
      if [ ${#sg_tee_targets[@]} -gt 0 ]; then
        sg_check_main_write_targets 'tee' 'tee コマンドでの書き込み' "${sg_tee_targets[@]}"
      fi
      ;;
    aimix)
      shift
      sg_aimix_dir="$SG_DIR"
      sg_aimix_sub=''
      while [ $# -gt 0 ]; do
        case "$1" in
          --cwd) sg_aimix_dir="$(sg_resolve_dir "${2:-}")"; shift; shift ;;
          --cwd=*) sg_aimix_dir="$(sg_resolve_dir "${1#--cwd=}")"; shift ;;
          -*) shift ;;
          *)
            [ -n "$sg_aimix_sub" ] || sg_aimix_sub="$1"
            shift
            ;;
        esac
      done
      if [ "$sg_aimix_sub" = 'run' ]; then
        sg_check_main_write "$sg_aimix_dir" 'aimix-delegate' 'aimix 経由の委譲実行 (Codex/Cursor 子プロセスが hook を経由せず書き込むため)'
      fi
      ;;
    npx | tsx | node)
      for sg_tok in "$@"; do
        case "$sg_tok" in
          */src/main.ts | src/main.ts)
            sg_main_dir="$SG_DIR"
            case "$sg_tok" in /*) sg_main_dir="${sg_tok%/src/main.ts}" ;; esac
            if [ -n "$SG_PORT" ] && sg_effective_port_is_server; then
              sg_check_main_action "$sg_main_dir" '7b-tsx-main' 'サーバー起動 (tsx src/main.ts)'
            fi
            ;;
        esac
      done
      ;;
    kill)
      if [ -n "$SG_PORT" ] && { [ -z "$SG_OVERRIDE" ] || [ -n "$SG_IS_SUB" ]; }; then
        shift
        sg_check_kill_segment "$sg_raw_seg" "$@"
      fi
      ;;
    *)
      # `lsof ... <port> ... | xargs kill` のようにコマンド語が kill でないパイプ。
      case "$sg_raw_seg" in
        *'|'*kill*)
          if [ -n "$SG_PORT" ] && { [ -z "$SG_OVERRIDE" ] || [ -n "$SG_IS_SUB" ]; }; then
            sg_check_kill_segment "$sg_raw_seg"
          fi
          ;;
      esac
      ;;
  esac

  case "$sg_raw_seg" in
    *'|'*) sg_check_pipe_git "$sg_raw_seg" "$SG_DIR" "$sg_git_env_override" ;;
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
