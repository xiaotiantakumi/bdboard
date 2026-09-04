#!/usr/bin/env bash
#
# bdboard-harness / PreToolUse(Bash) ガード。
#
# failure-catalog の「D: 文章で禁止しても再発する操作ミス」を機械的に止める
# (bdboard-pkr6.1 / docs/HARNESS-EVALUATION.md §2.3・§5 P1)。deny 条件と回避手段は
# 同ディレクトリの README.md を参照。
#
# 契約: stdin に Claude Code の hook 入力 JSON。deny は exit 2 + stderr 3 行以内、
# allow は exit 0 で無出力。判定できないものはすべて allow に倒す (fail-open) —
# hook が壊れて作業が止まるより、従来どおり文章ルールへ戻る方が安全。
#
# 依存: bash(3.2 互換) / coreutils / git と、任意で jq または python3。
set -uo pipefail

INPUT="$(cat)"

JSON_TOOL=''
if command -v jq >/dev/null 2>&1; then
  JSON_TOOL='jq'
elif command -v python3 >/dev/null 2>&1; then
  JSON_TOOL='python3'
fi

if [ -z "$JSON_TOOL" ]; then
  # 縮退モード: 入力 JSON を構造として読めない。生の JSON 文字列へ正規表現を当てると
  # 「JSON のどこかに現れただけの語」で誤 deny する (例: git stash list すら止まる) ので、
  # この hook は丸ごと通過させる (fail-open)。stderr は警告 1 行だけ。
  printf '%s\n' 'bdboard-harness hook: jq/python3 not found; skipping all checks (fail-open)' >&2
  exit 0
fi

# 必要なフィールドを 1 回の呼び出しでまとめて取り出す (フィールドごとに JSON ツールを
# 起動すると python3 経路で数百 ms かかる)。区切りは US(0x1f)。TAB でも改行でもないのは、
# コマンド文字列にはどちらも普通に含まれるから — 特に改行を空白へ潰すと「複数行コマンドの
# 2 行目以降」を行として見られなくなり、規則 3・4 が素通りする。
US_SEPARATOR=$'\037'

hook_fields() {
  case "$JSON_TOOL" in
    jq)
      printf '%s' "$INPUT" | jq -j '
        def scalar:
          if . == null then ""
          elif type == "string" then .
          else tojson end;
        . as $d
        | [ (try ($d.tool_name) catch null | scalar),
            (try ($d.tool_input.command) catch null | scalar),
            (try ($d.tool_input.run_in_background) catch null | scalar),
            (try ($d.cwd) catch null | scalar) ]
        | join("\u001f")
      ' 2>/dev/null
      ;;
    python3)
      printf '%s' "$INPUT" | python3 -c '
import json, sys


def scalar(document, dotted_path):
    cur = document
    for key in dotted_path.split("."):
        if isinstance(cur, dict) and key in cur:
            cur = cur[key]
        else:
            return ""
    if cur is None:
        return ""
    if isinstance(cur, bool):
        return "true" if cur else "false"
    if isinstance(cur, str):
        return cur
    return json.dumps(cur)


try:
    doc = json.load(sys.stdin)
except Exception:
    sys.exit(0)
sys.stdout.write("\x1f".join(scalar(doc, p) for p in sys.argv[1:]))
' tool_name tool_input.command tool_input.run_in_background cwd 2>/dev/null
      ;;
  esac
}

# 値に改行が入りうるので read では切れない。US で前から順に剥がす。取り出せなかった
# (JSON が壊れている等) 場合はすべて空になり、そのまま fail-open へ落ちる。
HOOK_FIELDS="$(hook_fields)"
TOOL_NAME="${HOOK_FIELDS%%"$US_SEPARATOR"*}"
HOOK_FIELDS="${HOOK_FIELDS#*"$US_SEPARATOR"}"
COMMAND="${HOOK_FIELDS%%"$US_SEPARATOR"*}"
HOOK_FIELDS="${HOOK_FIELDS#*"$US_SEPARATOR"}"
RUN_IN_BACKGROUND="${HOOK_FIELDS%%"$US_SEPARATOR"*}"
HOOK_CWD="${HOOK_FIELDS#*"$US_SEPARATOR"}"

[ -n "$HOOK_CWD" ] || HOOK_CWD="$PWD"

case "$TOOL_NAME" in
  '' | Bash) ;;
  *) exit 0 ;;
