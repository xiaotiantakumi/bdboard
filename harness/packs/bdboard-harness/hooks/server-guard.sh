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
# cherry-pick / revert / am / clean / bisect / apply / rm / mv を実行するのを deny する
# (opus レビュー 2026-09-25 で clean/bisect/apply/rm/mv の抜けを指摘され追加)。
# pull は含まない — 元から 7a
# (SG_PORT 前提) の対象で、規則 8 はそこに無かった working tree/HEAD 変更系だけを追加で
# 塞ぐ (二重化しない。SG_PORT の無い契約では 7a 同様 pull は対象外のまま)。worktree
# add/remove/list・branch (削除含む)・push・fetch・remote・log 等の読み取り/非破壊系も対象外。
#
# 限界 (hooks/README.md「規則 7」「規則 8」に明記): 実効ディレクトリは cwd と `cd` の静的
# 追跡、変数は同一コマンド内の `NAME=値` 代入だけ解決する。別ファイルに書いて実行する迂回は
# 見えない。preview_start (MCP) は Bash ではないのでこの hook の対象外。

# --- 0. 前置フィルタ: 関係しうる語が無ければ何もしない (git status 等の頻出コマンドは
#        契約を読む前に通す。契約の読み取りは jq/python3 の起動を伴う)。
matches '(^|[^[:alnum:]_./-])(kill|git|npm|npx|tsx|node|pushd|sed|cp|mv|tee|aimix)([^[:alnum:]_-]|$)|\.sh([^[:alnum:]_-]|$)|>' || return 0

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

