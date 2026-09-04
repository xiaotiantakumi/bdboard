#!/usr/bin/env bash
#
# bdboard-harness / PreToolUse(Edit|Write|MultiEdit|NotebookEdit) ガード。
#
# 「注入コピーを直接編集して原本と乖離させる」「PR ブランチで .beads/ を触って CI
# ガードに落ちる」の 2 つを機械的に止める (bdboard-pkr6.1)。deny 条件と回避手段は
# 同ディレクトリの README.md を参照。
#
# 契約: stdin に Claude Code の hook 入力 JSON。deny は exit 2 + stderr 3 行以内、
# allow は exit 0 で無出力。判定できないものはすべて allow に倒す (fail-open)。
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

deny() {
  for deny_line in "$@"; do
    printf '%s\n' "$deny_line" >&2
  done
  exit 2
}

if [ -n "$JSON_TOOL" ]; then
  HOOK_CWD="$(hook_field cwd)"
  TARGET_PATH="$(hook_field tool_input.file_path)"
  [ -n "$TARGET_PATH" ] || TARGET_PATH="$(hook_field tool_input.notebook_path)"
else
  # JSON を読めないので、生の stdin に対する部分一致だけで判定する。
  printf '%s\n' 'bdboard-harness hook: jq/python3 not found; contract patterns skipped' >&2
  HOOK_CWD=''
  TARGET_PATH=''
  case "$INPUT" in
    *'/.claude/skills/bdboard-harness/'*)
      deny \
        'bdboard-harness: .claude/skills/bdboard-harness/ は注入コピーなので直接編集できません (layering.md)。' \
        '原本 harness/packs/bdboard-harness/ を直して再注入してください。' \
        '注入先固有の内容なら .claude/skills/project-harness/ に置いてください。'
      ;;
  esac
  exit 0
fi

[ -n "$TARGET_PATH" ] || exit 0
[ -n "$HOOK_CWD" ] || HOOK_CWD="$PWD"

# 相対パスを絶対パスにし、. と .. を字句的に畳む (symlink は解決しない —
# 解決すると照合したいパス片 .claude/skills/... が消えることがあるため)。
normalize_path() {
  normalize_input="$1"
  case "$normalize_input" in
    /*) ;;
    *) normalize_input="${HOOK_CWD%/}/$normalize_input" ;;
  esac

  normalize_result=''
  normalize_old_ifs="$IFS"
  IFS='/'
  set -f
  # shellcheck disable=SC2086
  set -- $normalize_input
  set +f
  IFS="$normalize_old_ifs"

  for normalize_segment in "$@"; do
    case "$normalize_segment" in
      '' | '.') ;;
      '..') normalize_result="${normalize_result%/*}" ;;
      *) normalize_result="$normalize_result/$normalize_segment" ;;
    esac
  done

  [ -n "$normalize_result" ] || normalize_result='/'
  printf '%s' "$normalize_result"
}

ABSOLUTE_PATH="$(normalize_path "$TARGET_PATH")"

# 1. 注入コピーの直接編集 (bdboard リポジトリ自身でも禁止 — 原本は harness/packs/)。
case "$ABSOLUTE_PATH" in
  *'/.claude/skills/bdboard-harness/'*)
    deny \
      'bdboard-harness: .claude/skills/bdboard-harness/ は注入コピーなので直接編集できません (layering.md)。' \
      '原本 harness/packs/bdboard-harness/ を直して再注入してください。' \
      '注入先固有の内容なら .claude/skills/project-harness/ に置いてください。'
    ;;
esac

# 2. PR ブランチ (bd/*) で .beads/ を触ると CI のガードに落ちる。
case "$ABSOLUTE_PATH" in
  *'/.beads/'*) ;;
  *) exit 0 ;;
esac

# git に渡せる「実在する最も近い祖先ディレクトリ」を求める。
GIT_DIR_CANDIDATE="${ABSOLUTE_PATH%/*}"
[ -n "$GIT_DIR_CANDIDATE" ] || GIT_DIR_CANDIDATE='/'
while [ ! -d "$GIT_DIR_CANDIDATE" ] && [ "$GIT_DIR_CANDIDATE" != '/' ]; do
  GIT_DIR_CANDIDATE="${GIT_DIR_CANDIDATE%/*}"
  [ -n "$GIT_DIR_CANDIDATE" ] || GIT_DIR_CANDIDATE='/'
done
[ -d "$GIT_DIR_CANDIDATE" ] || GIT_DIR_CANDIDATE="$HOOK_CWD"

BRANCH="$(git -C "$GIT_DIR_CANDIDATE" rev-parse --abbrev-ref HEAD 2>/dev/null)"
if [ -z "$BRANCH" ] || [ "$BRANCH" = 'HEAD' ]; then
  BRANCH="$(git -C "$GIT_DIR_CANDIDATE" symbolic-ref --quiet --short HEAD 2>/dev/null)"
fi
[ -n "$BRANCH" ] || exit 0

case "$BRANCH" in
  bd/*)
    deny \
      "bdboard-harness: PR ブランチ ($BRANCH) では .beads/ を変更できません — CI のガードステップが落ちます。" \
      '.beads/ の変更は main への chore(beads) 直コミット例外だけで扱ってください。' \
      'チケット操作は bd コマンド経由で行い、このブランチではファイルを直接編集しないでください。'
    ;;
esac

exit 0
