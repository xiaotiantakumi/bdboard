#!/usr/bin/env bash
#
# bdboard-harness / 期日到来の deferred を SessionStart で知らせる (bdboard-aqyg)。
#
# bd defer --until <date> のスヌーズは、期日後に bd ready を読んだ瞬間に open へ戻り、defer_until の
# 痕跡が消える。セッション開始時に「期日が来た」と機械的に知らせないと、他の open に紛れて忘れられる。
# この hook は到来済みの deferred (bd list --deferred --defer-before=now) と、印として付けた label
# `due` の open / in_progress を、additionalContext に ⏰ 行で並べる。
#
# 印 (冪等): label `due` が無い到来済みの票に、bd label add <id> due と bd comment を 1 回だけ打つ。
# 台帳へ書くのはこの 2 つだけ (status / assignee には触らない)。label があれば何も書かない。
# 閉じるか bd label remove <id> due するまで、以後のセッションでも毎回出る。
#
# 契約: stdin は読み捨てる。常に exit 0。出すものがなければ stdout 空。bd 不在 / 失敗は黙る (fail-open)。
# 依存: bash(3.2 互換) / bd と、jq または python3 (bd の --json を読むため)。
set -uo pipefail

cat >/dev/null 2>&1 || true

command -v bd >/dev/null 2>&1 || exit 0

JSON_TOOL=''
if command -v jq >/dev/null 2>&1; then
  JSON_TOOL='jq'
elif command -v python3 >/dev/null 2>&1; then
  JSON_TOOL='python3'
else
  exit 0
fi

# stdin の bd list --json を「id US title US 期日(YYYY-MM-DD) US due ラベルの有無(true/false)」の行にする。
rows() {
  case "$JSON_TOOL" in
    jq)
      jq -r '
        if type == "array" then .[] else empty end
        | [ .id, ((.title // "") | gsub("[\t\r\n]"; " ")),
            ((.defer_until // "") | if . == "" then "" else
              (try (sub("\\.[0-9]+"; "") | fromdateiso8601 | strflocaltime("%Y-%m-%d")) catch .[0:10]) end),
            (((.labels // []) | index("due")) != null | tostring) ]
        | join("\u001f")' 2>/dev/null
      ;;
    python3)
      python3 -c '
import json, sys
from datetime import datetime
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
def local_day(s):
    # bd の defer_until は UTC (Z) なので、このマシンのローカル日付に直す (bdboard-mlc9)
    if not s:
        return ""
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone().strftime("%Y-%m-%d")
    except Exception:
        return s[:10]
for i in data if isinstance(data, list) else []:
    title = " ".join(str(i.get("title") or "").split())
    print("\x1f".join([str(i.get("id", "")), title, local_day(str(i.get("defer_until") or "")),
                       "true" if "due" in (i.get("labels") or []) else "false"]))
' 2>/dev/null
      ;;
  esac
}

DEFERRED_JSON="$(bd list --deferred --defer-before=now --limit 0 --json 2>/dev/null)" || DEFERRED_JSON=''
DUE_JSON="$(bd list --label due --status open,in_progress --limit 0 --json 2>/dev/null)" || DUE_JSON=''

US=$'\037'
LINES_OUT=''
SEEN=' '

add_line() { # $1 id / $2 title / $3 date
  local when='期日 到来済み'
  [ -n "$3" ] && when="期日 $3"
  LINES_OUT="${LINES_OUT}⏰ 期日到来: $1 $2 ($when)"$'\n'
  SEEN="${SEEN}$1 "
}

if [ -n "$DEFERRED_JSON" ]; then
  while IFS="$US" read -r id title date has_label; do
    [ -n "$id" ] || continue
    case "$SEEN" in *" $id "*) continue ;; esac
    add_line "$id" "$title" "$date"
    if [ "$has_label" != 'true' ]; then
      if bd label add "$id" due >/dev/null 2>&1; then
        bd comment "$id" "期日到来 (deferred until ${date:-不明})" >/dev/null 2>&1 || true
      fi
    fi
  done < <(printf '%s' "$DEFERRED_JSON" | rows)
fi

if [ -n "$DUE_JSON" ]; then
  while IFS="$US" read -r id title date has_label; do
    [ -n "$id" ] || continue
    case "$SEEN" in *" $id "*) continue ;; esac
    add_line "$id" "$title" "$date"
  done < <(printf '%s' "$DUE_JSON" | rows)
fi

[ -n "$LINES_OUT" ] || exit 0

CONTEXT="${LINES_OUT}期日が来た票です。着手するか、bd label remove <id> due で印を外してください。"

case "$JSON_TOOL" in
  jq)
    jq -cn --arg c "$CONTEXT" '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $c}}'
    ;;
  python3)
    python3 -c '
import json, sys
print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": sys.argv[1]}}, ensure_ascii=False))
' "$CONTEXT"
    ;;
esac
exit 0