# bdboard-kmh2: 上の分割はシェルの引用を理解しない素朴な文字列置換なので、引用符
# ('...' / "..." 。複数行にまたがるものを含む) の中にある ; & | や改行までセグメント境界
# として扱ってしまう (例: git commit -m "fix: guard; ..." のようにコミットメッセージの
# 引用符内に ; がある場合)。分割の前に、引用符の中身だけ ; & | と改行を空白に置き換えて
# 無害化する。引用符の外側や中身の他の文字は一切変えない — 分割の判定材料はそのまま残す
# (「言及しただけ」を deny する設計 (bdboard-wa48) 自体は変えない)。
#
# bdboard-qmum の opus レビュー (PR #767) で、最初の実装 (引用符を単純な状態機械で追う
# だけで、# コメント・$(...) やバッククォートの入れ子・閉じられない引用符の扱いが甘い版)
# には「無害化のつもりが本物の区切り文字まで隠してしまい、本来 deny すべき危険なコマンドを
# 見逃す」という新規の穴が複数見つかった (例: コメント中のアポストロフィで状態が狂う、
# $(...) の中の入れ子の引用符でずれる)。今の実装はそれを踏まえて安全側に倒し直したもの:
#
# 安全側の原則: 「確実に引用符の中だと判定できる場合だけ」区切り文字を無害化する。
# 判定に少しでも自信が持てない場合は、区切り文字を無害化せず残す (= 元の素朴な分割に
# 戻るだけで、誤検知が残る可能性はあっても見逃しにはならない)。
#
# 対応する範囲 (これ以上は「完全な shell パーサー」になるため対応しない):
#   - トップレベルの '...' と "..." の中身にある ; & | と改行を無害化する。
#   - # コメント (空白/行頭/;&|の直後などの語頭に現れたときだけ) は実改行まで丸ごと
#     読み飛ばし、中の引用符文字は一切解釈しない (bash 本体もコメント中は構文解析しない
#     ため、ここで引用符として数えると誤って状態がずれる — 過去の実装の穴の1つ)。
#   - $(...) とバッククォートは新しい入れ子として扱い、その中の引用符トグルが外側の
#     引用状態に漏れ出さないようにする。ただし $(...) 自身の中にある本物の ; & | と改行は
#     「無害化しない」(= 見える状態を保つ) — 元の素朴な分割がこれらを偶然にも区切りとして
#     捕まえていたのを壊さないため (bdboard-kmh2 の対象はあくまで「引用符の中の区切り文字」
#     で、$(...) の中身まで安全に解析する保証は無い)。
#   - ヒアドキュメント本体 (<<EOF / <<'EOF' / <<-EOF ... 対応する終端行まで) は bdboard-u4ne
#     (opus レビュー 2026-09-25, PR #790) 以降、専用の状態 (state h) で追跡し、区間内の
#     改行と ; & | を「引用符の中」と同様に無害化する。開始行の区切り文字 (<<・オプションの
#     `-`・区切り語の引用符有無) を検出してから終端行 (`-` 指定時は先頭タブを読み飛ばした上で
#     区切り語と完全一致する行。コマンド末尾で入力が尽きる場合も同様に終端とみなす) までを
#     1つの安全な区間として扱う。区切り語が数字だけで引用符も無い形 (`(( x << 2 ))` のような
#     算術左シフト) はヒアドキュメントと誤認しない。$(...) やバッククォートの入れ子と同様、
#     区間の終端が最後まで確定できない (入力が尽きても終端行が現れない) 場合は、無害化を
#     一切せず生のコマンドのまま返す (見逃しより誤検知)。
#   - $'...' (ANSI-C クォート) は専用の理解をしない。中身に応じて偶然に安全側 (下記の
#     「閉じられない/バランスしない場合は生のコマンドで判定」) に落ちる。
#   - 二重引用符内のバックスラッシュは、次の1文字を常にエスケープ (そのまま通す) と
#     みなす (`\"` に限らない — 限定すると `\\"` のような並びで閉じ引用符と誤認しうる)。
#   - 引用符の外側で `\'` / `\"` のようにバックスラッシュでエスケープされた引用符文字は
#     引用の開始とみなさない (誤ると、その後ろの本物の危険なコマンドを隠しかねない)。
#   - コマンド全体を走査し終えた時点で「トップレベルの引用/コメントが閉じている」かつ
#     「$(...) やバッククォートの入れ子がすべて閉じている」ことを確認する。どちらか一方
#     でも満たさなければ、無害化を一切せず**元の生のコマンドをそのまま返す** (= 分割は
#     完全に旧来の素朴な挙動に戻る。見逃しよりも誤検知が残る側に倒す)。
#   - 走査は文字ごとの状態機械で、大きな入力では bash の文字列連結コストにより遅くなる
#     (O(n^2))。hook 全体のタイムアウト (通常 10 秒) を超えないよう、コマンドが
#     SG_MASK_MAX_LEN 文字を超える場合は無害化を試みず生のコマンドをそのまま返す。
SG_MASK_MAX_LEN=3000

