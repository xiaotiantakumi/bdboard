#!/usr/bin/env bash
#
# bdboard-harness / 作業フォルダの鮮度警告 (bdboard-flpp)。
#
# hook の登録 (.claude/settings.json) も本体 (.claude/skills/<pack>/hooks/ など) も、セッションを
# 起動した checkout (= $CLAUDE_PROJECT_DIR) から読まれる。Agent ツールで起動したサブエージェントの
# hook も親と同じ $CLAUDE_PROJECT_DIR から読まれる。何日も動く議長セッションの checkout は誰も
# 更新しないので、main に入った hook の追加・修正が議長にも、議長が起動した全サブエージェントにも
# 届かなくなる (2026-09 に規則 7 が 1 か月効いていなかった)。この hook はそれをセッション自身に
# 知らせる。**自動で checkout / merge はしない** — 作業中の変更を壊しうるため。安全に追従できる
# ときだけ、そのためのコマンドを案内する。詳細は同ディレクトリの README.md。
#
# 契約: stdin に Claude Code の hook 入力 JSON (SessionStart / UserPromptSubmit / PostToolUse)。
# 常に exit 0。警告があるときだけ stdout に JSON (systemMessage + hookSpecificOutput.additionalContext)。
# 判定できないものはすべて無出力 (fail-open)。
#
# 依存: bash(3.2 互換) / coreutils / git と、jq または python3。
set -uo pipefail

INPUT="$(cat)"

# 閾値。hook そのもの (settings.json・hooks/・契約) は 1 コミットの差でも挙動が変わる
# (規則 7 は 1 コミットで入った) ので 1。規律文書を含むハーネス全体はボードの Hygiene
# (STALE_HARNESS_WORKTREE_MIN_COMMITS_BEHIND) と揃えて 3。
HOOK_PATHS_MIN_BEHIND=1
HARNESS_PATHS_MIN_BEHIND=3
# UserPromptSubmit / PostToolUse で同じ状態を繰り返し言わない間隔 (分)。SessionStart は毎回言う。
REMIND_MINUTES=60

JSON_TOOL=''
if command -v jq >/dev/null 2>&1; then
  JSON_TOOL='jq'
elif command -v python3 >/dev/null 2>&1; then
  JSON_TOOL='python3'
fi

if [ -z "$JSON_TOOL" ]; then
  printf '%s\n' 'bdboard-harness hook: jq/python3 not found; skipping all checks (fail-open)' >&2
  exit 0
fi

US_SEPARATOR=$'\037'

# $1: JSON テキスト。$2..: ドット区切りパス。値を US 区切りで返す (無い値は空)。
json_fields() {
  local document="$1"
  shift
  case "$JSON_TOOL" in
    jq)
      printf '%s' "$document" | jq -j '
        . as $d
        | [ $ARGS.positional[]
            | . as $p
            | ($d | try (reduce ($p | split("."))[] as $k (.; if type == "object" then .[$k] else null end)) catch null)
            | if . == null then "" elif type == "string" then . else tojson end ]
        | join("\u001f")
      ' --args "$@" 2>/dev/null
      ;;
    python3)
      printf '%s' "$document" | python3 -c '
import json, sys
try:
    doc = json.load(sys.stdin)
except Exception:
    sys.exit(0)
out = []
for path in sys.argv[1:]:
    cur = doc
    for key in path.split("."):
        cur = cur.get(key) if isinstance(cur, dict) else None
    if cur is None:
        out.append("")
    elif isinstance(cur, str):
        out.append(cur)
    else:
        out.append(json.dumps(cur))
sys.stdout.write("\x1f".join(out))
' "$@" 2>/dev/null
      ;;
  esac
}

# settings ファイル中の全 hook コマンド文字列を改行区切りで出す。
settings_commands() {
  case "$JSON_TOOL" in
    jq) jq -r '[.. | objects | .command? | strings] | .[]' "$1" 2>/dev/null ;;
    python3)
      python3 -c '
import json, sys
try:
    with open(sys.argv[1]) as handle:
        doc = json.load(handle)
except Exception:
    sys.exit(0)
def walk(node):
    if isinstance(node, dict):
        if isinstance(node.get("command"), str):
            print(node["command"])
        for value in node.values():
            walk(value)
    elif isinstance(node, list):
        for value in node:
            walk(value)
walk(doc)
' "$1" 2>/dev/null
      ;;
  esac
}