esac

[ -n "$COMMAND" ] || exit 0

matches() {
  printf '%s\n' "$COMMAND" | grep -Eq -- "$1" 2>/dev/null
}

# コマンド列を「シェルのコマンド 1 個」単位へ割る。; & | を改行へ潰すだけの粗い分割
# だが、`A; B` の B や `A && B` の B を独立に見るにはこれで足りる。列全体を 1 つとして
# 見ると `bd dolt push --remote legacy; bd dolt push` のように「先頭だけ行儀の良い」
# 列が素通りしてしまう。
command_segments() {
  printf '%s\n' "$COMMAND" | tr ';&|' '\n\n\n'
}

deny() {
  for deny_line in "$@"; do
    printf '%s\n' "$deny_line" >&2
  done
  exit 2
}

# 1. pkill / killall: パターン一致 kill は常時稼働サーバーや他セッションを巻き込む。
if matches '(^|[^[:alnum:]_-])(pkill|killall)([^[:alnum:]_-]|$)'; then
  deny \
    'bdboard-harness: pkill/killall はパターンに一致した無関係なプロセス (常時稼働サーバー等) を巻き込むため禁止です。' \
    'まず lsof -nP -iTCP:<port> -sTCP:LISTEN や pgrep -x <name> で対象の PID を特定してください。' \
    'そのうえで kill <pid> のように PID を指定して終了させてください。'
fi

# 2. bare な bd dolt push/pull: git origin 由来の remote を採用して私的な履歴を公開先へ
#    流しうる。--remote の有無はコマンド 1 個ごとに見る。
DOLT_SEGMENTS="$(command_segments |
  grep -E '(^|[^[:alnum:]_-])bd[[:space:]]+dolt[[:space:]]+(push|pull)([[:space:]]|$)' 2>/dev/null)"
if [ -n "$DOLT_SEGMENTS" ]; then
  while IFS= read -r dolt_segment; do
    [ -n "$dolt_segment" ] || continue
    if printf '%s\n' "$dolt_segment" |
      grep -Eq -- '(^|[[:space:]])--remote([[:space:]=]|$)' 2>/dev/null; then
      continue
    fi
    deny \
      'bdboard-harness: --remote 無しの bd dolt push/pull は git origin 由来の remote を採用し、私的な issue 履歴を公開 remote へ流す恐れがあります。' \
      'remote を必ず明示してください: bd dolt push --remote <name> (bdboard では legacy)。' \
      '事前に bd dolt remote list で origin が登録されていないことも確認してください。'
  done <<DOLT_SEGMENTS_EOF
$DOLT_SEGMENTS
DOLT_SEGMENTS_EOF
fi

# 3. git stash: bare / pop / save は他セッションの退避を奪う。こちらもコマンド 1 個
#    ごとに見る (`git stash list; git stash pop` の後半を見逃さないため)。
STASH_SEGMENTS="$(command_segments |
  grep -E '(^|[^[:alnum:]_-])git[[:space:]]+stash([[:space:]]|$)' 2>/dev/null)"
if [ -n "$STASH_SEGMENTS" ]; then
  while IFS= read -r stash_segment; do
    [ -n "$stash_segment" ] || continue
    stash_rest="$(printf '%s' "$stash_segment" | sed -E 's/^.*git[[:space:]]+stash//')"
    set -f
    # shellcheck disable=SC2086
    set -- $stash_rest
    set +f
    stash_sub="${1:-}"
    stash_deny=''
    case "$stash_sub" in
      list | drop | show) ;;
      apply)
        [ -n "${2:-}" ] || stash_deny='yes'
        ;;
      push)
        # メッセージ指定 (-m / -um / -m"x" / --message / --message="x") が要る。
        printf '%s\n' "$stash_rest" |
          grep -Eq -- '(^|[[:space:]])(-[A-Za-z]*m|--message)' 2>/dev/null || stash_deny='yes'
        ;;
      *) stash_deny='yes' ;;
    esac
    if [ -n "$stash_deny" ]; then
      deny \
        'bdboard-harness: bare git stash / git stash pop / git stash save は他セッションの退避を奪うため禁止です。' \
        '退避は WIP コミット (git commit -m "wip: ...") で行ってください。' \
        'どうしても stash が要るなら git stash push -u -m "<tag>" で作り、取り出しは git stash apply <sha> を使ってください。'
    fi
  done <<STASH_SEGMENTS_EOF