sg_mask_quoted_separators() {
  sg_mqs_s="$1"
  case "$sg_mqs_s" in
    *[\'\"]*) ;;
    *'<<'*) ;;
    *) printf '%s' "$sg_mqs_s"; return 0 ;;
  esac
  sg_mqs_len=${#sg_mqs_s}
  if [ "$sg_mqs_len" -gt "$SG_MASK_MAX_LEN" ]; then
    printf '%s' "$sg_mqs_s"
    return 0
  fi
  sg_mqs_out=''
  sg_mqs_state='n'
  sg_mqs_stack=''
  sg_mqs_saved=''
  sg_mqs_wordstart=1
  sg_mqs_i=0
  sg_mqs_heredoc_pending=''
  sg_mqs_heredoc_delim=''
  sg_mqs_heredoc_strip=''
  sg_mqs_h_line=''
  while [ "$sg_mqs_i" -lt "$sg_mqs_len" ]; do
    sg_mqs_c="${sg_mqs_s:sg_mqs_i:1}"
    sg_mqs_next=''
    if [ $((sg_mqs_i + 1)) -lt "$sg_mqs_len" ]; then
      sg_mqs_next="${sg_mqs_s:sg_mqs_i+1:1}"
    fi
    case "$sg_mqs_state" in
      c)
        # # コメント: 実改行まで無解釈で素通しする (引用符もトグルしない)。
        if [ "$sg_mqs_c" = "$SG_NL" ]; then
          sg_mqs_state='n'
        fi
        sg_mqs_out="$sg_mqs_out$sg_mqs_c"
        sg_mqs_i=$((sg_mqs_i + 1))
        case "$sg_mqs_c" in
          ' ' | '	' | "$SG_NL") sg_mqs_wordstart=1 ;;
          *) sg_mqs_wordstart=0 ;;
        esac
        continue
        ;;
      n)
        case "$sg_mqs_c" in
          \\)
            if [ -n "$sg_mqs_next" ]; then
              sg_mqs_out="$sg_mqs_out$sg_mqs_c$sg_mqs_next"
              sg_mqs_i=$((sg_mqs_i + 2))
              sg_mqs_wordstart=0
              continue
            fi
            ;;
          '#')
            if [ "$sg_mqs_wordstart" = 1 ]; then
              sg_mqs_state='c'
              sg_mqs_out="$sg_mqs_out$sg_mqs_c"
              sg_mqs_i=$((sg_mqs_i + 1))
              sg_mqs_wordstart=0
              continue
            fi
            ;;
          "'") sg_mqs_state="'" ;;
          '"') sg_mqs_state='"' ;;
          '$')
            if [ "$sg_mqs_next" = '(' ]; then
              sg_mqs_stack="${sg_mqs_stack}P"
              sg_mqs_saved="${sg_mqs_saved}n"
              sg_mqs_state='n'
              sg_mqs_out="$sg_mqs_out\$("
              sg_mqs_i=$((sg_mqs_i + 2))
              sg_mqs_wordstart=1
              continue
            fi
            ;;
          '`')
            sg_mqs_top=''
            if [ -n "$sg_mqs_stack" ]; then
              sg_mqs_slen=${#sg_mqs_stack}
              sg_mqs_top="${sg_mqs_stack:sg_mqs_slen-1:1}"
            fi
            if [ "$sg_mqs_top" = 'B' ]; then
              sg_mqs_slen=${#sg_mqs_stack}
              sg_mqs_state="${sg_mqs_saved:sg_mqs_slen-1:1}"
              sg_mqs_stack="${sg_mqs_stack:0:sg_mqs_slen-1}"
              sg_mqs_saved="${sg_mqs_saved:0:sg_mqs_slen-1}"
            else
              sg_mqs_stack="${sg_mqs_stack}B"
              sg_mqs_saved="${sg_mqs_saved}n"
              sg_mqs_state='n'
            fi
            sg_mqs_out="$sg_mqs_out$sg_mqs_c"
            sg_mqs_i=$((sg_mqs_i + 1))
            sg_mqs_wordstart=1
            continue
            ;;
          ')')
            sg_mqs_top=''
            if [ -n "$sg_mqs_stack" ]; then
              sg_mqs_slen=${#sg_mqs_stack}
              sg_mqs_top="${sg_mqs_stack:sg_mqs_slen-1:1}"
            fi
            if [ "$sg_mqs_top" = 'P' ]; then
              sg_mqs_slen=${#sg_mqs_stack}
              sg_mqs_state="${sg_mqs_saved:sg_mqs_slen-1:1}"
              sg_mqs_stack="${sg_mqs_stack:0:sg_mqs_slen-1}"
              sg_mqs_saved="${sg_mqs_saved:0:sg_mqs_slen-1}"
              sg_mqs_out="$sg_mqs_out$sg_mqs_c"
              sg_mqs_i=$((sg_mqs_i + 1))
              sg_mqs_wordstart=0
              continue
            fi
            ;;
        esac
        case "$sg_mqs_c" in
          '<')
            if [ -z "$sg_mqs_heredoc_pending" ] && [ "$sg_mqs_next" = '<' ]; then
              sg_mqs_h_after=''
              if [ $((sg_mqs_i + 2)) -lt "$sg_mqs_len" ]; then
                sg_mqs_h_after="${sg_mqs_s:sg_mqs_i+2:1}"
              fi
              if [ "$sg_mqs_h_after" != '<' ]; then
                sg_mqs_h_scan=$((sg_mqs_i + 2))
                sg_mqs_h_strip=''
                if [ "$sg_mqs_h_after" = '-' ]; then
                  sg_mqs_h_strip='yes'
                  sg_mqs_h_scan=$((sg_mqs_h_scan + 1))
                fi
                while [ "$sg_mqs_h_scan" -lt "$sg_mqs_len" ]; do
                  sg_mqs_h_ch="${sg_mqs_s:sg_mqs_h_scan:1}"
                  case "$sg_mqs_h_ch" in
                    ' ' | $'\t') sg_mqs_h_scan=$((sg_mqs_h_scan + 1)) ;;
                    *) break ;;
                  esac
                done
                sg_mqs_h_delim=''
                sg_mqs_h_quoted=''
                if [ "$sg_mqs_h_scan" -lt "$sg_mqs_len" ]; then
                  sg_mqs_h_open="${sg_mqs_s:sg_mqs_h_scan:1}"
                  case "$sg_mqs_h_open" in
                    "'" | '"')
                      sg_mqs_h_close_idx=-1
                      sg_mqs_h_j=$((sg_mqs_h_scan + 1))
                      while [ "$sg_mqs_h_j" -lt "$sg_mqs_len" ]; do
                        if [ "${sg_mqs_s:sg_mqs_h_j:1}" = "$sg_mqs_h_open" ]; then
                          sg_mqs_h_close_idx=$sg_mqs_h_j
                          break
                        fi
                        sg_mqs_h_j=$((sg_mqs_h_j + 1))
                      done
                      if [ "$sg_mqs_h_close_idx" -ge 0 ]; then
                        sg_mqs_h_delim="${sg_mqs_s:sg_mqs_h_scan+1:sg_mqs_h_close_idx-sg_mqs_h_scan-1}"
                        sg_mqs_h_scan=$((sg_mqs_h_close_idx + 1))
                        sg_mqs_h_quoted='yes'
                      fi
                      ;;
                    *)
                      sg_mqs_h_j=$sg_mqs_h_scan
                      while [ "$sg_mqs_h_j" -lt "$sg_mqs_len" ]; do
                        sg_mqs_h_ch="${sg_mqs_s:sg_mqs_h_j:1}"
                        case "$sg_mqs_h_ch" in
                          ' ' | $'\t' | "$SG_NL" | ';' | '&' | '|' | '<' | '>' | '(' | ')') break ;;
                        esac
                        sg_mqs_h_j=$((sg_mqs_h_j + 1))
                      done
                      if [ "$sg_mqs_h_j" -gt "$sg_mqs_h_scan" ]; then
                        sg_mqs_h_delim="${sg_mqs_s:sg_mqs_h_scan:sg_mqs_h_j-sg_mqs_h_scan}"
                        sg_mqs_h_scan=$sg_mqs_h_j
                      fi
                      ;;
                  esac
                fi
                # Unquoted numeric delimiters are arithmetic shifts, not heredocs.
                if [ -n "$sg_mqs_h_delim" ] && [ -z "$sg_mqs_h_quoted" ]; then
                  case "$sg_mqs_h_delim" in
                    *[!0-9]*) ;;
                    *) sg_mqs_h_delim='' ;;
                  esac
                fi
                if [ -n "$sg_mqs_h_delim" ]; then
                  sg_mqs_heredoc_pending='yes'
                  sg_mqs_heredoc_delim="$sg_mqs_h_delim"
                  sg_mqs_heredoc_strip="$sg_mqs_h_strip"
                  sg_mqs_out="$sg_mqs_out${sg_mqs_s:sg_mqs_i:sg_mqs_h_scan-sg_mqs_i}"
                  sg_mqs_i=$sg_mqs_h_scan
                  sg_mqs_wordstart=0
                  continue
                fi
              fi
            fi
            ;;
          "$SG_NL")
            if [ -n "$sg_mqs_heredoc_pending" ]; then
              sg_mqs_heredoc_pending=''
              sg_mqs_state='h'
              sg_mqs_h_line=''
              sg_mqs_c=' '
            fi
            ;;
        esac
        ;;
      h)
        sg_mqs_h_line="$sg_mqs_h_line$sg_mqs_c"
        case "$sg_mqs_c" in
          "$SG_NL")
            sg_mqs_h_check="${sg_mqs_h_line%"$SG_NL"}"
            if [ -n "$sg_mqs_heredoc_strip" ]; then
              while :; do
                case "$sg_mqs_h_check" in
                  $'\t'*) sg_mqs_h_check="${sg_mqs_h_check#?}" ;;
                  *) break ;;
                esac
              done
            fi
            sg_mqs_h_line=''
            if [ "$sg_mqs_h_check" = "$sg_mqs_heredoc_delim" ]; then
              # 終端行に一致: ヒアドキュメント本体を抜けるので、この実改行は
              # 「ヒアドキュメント終端直後に続く実コマンド」との本物の区切りとして
              # 残す (マスクしない)。ここで無条件に空白へ潰すと、終端直後の
              # `git checkout ...` 等が直前のコマンドと同じセグメントへ吸収され、
              # 規則 8 等のセグメント単位チェックから見えなくなる
              # (レビュー指摘: bdboard-u4ne PR #790 Blocker 1)。
              sg_mqs_state='n'
              sg_mqs_heredoc_delim=''
              sg_mqs_heredoc_strip=''
            else
              # 本体行の途中の実改行: 引き続き本体内なので従来どおりマスクする。
              sg_mqs_c=' '
            fi
            ;;
          ';' | '&' | '|' | '>') sg_mqs_c=' ' ;;
        esac
        ;;
      "'")
        case "$sg_mqs_c" in
          "'") sg_mqs_state='n' ;;
          ';' | '&' | '|' | '>') sg_mqs_c=' ' ;;
          "$SG_NL") sg_mqs_c=' ' ;;
        esac
        ;;
      '"')
        case "$sg_mqs_c" in
          \\)
            if [ -n "$sg_mqs_next" ]; then
              sg_mqs_out="$sg_mqs_out$sg_mqs_c$sg_mqs_next"
              sg_mqs_i=$((sg_mqs_i + 2))
              sg_mqs_wordstart=0
              continue
            fi
            ;;
          '"') sg_mqs_state='n' ;;
          '$')
            if [ "$sg_mqs_next" = '(' ]; then
              sg_mqs_stack="${sg_mqs_stack}P"
              sg_mqs_saved="${sg_mqs_saved}\""
              sg_mqs_state='n'
              sg_mqs_out="$sg_mqs_out\$("
              sg_mqs_i=$((sg_mqs_i + 2))
              sg_mqs_wordstart=1
              continue
            fi
            ;;
          '`')
            sg_mqs_stack="${sg_mqs_stack}B"
            sg_mqs_saved="${sg_mqs_saved}\""
            sg_mqs_state='n'
            sg_mqs_out="$sg_mqs_out$sg_mqs_c"
            sg_mqs_i=$((sg_mqs_i + 1))
            sg_mqs_wordstart=1
            continue
            ;;
          ';' | '&' | '|' | '>') sg_mqs_c=' ' ;;
          "$SG_NL") sg_mqs_c=' ' ;;
        esac
        ;;
    esac
    sg_mqs_out="$sg_mqs_out$sg_mqs_c"
    sg_mqs_i=$((sg_mqs_i + 1))
    case "$sg_mqs_c" in
      ' ' | '	' | "$SG_NL" | ';' | '&' | '|') sg_mqs_wordstart=1 ;;
      *) sg_mqs_wordstart=0 ;;
    esac
  done
  if [ "$sg_mqs_state" = 'h' ]; then
    sg_mqs_h_check="$sg_mqs_h_line"
    if [ -n "$sg_mqs_heredoc_strip" ]; then
      while :; do
        case "$sg_mqs_h_check" in
          $'\t'*) sg_mqs_h_check="${sg_mqs_h_check#?}" ;;
          *) break ;;
        esac
      done
    fi
    if [ "$sg_mqs_h_check" = "$sg_mqs_heredoc_delim" ]; then
      sg_mqs_state='n'
    fi
  fi
  if [ -n "$sg_mqs_stack" ]; then
    printf '%s' "$sg_mqs_s"
    return 0
  fi
  case "$sg_mqs_state" in
    n | c) printf '%s' "$sg_mqs_out" ;;
    *) printf '%s' "$sg_mqs_s" ;;
  esac
}

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

