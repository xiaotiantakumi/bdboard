#!/usr/bin/env bash
#
# bdboard-harness / Stop ゲート。
#
# 「チケットに何も残さずセッションを終える」を差し戻す (bdboard-pkr6.1)。
# in_progress のチケットに PR コメントも直近の作業記録も無いまま、未コミット差分や
# 未 push コミットを残して止まると、次に見た人 (や次のセッション) は bd からは
# 進行中に見えるのに痕跡が何も無い状態になる。
#
# 契約: stdin に Claude Code の hook 入力 JSON。差し戻しは exit 2 + stderr 3 行以内、
# 通過は exit 0 で無出力。判定できないものはすべて通過に倒す (fail-open)。
#
# 依存: bash(3.2 互換) / coreutils / git / bd と、任意で jq または python3。
set -uo pipefail

INPUT="$(cat)"

JSON_TOOL=''
if command -v jq >/dev/null 2>&1; then
  JSON_TOOL='jq'
elif command -v python3 >/dev/null 2>&1; then
  JSON_TOOL='python3'
fi

if [ -z "$JSON_TOOL" ]; then
  # 縮退モード: 状態判定 (status / コメント時刻) がすべて JSON 依存なので、この hook は
  # 丸ごと通過させる (fail-open)。stderr は警告 1 行だけ。
  printf '%s\n' 'bdboard-harness hook: jq/python3 not found; skipping all checks (fail-open)' >&2
  exit 0
fi

command -v bd >/dev/null 2>&1 || exit 0

json_field() {
  # $1: JSON テキスト / $2: ドット区切りパス
  case "$JSON_TOOL" in
    jq)
      printf '%s' "$1" | jq -r --arg p "$2" '
        (if type == "array" then (.[0] // {}) else . end)
        | reduce ($p | split("."))[] as $k (.; if type == "object" then .[$k] else null end)
        | if . == null then empty elif type == "string" then . else tojson end
      ' 2>/dev/null
      ;;
    python3)
      printf '%s' "$1" | python3 -c '
import json, sys
try:
    cur = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if isinstance(cur, list):
    cur = cur[0] if cur else {}
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
' "$2" 2>/dev/null
      ;;
  esac
}

# bd comments --json を要約して "<PR:を含む件数><TAB><最新コメントのepoch>" を返す。
comments_summary() {
  case "$JSON_TOOL" in
    jq)
      printf '%s' "$1" | jq -r '
        (if type == "array" then . else [] end) as $c
        | [
            ($c | map(select(((.text // "") | type) == "string" and ((.text // "") | contains("PR:")))) | length),
            ($c
              | map(
                  (.created_at // "")
                  | if type == "string" then (sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601? // 0) else 0 end
                )
              | max // 0)
          ]
        | @tsv
      ' 2>/dev/null
      ;;
    python3)
      printf '%s' "$1" | python3 -c '
import calendar, json, re, sys, time
try:
    comments = json.load(sys.stdin)
except Exception:
    comments = []
if not isinstance(comments, list):
    comments = []
pr_count = 0
latest = 0
for item in comments:
    if not isinstance(item, dict):
        continue
    text = item.get("text")
    if isinstance(text, str) and "PR:" in text:
        pr_count += 1
    created = item.get("created_at")
    if isinstance(created, str):
        created = re.sub(r"\.[0-9]+Z$", "Z", created)
        try:
            latest = max(latest, calendar.timegm(time.strptime(created, "%Y-%m-%dT%H:%M:%SZ")))
        except Exception:
            pass
sys.stdout.write("%d\t%d\n" % (pr_count, latest))
' 2>/dev/null
      ;;
  esac
}

# 入力 JSON から使うフィールドは 1 回の呼び出しでまとめて取り出す (フィールドごとに
# JSON ツールを起動すると python3 経路で数百 ms かかる)。区切りは US(0x1f)。
US_SEPARATOR=$'\037'

input_fields() {
  case "$JSON_TOOL" in
    jq)
      printf '%s' "$INPUT" | jq -j '
        def scalar:
          if . == null then ""
          elif type == "string" then .
          else tojson end;
        . as $d
        | [ (try ($d.cwd) catch null | scalar),
            (try ($d.stop_hook_active) catch null | scalar) ]
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
' cwd stop_hook_active 2>/dev/null
      ;;
  esac
}

INPUT_FIELDS="$(input_fields)"
HOOK_CWD="${INPUT_FIELDS%%"$US_SEPARATOR"*}"
STOP_HOOK_ACTIVE="${INPUT_FIELDS#*"$US_SEPARATOR"}"
[ -n "$HOOK_CWD" ] || HOOK_CWD="$PWD"

# 1. 無限ループ防止: この hook 起因で再開されたセッションでは何もしない。
case "$STOP_HOOK_ACTIVE" in
  true | True | TRUE) exit 0 ;;
esac

# 2. チケット ID の特定。
BRANCH="$(git -C "$HOOK_CWD" rev-parse --abbrev-ref HEAD 2>/dev/null)"
if [ -z "$BRANCH" ] || [ "$BRANCH" = 'HEAD' ]; then
  BRANCH="$(git -C "$HOOK_CWD" symbolic-ref --quiet --short HEAD 2>/dev/null)"
fi

TICKET_ID=''
case "$BRANCH" in
  bd/*) TICKET_ID="${BRANCH#bd/}" ;;
esac

if [ -z "$TICKET_ID" ]; then
  case "$HOOK_CWD" in
    *'/.claude/worktrees/'*)
      WORKTREE_NAME="${HOOK_CWD#*/.claude/worktrees/}"
      WORKTREE_NAME="${WORKTREE_NAME%%/*}"
      if [ -n "$WORKTREE_NAME" ] &&
        bd -C "$HOOK_CWD" show "$WORKTREE_NAME" --json >/dev/null 2>&1; then
        TICKET_ID="$WORKTREE_NAME"
      fi
      ;;
  esac
fi

# per-ticket worktree ではないので判定材料が無い。
[ -n "$TICKET_ID" ] || exit 0

# 3. in_progress のチケットだけが対象。bd は必ず -C で hook の cwd を渡す
#    (Stop hook のプロセス cwd は Claude Code 側の都合で決まり、対象 worktree とは
#    限らないため。渡さないと別チェックアウトの .beads/ を読みかねない)。
TICKET_JSON="$(bd -C "$HOOK_CWD" show "$TICKET_ID" --json 2>/dev/null)"
[ -n "$TICKET_JSON" ] || exit 0

TICKET_STATUS="$(json_field "$TICKET_JSON" status)"
[ "$TICKET_STATUS" = 'in_progress' ] || exit 0

# 4. 痕跡 (PR コメント / 直近 15 分のコメント) があれば通過。
COMMENTS_JSON="$(bd -C "$HOOK_CWD" comments "$TICKET_ID" --json 2>/dev/null)"
PR_COUNT=0
LATEST_EPOCH=0
if [ -n "$COMMENTS_JSON" ]; then
  SUMMARY="$(comments_summary "$COMMENTS_JSON")"
  if [ -n "$SUMMARY" ]; then
    PR_COUNT="$(printf '%s' "$SUMMARY" | cut -f1)"
    LATEST_EPOCH="$(printf '%s' "$SUMMARY" | cut -f2)"
  fi
fi
case "$PR_COUNT" in
  '' | *[!0-9]*) PR_COUNT=0 ;;
esac
case "$LATEST_EPOCH" in
  '' | *[!0-9]*) LATEST_EPOCH=0 ;;
esac

[ "$PR_COUNT" -eq 0 ] || exit 0

NOW_EPOCH="$(date +%s 2>/dev/null)"
case "$NOW_EPOCH" in
  '' | *[!0-9]*) NOW_EPOCH=0 ;;
