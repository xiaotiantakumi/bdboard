#!/usr/bin/env bash
#
# bdboard-harness / aimix run の委譲を、検証コントラクトのモデル振り分け表で確かめてから
# 実行するラッパー (bdboard-cm2q.12)。旧 pre-bash-guard.sh 規則 6 の置き換え。
#
# 使い方: プロジェクト/worktree の中で bash scripts/aimix-run.sh <aimix run の引数…>
#   (注入先では .claude/skills/bdboard-harness/scripts/aimix-run.sh)
#   aimix が PATH に無ければ AIMIX_BIN=<aimix の絶対パス> を付ける。
#
# 素の `aimix run` は permissions.deny `Bash(aimix run *)` で止める。deny はコマンド行
# だけを見るので、このスクリプトの中の `aimix run` は止まらない。引数はシェルが引用符を
# 外した後の argv で受け取るので、コマンド文字列の解析はしない。
#
# 判定 (旧規則 6 と同じ):
#   - --mode が implement / refactor のときだけ照合する。ほかはそのまま実行する。
#   - BDBOARD_ROUTE_OVERRIDE に理由 (空でない値) があれば照合しない。
#   - route.sh で <mode>/<complexity (既定 med)> の候補を引き、--member:--model が
#     候補に無ければ exit 2。--member が無い / --members 経由 / --model が無いも exit 2
#     (aimix はそのとき --model を無視して自分でモデルを選ぶため)。
#   - 候補が無いセル (表が無い = 意見なし) は通す。models.exclude で空になったセルでは、
#     除外中の member を名指ししたとき、または member を名指ししないときだけ exit 2。
#   - route.sh が使えない (契約不正・jq/python3 不在) ときは、警告 1 行を出して通す
#     (fail-open。振り分けの不備で委譲そのものを止めない)。
set -uo pipefail

AIMIX_RUN_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
ROUTE_SCRIPT="$AIMIX_RUN_DIR/route.sh"

run_aimix() {
  exec "${AIMIX_BIN:-aimix}" run "$@"
}

stop() {
  printf '%s\n' "$1" "$2" 'どうしても表から外れるなら BDBOARD_ROUTE_OVERRIDE="<理由>" を付けて実行してください。' >&2
  exit 2
}

# aimix run の argparse (allow_abbrev=True) と同じ長オプション解決。完全一致を優先し、
# そうでなければ一意な前方一致だけを返す。曖昧・未知は空 (aimix 自身がエラーにする)。
resolve_option() {
  local name="$1" option match='' count=0
  local options='mode member members category model complexity task task-file diff-file git-diff qa rounds cwd json no-log brief run-dir help'
  for option in $options; do
    [ "$name" = "$option" ] && { printf '%s' "$option"; return; }
  done
  for option in $options; do
    case "$option" in "$name"*) match="$option"; count=$((count + 1)) ;; esac
  done
  [ "$count" -eq 1 ] && printf '%s' "$match"
}

mode='consult'
member=''
members=''
model=''
complexity='med'
work_dir=''

args=("$@")
i=0
while [ "$i" -lt "${#args[@]}" ]; do
  arg="${args[$i]}"
  i=$((i + 1))
  case "$arg" in
    --) break ;;
    --*=*) name="${arg%%=*}"; value="${arg#*=}"; inline='yes' ;;
    --*) name="$arg"; value=''; inline='' ;;
    *) continue ;;
  esac
  option="$(resolve_option "${name#--}")"
  case "$option" in
    mode | member | members | category | model | complexity | task | task-file | diff-file | rounds | cwd | run-dir)
      # 値を取るオプション。値が「--」で始まっていても値として読み飛ばす
      # (`--task "--member cursor"` の中身をフラグと取り違えない)。
      if [ -z "$inline" ]; then
        value="${args[$i]:-}"
        i=$((i + 1))
      fi
      ;;
  esac
  # 同じオプションの繰り返しは argparse と同じく後勝ち。
  case "$option" in
    mode) mode="$value" ;;
    member) member="$value" ;;
    members) members="$value" ;;
    model) model="$value" ;;
    complexity) complexity="$value" ;;
    cwd) work_dir="$value" ;;
  esac