# --- 規則 8: main checkout の working tree/HEAD を変える git サブコマンド (bdboard-kxqb)。
# sg_deny_sub (規則 7 用) とはメッセージの趣旨が違う (常時稼働サーバーの再配備ではなく
# 「議長の作業ツリーを壊す」ことが理由) ので、専用の deny 文言を持つ。
sg_deny_git_mutate() {
  sg_audit "8-git-$1"
  deny \
    "bdboard-harness: サブエージェントは main checkout ($SG_MAIN) で git $1 を実行できません (working tree/HEAD を変更するため)。" \
    "worktree で作業してください: cd <worktree> && git $1 ... か git -C <worktree> $1 ... を使ってください。" \
    "worktree が無ければ: git -C $SG_MAIN worktree add .claude/worktrees/<id> -b bd/<id> origin/main"
}

# 引数: 実効 dir, サブコマンド名。サブエージェントかつ main checkout なら deny。
# alwaysOnServer の有無 (SG_PORT) に関係なく有効 — main checkout の working tree/HEAD
# 保護は常時稼働サーバーとは独立の理由による。
sg_check_main_git_mutate() {
  [ -n "$SG_IS_SUB" ] || return 0
  sg_dir_is_main "$1" || return 0
  sg_deny_git_mutate "$2"
}