$STASH_SEGMENTS
STASH_SEGMENTS_EOF
fi

# 4. run_in_background:true + 末尾 &: 二重に非同期化され完了通知が届かない。
case "$RUN_IN_BACKGROUND" in
  true | True | TRUE)
    if matches '[^&>][[:space:]]*&[[:space:]]*(;|$)'; then
      deny \
        'bdboard-harness: run_in_background:true のコマンド末尾に & を付けると二重に非同期化され、完了通知が届きません。' \
        '末尾の & を外し、run_in_background:true だけでバックグラウンド実行してください。' \
        'ログを残すなら cmd > /tmp/x.log 2>&1; echo EXIT=$? >> /tmp/x.log の形にしてください。'
    fi
    ;;
esac

# 5. プロジェクト固有パターン: 注入先の検証コントラクト (.claude/bdboard-harness.json)。
REPO_ROOT="$(git -C "$HOOK_CWD" rev-parse --show-toplevel 2>/dev/null)"
[ -n "$REPO_ROOT" ] || exit 0

CONTRACT_FILE="$REPO_ROOT/.claude/bdboard-harness.json"
[ -r "$CONTRACT_FILE" ] || exit 0

CONTRACT="$(cat "$CONTRACT_FILE" 2>/dev/null)"
[ -n "$CONTRACT" ] || exit 0

contract_patterns() {
  case "$JSON_TOOL" in
    jq)
      printf '%s' "$CONTRACT" | jq -r '
        try (.hooks.denyBashPatterns) catch []
        | if type == "array" then .[] else empty end
        | if type == "string" then . else "" end
      ' 2>/dev/null
      ;;
    python3)
      printf '%s' "$CONTRACT" | python3 -c '
import json, sys
try:
    doc = json.load(sys.stdin)
except Exception:
    sys.exit(0)
hooks = doc.get("hooks") if isinstance(doc, dict) else None
items = hooks.get("denyBashPatterns") if isinstance(hooks, dict) else None
if isinstance(items, list):
    for item in items:
        sys.stdout.write((item if isinstance(item, str) else "") + "\n")
' 2>/dev/null
      ;;
  esac
}

contract_message() {
  case "$JSON_TOOL" in
    jq)
      printf '%s' "$CONTRACT" | jq -r --argjson i "$1" '
        try (.hooks.denyBashMessages[$i]) catch ""
        | if type == "string" then . else "" end
      ' 2>/dev/null
      ;;
    python3)
      printf '%s' "$CONTRACT" | python3 -c '
import json, sys
try:
    doc = json.load(sys.stdin)
except Exception:
    sys.exit(0)
hooks = doc.get("hooks") if isinstance(doc, dict) else None
items = hooks.get("denyBashMessages") if isinstance(hooks, dict) else None
index = int(sys.argv[1])
if isinstance(items, list) and 0 <= index < len(items) and isinstance(items[index], str):
    sys.stdout.write(items[index])
' "$1" 2>/dev/null
      ;;
  esac
}

CONTRACT_PATTERN_LIST="$(contract_patterns)"
[ -n "$CONTRACT_PATTERN_LIST" ] || exit 0

PATTERN_INDEX=0
while IFS= read -r contract_pattern; do
  if [ -n "$contract_pattern" ] && matches "$contract_pattern"; then
    CONTRACT_MESSAGE="$(contract_message "$PATTERN_INDEX")"
    [ -n "$CONTRACT_MESSAGE" ] ||
      CONTRACT_MESSAGE="このコマンドはプロジェクトの検証コントラクトで禁止されています: $contract_pattern"
    # 文言は注入先プロジェクトが書いたテキスト。改行が入ると「stderr は 3 行以内」の
    # 不変条件が壊れ、そのまま出せばプロンプト注入の足場にもなる。改行/CR/TAB を空白へ
    # 潰し、長さを切り、出所が分かる前置きを付けて必ず 1 行で出す。
    CONTRACT_MESSAGE="$(printf '%s' "$CONTRACT_MESSAGE" | tr '\n\r\t' '   ')"
    deny "bdboard-harness: (project contract) ${CONTRACT_MESSAGE:0:200}"
  fi
  PATTERN_INDEX=$((PATTERN_INDEX + 1))
done <<CONTRACT_PATTERNS
$CONTRACT_PATTERN_LIST
CONTRACT_PATTERNS

exit 0
