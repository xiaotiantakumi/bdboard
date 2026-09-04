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

# stdin JSON からドット区切りパスのスカラーを取り出す。取れなければ空文字。
hook_field() {
  case "$JSON_TOOL" in
    jq)
      printf '%s' "$INPUT" | jq -r --arg p "$1" '
        reduce ($p | split("."))[] as $k (.; if type == "object" then .[$k] else null end)
        | if . == null then empty elif type == "string" then . else tojson end
      ' 2>/dev/null
      ;;
    python3)
      printf '%s' "$INPUT" | python3 -c '
import json, sys
try:
    cur = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for key in sys.argv[1].split("."):
    if isinstance(cur, dict) and key in cur:
        cur = cur[key]
    else:
        sys.exit(0)
if cur is None:
    sys.exit(0)
if isinstance(cur, bool):
    sys.stdout.write("true" if cur else "false")
elif isinstance(cur, str):
    sys.stdout.write(cur)
else:
    sys.stdout.write(json.dumps(cur))
' "$1" 2>/dev/null
      ;;
    *)
      return 0
      ;;
  esac
}

if [ -n "$JSON_TOOL" ]; then
  TOOL_NAME="$(hook_field tool_name)"
  COMMAND="$(hook_field tool_input.command)"
  RUN_IN_BACKGROUND="$(hook_field tool_input.run_in_background)"
  HOOK_CWD="$(hook_field cwd)"
else
  # JSON を読めないので、生の stdin に対する正規表現だけで判定できる規則に限定する。
  printf '%s\n' 'bdboard-harness hook: jq/python3 not found; contract patterns skipped' >&2
  TOOL_NAME=''
  COMMAND="$INPUT"
  RUN_IN_BACKGROUND=''
  HOOK_CWD=''
fi

[ -n "$HOOK_CWD" ] || HOOK_CWD="$PWD"

case "$TOOL_NAME" in
  '' | Bash) ;;
  *) exit 0 ;;
esac

[ -n "$COMMAND" ] || exit 0

matches() {
  printf '%s\n' "$COMMAND" | grep -Eq -- "$1" 2>/dev/null
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

# 2. bare な bd dolt push/pull: git origin 由来の remote を採用して私的な履歴を公開先へ流しうる。
if matches '(^|[^[:alnum:]_-])bd[[:space:]]+dolt[[:space:]]+(push|pull)([[:space:]]|$)' &&
  ! matches '(^|[[:space:]])--remote([[:space:]=]|$)'; then
  deny \
    'bdboard-harness: --remote 無しの bd dolt push/pull は git origin 由来の remote を採用し、私的な issue 履歴を公開 remote へ流す恐れがあります。' \
    'remote を必ず明示してください: bd dolt push --remote <name> (bdboard では legacy)。' \
    '事前に bd dolt remote list で origin が登録されていないことも確認してください。'
fi

# 3. git stash: bare / pop / save は他セッションの退避を奪う。
if matches '(^|[^[:alnum:]_-])git[[:space:]]+stash'; then
  STASH_REST="$(printf '%s\n' "$COMMAND" |
    grep -Eo 'git[[:space:]]+stash[^;&|]*' |
    head -1 |
    sed -E 's/^git[[:space:]]+stash//')"
  set -f
  # shellcheck disable=SC2086
  set -- $STASH_REST
  set +f
  STASH_SUB="${1:-}"
  STASH_DENY=''
  case "$STASH_SUB" in
    list | drop | show) ;;
    apply)
      [ -n "${2:-}" ] || STASH_DENY='yes'
      ;;
    push)
      case " $STASH_REST " in
        *' -m '* | *' --message '*) ;;
        *) STASH_DENY='yes' ;;
      esac
      ;;
    *) STASH_DENY='yes' ;;
  esac
  if [ -n "$STASH_DENY" ]; then
    deny \
      'bdboard-harness: bare git stash / git stash pop / git stash save は他セッションの退避を奪うため禁止です。' \
      '退避は WIP コミット (git commit -m "wip: ...") で行ってください。' \
      'どうしても stash が要るなら git stash push -u -m "<tag>" で作り、取り出しは git stash apply <sha> を使ってください。'
  fi
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
[ -n "$JSON_TOOL" ] || exit 0

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
      CONTRACT_MESSAGE="プロジェクトの検証コントラクトで禁止されています: $contract_pattern"
    deny "bdboard-harness: $CONTRACT_MESSAGE"
  fi
  PATTERN_INDEX=$((PATTERN_INDEX + 1))
done <<CONTRACT_PATTERNS
$CONTRACT_PATTERN_LIST
CONTRACT_PATTERNS

exit 0
