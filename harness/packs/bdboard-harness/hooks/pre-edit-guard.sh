#!/usr/bin/env bash
#
# bdboard-harness / PreToolUse(Edit|Write|MultiEdit|NotebookEdit) ガード。
#
# 「注入コピーを直接編集して原本と乖離させる」「PR ブランチで .beads/ を触って CI
# ガードに落ちる」「サブエージェントが main checkout を直接編集する」の 3 つを機械的に
# 止める (bdboard-pkr6.1, bdboard-kxqb)。deny 条件と回避手段は同ディレクトリの
# README.md を参照。
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

if [ -z "$JSON_TOOL" ]; then
  # 縮退モード: 入力 JSON を構造として読めない。生の JSON 文字列への部分一致で判定すると
  # 編集対象ではない箇所に現れた文字列で誤 deny するので、この hook は丸ごと通過させる
  # (fail-open)。stderr は警告 1 行だけ (deny 時の 3 行制約と同じ理由で短く保つ)。
  printf '%s\n' 'bdboard-harness hook: jq/python3 not found; skipping all checks (fail-open)' >&2
  exit 0
fi

deny() {
  for deny_line in "$@"; do
    printf '%s\n' "$deny_line" >&2
  done
  exit 2
}

# 必要なフィールドを 1 回の呼び出しでまとめて取り出す (フィールドごとに JSON ツールを
# 起動すると python3 経路で数百 ms かかる)。区切りは US(0x1f) — パスには TAB や改行も
# 入りうるので、それらは区切りに使えない。
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
        | [ (try ($d.cwd) catch null | scalar),
            (try ($d.tool_input.file_path) catch null | scalar),
            (try ($d.tool_input.notebook_path) catch null | scalar),
            (try ($d.agent_id) catch null | scalar) ]
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
' cwd tool_input.file_path tool_input.notebook_path agent_id 2>/dev/null
      ;;
  esac
}

HOOK_FIELDS="$(hook_fields)"
HOOK_CWD="${HOOK_FIELDS%%"$US_SEPARATOR"*}"
HOOK_FIELDS="${HOOK_FIELDS#*"$US_SEPARATOR"}"
TARGET_PATH="${HOOK_FIELDS%%"$US_SEPARATOR"*}"
HOOK_FIELDS="${HOOK_FIELDS#*"$US_SEPARATOR"}"
NOTEBOOK_PATH="${HOOK_FIELDS%%"$US_SEPARATOR"*}"
[ -n "$TARGET_PATH" ] || TARGET_PATH="$NOTEBOOK_PATH"
# agent_id は「サブエージェント内で hook が発火したときだけ」入力 JSON に付く (Claude Code
# の hook 入力仕様)。空ならトップレベル (議長) からの呼び出し。規則 2 だけが使う。
AGENT_ID="${HOOK_FIELDS#*"$US_SEPARATOR"}"

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

# git に渡せる「実在する最も近い祖先ディレクトリ」を求める (規則 2・3 で共有)。
# ABSOLUTE_PATH 自体は Write で新規作成されるパスかもしれず存在しないことがあるので、
# 親から実在する祖先まで遡る。
GIT_DIR_CANDIDATE="${ABSOLUTE_PATH%/*}"
[ -n "$GIT_DIR_CANDIDATE" ] || GIT_DIR_CANDIDATE='/'
while [ ! -d "$GIT_DIR_CANDIDATE" ] && [ "$GIT_DIR_CANDIDATE" != '/' ]; do
  GIT_DIR_CANDIDATE="${GIT_DIR_CANDIDATE%/*}"
  [ -n "$GIT_DIR_CANDIDATE" ] || GIT_DIR_CANDIDATE='/'
done
[ -d "$GIT_DIR_CANDIDATE" ] || GIT_DIR_CANDIDATE="$HOOK_CWD"

# 2. サブエージェント (agent_id あり) が main checkout (git rev-parse --git-common-dir
# の親) 配下を直接編集するのを止める (bdboard-kxqb)。議長 (agent_id なし) は対象外。
# .claude/worktrees/<id>/... はそれ自身の --show-toplevel が main と異なるため、
# bh_dir_is_main が自然に偽を返す (特別扱い不要)。main checkout 判定は server-guard.sh
# (規則 8) と同じ lib-main-checkout.sh を共有する (二重実装しない)。
if [ -n "$AGENT_ID" ]; then
  LIB_MAIN_CHECKOUT="$(dirname "$0")/lib-main-checkout.sh"
  if [ -r "$LIB_MAIN_CHECKOUT" ]; then
    # shellcheck source=lib-main-checkout.sh
    . "$LIB_MAIN_CHECKOUT"
    EDIT_MAIN="$(bh_main_checkout "$GIT_DIR_CANDIDATE")"
    if [ -n "$EDIT_MAIN" ] && bh_dir_is_main_or_git_internal "$GIT_DIR_CANDIDATE" "$EDIT_MAIN"; then
      deny \
        "bdboard-harness: サブエージェントは main checkout ($EDIT_MAIN) のファイルを編集できません。" \
        'worktree で作業してください: git -C '"$EDIT_MAIN"' worktree add .claude/worktrees/<id> -b bd/<id> origin/main' \
        'その worktree 内のパスを file_path に指定してください。'
    fi
  fi
fi

# 3. PR ブランチ (bd/*) で .beads/ を触ると CI のガードに落ちる。
case "$ABSOLUTE_PATH" in
  *'/.beads/'*) ;;
  *) exit 0 ;;
esac

BRANCH="$(git -C "$GIT_DIR_CANDIDATE" rev-parse --abbrev-ref HEAD 2>/dev/null)"
if [ -z "$BRANCH" ] || [ "$BRANCH" = 'HEAD' ]; then
  BRANCH="$(git -C "$GIT_DIR_CANDIDATE" symbolic-ref --quiet --short HEAD 2>/dev/null)"
fi
[ -n "$BRANCH" ] || exit 0

case "$BRANCH" in
  bd/*)
    deny \
      "bdboard-harness: PR ブランチ ($BRANCH) では .beads/ を変更できません。" \
      '.beads/ は PR に含めない。台帳の変更は bd コマンド経由で行う（ファイルを直接編集・コミットしない）。'
    ;;
esac

exit 0