# --- bdboard-1zrs: git 以外の書き込み系コマンド (sed -i / cp / mv / tee / リダイレクト /
# npm install) と、委譲ツール (aimix) の main checkout での起動を塞ぐ。sg_deny_sub
# (規則7用、サーバー再配備の文言) / sg_deny_git_mutate (git専用の文言) とは別に、
# コマンド非依存の汎用文言を持つ。
sg_deny_main_write() {
  sg_audit "8-write-$1"
  deny \
    "bdboard-harness: サブエージェントは main checkout ($SG_MAIN) で $2 を実行できません (working tree を直接変更するため)。" \
    'worktree で作業してください: cd <worktree> && ... のように per-ticket worktree に向けてください。' \
    "worktree が無ければ: git -C $SG_MAIN worktree add .claude/worktrees/<id> -b bd/<id> origin/main"
}

# 引数: 実効 dir, ラベル, 説明。サブエージェントかつ main checkout なら deny。
sg_check_main_write() {
  [ -n "$SG_IS_SUB" ] || return 0
  sg_dir_is_main "$1" || return 0
  sg_deny_main_write "$2" "$3"
}

# 生パストークン (相対/絶対/~、sg_expand 前) の「親ディレクトリ」を実効 dir 基準で
# 解決する。sg_resolve_dir はディレクトリ専用 (cd できる前提) なので、まだ存在しない
# ファイルを書き込み先に取るコマンド (sed -i の対象、リダイレクト先、cp/mv/tee の宛先)
# には使えない。トークンを展開してから最後の `/` で分割し、ディレクトリ側だけを既存の
# 絶対/相対解決ルールに通す (スラッシュが無ければ実効 dir そのもの)。
sg_resolve_target_dir() {
  sg_rtd_expanded="$(sg_expand "$1")"
  case "$sg_rtd_expanded" in
    */*)
      sg_rtd_dir="${sg_rtd_expanded%/*}"
      [ -n "$sg_rtd_dir" ] || sg_rtd_dir='/'
      ;;
    *) sg_rtd_dir='' ;;
  esac
  case "$sg_rtd_dir" in
    '') printf '%s' "$SG_DIR" ;;
    /*) sg_canon "$sg_rtd_dir" ;;
    *) sg_canon "$SG_DIR/$sg_rtd_dir" ;;
  esac
}

# 引数: ラベル, 説明, 以降チェック対象のパストークン列 (可変長)。サブエージェントかつ
# main checkout ならその中の最初にマッチしたトークンで deny する。
sg_check_main_write_targets() {
  [ -n "$SG_IS_SUB" ] || return 0
  sg_cmwt_label="$1"
  sg_cmwt_desc="$2"
  shift 2
  for sg_cmwt_tok in "$@"; do
    [ -n "$sg_cmwt_tok" ] || continue
    sg_cmwt_dir="$(sg_resolve_target_dir "$sg_cmwt_tok")"
    if sg_dir_is_main "$sg_cmwt_dir"; then
      sg_deny_main_write "$sg_cmwt_label" "$sg_cmwt_desc"
    fi
  done
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
      case "${1:-}" in
        pull)
          # pull は既存の 7a (SG_PORT = alwaysOnServer.port が要る) だけが対象にする。
          # 規則 8 (このブロックの他の枝) には含めない — 規則 8 の役割は「7 が元々
          # 対象にしていなかった working tree/HEAD 変更系」を追加で塞ぐことで、pull は
          # 元から 7a の対象なので二重化しない (hooks/README.md「規則 8」参照)。
          if [ -n "$SG_PORT" ]; then
            sg_check_main_action "$sg_git_dir" '7a-git-pull' 'git pull'
          fi
          ;;
        checkout | switch | commit | reset | merge | rebase | stash | restore | cherry-pick | revert | am | clean | bisect | apply | rm | mv)
          sg_check_main_git_mutate "$sg_git_dir" "$1"
          ;;
      esac
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
      for sg_sed_tok in "$@"; do
        case "$sg_sed_tok" in
          -i | -i.* | --in-place | --in-place=*) sg_sed_has_i='yes' ;;
          -*) ;;
          *) sg_sed_targets+=("$sg_sed_tok") ;;
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
      for sg_tee_tok in "$@"; do
        case "$sg_tee_tok" in
          -*) ;;
          *) sg_tee_targets+=("$sg_tee_tok") ;;
        esac
      done
      if [ ${#sg_tee_targets[@]} -gt 0 ]; then
        sg_check_main_write_targets 'tee' 'tee コマンドでの書き込み' "${sg_tee_targets[@]}"
      fi
      ;;
    aimix)
      shift
      sg_aimix_dir="$SG_DIR"
      while [ $# -gt 0 ]; do
        case "$1" in
          --cwd) sg_aimix_dir="$(sg_resolve_dir "${2:-}")"; shift; shift ;;
          --cwd=*) sg_aimix_dir="$(sg_resolve_dir "${1#--cwd=}")"; shift ;;
          *) shift ;;
        esac
      done
      sg_check_main_write "$sg_aimix_dir" 'aimix-delegate' 'aimix 経由の委譲実行 (Codex/Cursor 子プロセスが hook を経由せず書き込むため)'
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

  if [ -n "$sg_closes_subshell" ] && [ -n "$SG_SUBSHELL_DIR" ]; then
    SG_DIR="$SG_SUBSHELL_DIR"
    SG_SUBSHELL_DIR=''
  fi
done <<SG_SEGMENTS_EOF
$SG_SEGMENTS
SG_SEGMENTS_EOF
set +f

return 0