esac
if [ "$LATEST_EPOCH" -gt 0 ] && [ "$NOW_EPOCH" -gt 0 ] &&
  [ $((NOW_EPOCH - LATEST_EPOCH)) -le 900 ]; then
  exit 0
fi

# 5. 未コミット差分 / 未 push コミットが残っていれば差し戻す。
DIRTY_COUNT="$(git -C "$HOOK_CWD" status --porcelain 2>/dev/null | wc -l | tr -d '[:space:]')"
case "$DIRTY_COUNT" in
  '' | *[!0-9]*) DIRTY_COUNT=0 ;;
esac

MAIN_BRANCH='main'
REPO_ROOT="$(git -C "$HOOK_CWD" rev-parse --show-toplevel 2>/dev/null)"
if [ -n "$REPO_ROOT" ] && [ -r "$REPO_ROOT/.claude/bdboard-harness.json" ]; then
  CONTRACT_MAIN="$(json_field "$(cat "$REPO_ROOT/.claude/bdboard-harness.json" 2>/dev/null)" mainBranch)"
  [ -z "$CONTRACT_MAIN" ] || MAIN_BRANCH="$CONTRACT_MAIN"
fi

UNPUSHED_COUNT=0
if git -C "$HOOK_CWD" rev-parse --verify --quiet "origin/$MAIN_BRANCH" >/dev/null 2>&1; then
  UNPUSHED_COUNT="$(git -C "$HOOK_CWD" rev-list --count "origin/$MAIN_BRANCH..HEAD" 2>/dev/null)"
  case "$UNPUSHED_COUNT" in
    '' | *[!0-9]*) UNPUSHED_COUNT=0 ;;
  esac
fi

if [ "$DIRTY_COUNT" -gt 0 ] || [ "$UNPUSHED_COUNT" -gt 0 ]; then
  printf '%s\n' \
    "bdboard-harness: チケット $TICKET_ID は in_progress ですが、PR も直近15分のコメントもありません。" \
    "終える前に次のどちらかを行ってください: (1) コミットして PR を開き bd comment $TICKET_ID \"PR: <url>\"、(2) 現状と残作業を bd comment $TICKET_ID \"...\" に残す。" \
    "（未コミット差分: $DIRTY_COUNT ファイル / 未 push コミット: $UNPUSHED_COUNT 件）" >&2
  exit 2
fi

exit 0