done

case "$mode" in
  implement | refactor) ;;
  *) run_aimix "$@" ;;
esac
[ -n "${BDBOARD_ROUTE_OVERRIDE:-}" ] && run_aimix "$@"
case "$complexity" in
  low | med | high) ;;
  *) run_aimix "$@" ;;
esac

# aimix の _resolve_specs と同じ優先順位: 空でない --member、無ければ --members の
# comma 区切りの先頭の空でない member (この経路では aimix が --model を無視する)。
from_members=''
if [ -z "$member" ] && [ -n "$members" ]; then
  old_ifs="$IFS"
  IFS=','
  for candidate in $members; do
    candidate="${candidate#"${candidate%%[![:space:]]*}"}"
    candidate="${candidate%"${candidate##*[![:space:]]}"}"
    if [ -n "$candidate" ]; then
      member="$candidate"
      from_members='yes'
      break
    fi
  done
  IFS="$old_ifs"
fi

# 契約は委譲先の作業ディレクトリのプロジェクトから読む (--cwd があればそこ)。
repo_root="$(git -C "${work_dir:-$PWD}" rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$repo_root" ] || [ ! -r "$ROUTE_SCRIPT" ]; then
  printf '%s\n' 'aimix-run.sh: 振り分け表を読めないので照合せずに実行します (git リポジトリ外か route.sh が無い)。' >&2
  run_aimix "$@"
fi

candidates="$(cd "$repo_root" && bash "$ROUTE_SCRIPT" "$mode" "$complexity" 2>/dev/null)"
if [ $? -ne 0 ]; then
  printf '%s\n' 'aimix-run.sh: route.sh が失敗したので照合せずに実行します (契約不正か jq/python3 不在)。' >&2
  run_aimix "$@"
fi

if [ -z "$candidates" ]; then
  excluded="$(cd "$repo_root" && bash "$ROUTE_SCRIPT" --excluded "$mode" "$complexity" 2>/dev/null)" ||
    run_aimix "$@"
  [ -n "$excluded" ] || run_aimix "$@"
  excluded_list="$(printf '%s' "$excluded" | tr '\n' ',' | sed 's/,$//')"
  [ -n "$member" ] || stop \
    "aimix-run.sh: ${mode}/${complexity} セルは models.exclude で候補が 0 件です。--member の明示が必須です。" \
    "除外中: $excluded_list"
  if printf '%s\n' "$excluded" | grep -qxF -- "$member"; then
    stop "aimix-run.sh: $member は models.exclude で除外中です (${mode}/${complexity} セル)。" \
      "除外中: $excluded_list"
  fi
  run_aimix "$@"
fi

candidate_list="$(printf '%s' "$candidates" | tr '\n' ',' | sed 's/,$//')"
[ -n "$member" ] || stop \
  "aimix-run.sh: ${mode}/${complexity} セルでは --member と --model の明示が必須です。" \
  "候補: $candidate_list"
[ -z "$from_members" ] || stop \
  'aimix-run.sh: --members では aimix が --model を無視します。--member <member> --model <候補> で呼んでください。' \
  "候補: $candidate_list"
[ -n "$model" ] || stop \
  "aimix-run.sh: ${mode}/${complexity} セルでは --model の明示が必須です (どの候補を使ったか記録に残すため)。" \
  "候補: $candidate_list"
printf '%s\n' "$candidates" | grep -qxF -- "$member:$model" || stop \
  "aimix-run.sh: $member:$model は ${mode}/${complexity} セルの候補ではありません。" \
  "候補: $candidate_list"

run_aimix "$@"