# $1: systemMessage / $2: hookEventName (空なら hookSpecificOutput を付けない) / $3: additionalContext
emit_json() {
  case "$JSON_TOOL" in
    jq)
      jq -cn --arg s "$1" --arg e "$2" --arg c "$3" \
        '{systemMessage: $s} + (if $e == "" then {} else {hookSpecificOutput: {hookEventName: $e, additionalContext: $c}} end)'
      ;;
    python3)
      python3 -c '
import json, sys
out = {"systemMessage": sys.argv[1]}
if sys.argv[2]:
    out["hookSpecificOutput"] = {"hookEventName": sys.argv[2], "additionalContext": sys.argv[3]}
print(json.dumps(out, ensure_ascii=False))
' "$1" "$2" "$3"
      ;;
  esac
}

FIELDS="$(json_fields "$INPUT" hook_event_name agent_id session_id cwd)"
[ -n "$FIELDS" ] || exit 0
EVENT="${FIELDS%%"$US_SEPARATOR"*}"
FIELDS="${FIELDS#*"$US_SEPARATOR"}"
AGENT_ID="${FIELDS%%"$US_SEPARATOR"*}"
FIELDS="${FIELDS#*"$US_SEPARATOR"}"
SESSION_ID="${FIELDS%%"$US_SEPARATOR"*}"
HOOK_CWD="${FIELDS#*"$US_SEPARATOR"}"

# サブエージェント内では言わない。直せるのは議長だけで、サブエージェントに議長の checkout を
# 触らせない (委譲ブリーフの規律) ため。
[ -z "$AGENT_ID" ] || exit 0

# 見るのは hook の読み込み元。cwd ではない (議長が別 worktree へ cd していても hook は
# $CLAUDE_PROJECT_DIR から読まれ続ける)。
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-}"
[ -n "$PROJECT_DIR" ] || PROJECT_DIR="${HOOK_CWD:-$PWD}"
TOP="$(git -C "$PROJECT_DIR" rev-parse --show-toplevel 2>/dev/null)" || exit 0
[ -n "$TOP" ] || exit 0

CONTRACT_JSON='{}'
if [ -r "$TOP/.claude/bdboard-harness.json" ]; then
  CONTRACT_JSON="$(cat "$TOP/.claude/bdboard-harness.json" 2>/dev/null)"
fi
CONTRACT="$(json_fields "$CONTRACT_JSON" mainBranch alwaysOnServer.restartScript)"
MAIN_BRANCH="${CONTRACT%%"$US_SEPARATOR"*}"
RESTART_SCRIPT=''
case "$CONTRACT" in *"$US_SEPARATOR"*) RESTART_SCRIPT="${CONTRACT#*"$US_SEPARATOR"}" ;; esac
[ -n "$MAIN_BRANCH" ] || MAIN_BRANCH='main'
git check-ref-format --branch "$MAIN_BRANCH" >/dev/null 2>&1 || exit 0
BASE="origin/$MAIN_BRANCH"

git_top() { git -C "$TOP" "$@" 2>/dev/null; }

HEAD_SHA="$(git_top rev-parse --verify --quiet HEAD)" || exit 0
BASE_SHA="$(git_top rev-parse --verify --quiet "$BASE^{commit}")" || exit 0
[ -n "$HEAD_SHA" ] && [ -n "$BASE_SHA" ] || exit 0

# 同じ状態 (HEAD / 既定ブランチの先端) は REMIND_MINUTES に 1 回だけ言う。UserPromptSubmit と
# PostToolUse は毎回走るので、以降の git を起こす前にここで打ち切る。状態ファイルは checkout の
# 外に置く (中に置くと git status を汚し、Stop ゲートの dirty 判定に響く)。
STATE_DIR="${TMPDIR:-/tmp}"
STATE_DIR="${STATE_DIR%/}/bdboard-harness-freshness"
TOP_HASH="$(printf '%s' "$TOP" | cksum | cut -d' ' -f1)"
SESSION_TAG="$(printf '%s' "${SESSION_ID:-nosession}" | tr -c 'A-Za-z0-9-' '_' | cut -c1-64)"
STATE_FILE="$STATE_DIR/$TOP_HASH-$SESSION_TAG"
STATE_KEY="$HEAD_SHA $BASE_SHA"
if [ "$EVENT" != 'SessionStart' ] && [ -f "$STATE_FILE" ] \
  && [ "$(cat "$STATE_FILE" 2>/dev/null)" = "$STATE_KEY" ] \
  && [ -n "$(find "$STATE_FILE" -mmin "-$REMIND_MINUTES" 2>/dev/null)" ]; then
  exit 0
fi

count_behind() {
  local counted
  counted="$(git_top rev-list --count "HEAD..$BASE" -- "$@")"
  case "$counted" in
    '' | *[!0-9]*) printf '0' ;;
    *) printf '%s' "$counted" ;;
  esac
}

# 登録済み hook 本体 ($CLAUDE_PROJECT_DIR/<path> の形で参照されているもの) を列挙する。
# 本体が無いと登録コマンドの `[ -f "$0" ] || exit 0` で無言のまま何もしない。
REGISTERED_PATHS=''
for settings in "$TOP/.claude/settings.json" "$TOP/.claude/settings.local.json"; do
  [ -r "$settings" ] || continue
  REGISTERED_PATHS="$REGISTERED_PATHS$(settings_commands "$settings" \
    | grep -oE '\$\{?CLAUDE_PROJECT_DIR(:-[^}]*)?\}?/[A-Za-z0-9._/@+-]+' \
    | sed -E 's#^\$\{?CLAUDE_PROJECT_DIR(:-[^}]*)?\}?/##')
"
done
REGISTERED_PATHS="$(printf '%s' "$REGISTERED_PATHS" | grep -v '^$' | sort -u)"

MISSING=''
MISSING_COUNT=0
HOOK_PATHSPEC=()
while IFS= read -r rel; do
  [ -n "$rel" ] || continue
  case "$rel" in /* | *..*) continue ;; esac
  HOOK_PATHSPEC+=("$rel")
  if [ ! -e "$TOP/$rel" ]; then
    MISSING_COUNT=$((MISSING_COUNT + 1))
    [ "$MISSING_COUNT" -gt 5 ] || MISSING="$MISSING $rel"
  fi
done <<EOF
$REGISTERED_PATHS
EOF

# 共通の祖先が無い = 履歴の作り直しより前の checkout。shallow clone では merge-base が
# 見えないだけのことがあるので、その場合は判定しない。
# exit 1 だけが「祖先なし」。それ以外の失敗 (オブジェクト破損など) は判定しない。
NO_BASE=0
MERGE_BASE="$(git_top merge-base HEAD "$BASE")"
MERGE_BASE_STATUS=$?
if [ "$MERGE_BASE_STATUS" -eq 1 ] && [ "$(git_top rev-parse --is-shallow-repository)" != 'true' ]; then
  NO_BASE=1
fi

# 数えるのは HEAD..BASE (= 既定ブランチ側にだけあるコミット)。自分のブランチで hook を
# 直している PR worktree は、自分のコミットでは警告されない。
HOOK_BEHIND=0
HARNESS_BEHIND=0
SETTINGS_BEHIND=0
TOTAL_BEHIND=0
LOCK_BEHIND=0
# 既定ブランチの先端が HEAD の祖先なら遅れは 0 (最新の checkout・PR worktree の大半)。
if [ -n "$MERGE_BASE" ] && [ "$MERGE_BASE" != "$BASE_SHA" ]; then
  HOOK_BEHIND="$(count_behind .claude/settings.json .claude/bdboard-harness.json \
    ':(glob).claude/skills/*/hooks/**' ':(glob).claude/skills/*/scripts/**' \
    ${HOOK_PATHSPEC[@]+"${HOOK_PATHSPEC[@]}"})"
  HARNESS_BEHIND="$(count_behind .claude harness)"
  SETTINGS_BEHIND="$(count_behind .claude/settings.json)"
  TOTAL_BEHIND="$(count_behind .)"
  LOCK_BEHIND="$(count_behind ':(glob)**/package-lock.json')"
fi

LEVEL=''
if [ "$NO_BASE" -eq 1 ]; then
  LEVEL='no-base'
elif [ "$HOOK_BEHIND" -ge "$HOOK_PATHS_MIN_BEHIND" ] \
  || [ "$HARNESS_BEHIND" -ge "$HARNESS_PATHS_MIN_BEHIND" ]; then
  LEVEL='behind'
fi
[ -n "$LEVEL" ] || [ "$MISSING_COUNT" -gt 0 ] || exit 0

mkdir -p "$STATE_DIR" 2>/dev/null && printf '%s' "$STATE_KEY" >"$STATE_FILE" 2>/dev/null

# --- 案内文 ---
BRANCH="$(git_top symbolic-ref -q --short HEAD)"
GIT_DIR="$(git_top rev-parse --absolute-git-dir)"
COMMON_DIR="$(cd "$TOP" 2>/dev/null && cd "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null && pwd -P)"
TOP_REAL="$(cd "$TOP" 2>/dev/null && pwd -P)"
IS_MAIN_CHECKOUT=0
[ -n "$COMMON_DIR" ] && [ "$COMMON_DIR" = "$TOP_REAL/.git" ] && IS_MAIN_CHECKOUT=1
BASE_AGE="$(git_top log -1 --format=%cr "$BASE")"

IN_PROGRESS=0
for marker in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD BISECT_LOG rebase-merge rebase-apply; do
  if [ -n "$GIT_DIR" ] && [ -e "$GIT_DIR/$marker" ]; then IN_PROGRESS=1; fi
done
DIRTY_COUNT="$(git_top status --porcelain --untracked-files=no | wc -l | tr -d '[:space:]')"
case "$DIRTY_COUNT" in '' | *[!0-9]*) DIRTY_COUNT=0 ;; esac

WHERE="この checkout ($TOP, ブランチ ${BRANCH:-detached HEAD})"
SHORT=''
BODY=''
if [ "$LEVEL" = 'no-base' ]; then
  SHORT="bdboard-harness: $WHERE は $BASE と共通の祖先がありません。hook と規律が古いまま動いています。"
  BODY="履歴の作り直しより前に作られた checkout なので、merge / rebase では追いつけません。作業を退避 (ブランチの push やパッチ) してから $BASE から新しい worktree を作り、セッションをそこで起動し直してください。"
elif [ "$LEVEL" = 'behind' ]; then
  SHORT="bdboard-harness: $WHERE の hook/ハーネスは $BASE より古いままです (hook 関連 ${HOOK_BEHIND} / ハーネス ${HARNESS_BEHIND} / 全体 ${TOTAL_BEHIND} コミット遅れ)。"
  if [ "$IS_MAIN_CHECKOUT" -eq 1 ] && [ -n "$RESTART_SCRIPT" ]; then
    BODY="これは main checkout です。手で pull せず、議長が $RESTART_SCRIPT で更新してください (build と常時稼働サーバーの再起動を伴うため)。"
  elif [ -z "$BRANCH" ] || [ "$IN_PROGRESS" -eq 1 ]; then
    BODY="HEAD が detached か merge/rebase などの途中なので、追従コマンドは案内しません。その操作を終えてから追従してください。"
  elif [ "$DIRTY_COUNT" -gt 0 ]; then
    BODY="未コミットの変更が ${DIRTY_COUNT} ファイルあります。ユーザーに確認のうえ、コミットしてから git -C '${TOP}' merge ${BASE} で追従してください。"
  elif [ "$MERGE_BASE" = "$HEAD_SHA" ]; then
    BODY="独自のコミットが無く作業ツリーも clean なので、git -C '${TOP}' merge --ff-only ${BASE} で早送りできます。"
  else
    BODY="独自のコミットがあるので、ユーザーに確認のうえ git -C '${TOP}' merge ${BASE} で取り込んでください (rebase ではなく merge)。"
  fi
  if [ "$LOCK_BEHIND" -gt 0 ]; then
    BODY="$BODY 依存 (package-lock.json) も変わっているので、追従後に npm install を実行してください。"
  fi
  if [ "$SETTINGS_BEHIND" -gt 0 ]; then
    BODY="$BODY hook の登録 (.claude/settings.json) も変わっています。追従後に /hooks で新しい hook が載っているか確認し、載っていなければセッションを起動し直してください。"
  fi
fi
if [ "$MISSING_COUNT" -gt 0 ]; then
  [ -n "$SHORT" ] || SHORT="bdboard-harness: $WHERE で、登録済みの hook 本体が ${MISSING_COUNT} 件見つかりません。"
  MORE=''
  [ "$MISSING_COUNT" -le 5 ] || MORE=' ほか'
  BODY="${BODY:+$BODY }登録されているのに本体が無い hook (無言で何もしません):${MISSING}${MORE}。追従するか、パックを再注入してください。"
fi

CONTEXT="$SHORT $BODY このセッションと、ここから起動したサブエージェントの hook は、すべてこの checkout から読まれます。この hook は自動では checkout / merge しません。($BASE の先端のコミット日時: ${BASE_AGE:-不明}。fetch はしていません)"

case "$EVENT" in
  SessionStart | UserPromptSubmit | PostToolUse) ;;
  *) EVENT='' ;;
esac
emit_json "$SHORT" "$EVENT" "$CONTEXT"
exit 0
