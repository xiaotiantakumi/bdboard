#!/usr/bin/env bash
#
# bdboard-harness / 工程 × 複雑度のモデル候補選択 (bdboard-p5l.14)。
#
# 契約: プロジェクト/worktree のルートで bash scripts/route.sh <stage> <complexity>。
# .claude/bdboard-harness.json の該当セルを、無ければ同じ stage の * を読み、
# member:model を候補順に 1 行ずつ返す。契約/models/stage/セル不在は無出力 exit 0。
# 不正入力は無出力 exit 1 + stderr、引数不正は exit 2。モデルの実行は呼び出し側の責務。
#
# 依存: bash(3.2 互換) と jq または python3。jq を優先し、両方無ければ診断して
# exit 127 — 「候補が無い」(無出力 exit 0) と「そもそも振り分けを解決できなかった」を
# 呼び出し側が区別できる必要があるので、黙って既定動作へは落とさない。
# set -e に頼らず読取失敗を明示的に扱う。
set -uo pipefail
LC_ALL=C; export LC_ALL

usage() {
  printf '%s\n' 'usage: bash route.sh <stage> <low|med|high>' >&2
  exit 2
}

[[ $# -eq 2 ]] || usage
stage="$1"
complexity="$2"
stage_pattern='^[a-z][a-z0-9-]{0,31}$'
[[ "$stage" =~ $stage_pattern ]] || usage
case "$complexity" in
  low|med|high) ;;
  *) usage ;;
esac

contract_path='.claude/bdboard-harness.json'
[[ -e "$contract_path" ]] || exit 0

# domain/harness-contract.ts の MODEL_CANDIDATE_PATTERN と同じ文字集合。
# 両 JSON 経路へ同じパターンを渡す。終端は jq の \z / Python の fullmatch で厳密にする。
candidate_pattern='(claude|[a-z][a-z0-9-]{0,15}):[A-Za-z0-9][A-Za-z0-9._-]{0,63}'

# JSON ツールの有無は「呼ぶ前に」決める。呼んだ結果の終了コードで判定すると、
# ツールは在るのに 127 で落ちた場合 (非対話シェルで PATH が痩せた pyenv shim が
# `env: bash: No such file or directory` を出して 127 で終わる、など) を
# 「ツールが無い」と誤診断してしまう。
if command -v jq >/dev/null 2>&1; then
  json_tool='jq'
elif command -v python3 >/dev/null 2>&1; then
  json_tool='python3'
else
  printf '%s\n' 'bdboard-harness route: neither jq nor python3 found; cannot resolve model routing' >&2
  exit 127
fi

read_candidates() {
  if [[ "$json_tool" == 'jq' ]]; then
    jq -rs --arg stage "$stage" --arg complexity "$complexity" \
      --arg pattern "$candidate_pattern" '
      def object:
        if type == "object" then . else error("expected object") end;
      if length == 1 then .[0] else error("expected one JSON document") end
      | object
      | if has("models") then .models else empty end
      | object | .routes | object
      | if has($stage) then .[$stage] else empty end
      | object
      | if has($complexity) then .[$complexity]
        elif has("*") then .["*"]
        else empty end
      | if type != "array" then error("expected candidate array")
        elif length < 1 or length > 6 then error("expected 1 to 6 candidates")
        elif any(.[]; type != "string") then error("expected candidate string")
        elif any(.[]; test("^" + $pattern + "\\z") | not) then error("invalid candidate")
        elif any(.[]; startswith("claude:") and
          (. != "claude:haiku" and . != "claude:sonnet" and
           . != "claude:opus" and . != "claude:fable")) then error("invalid claude model")
        elif (unique | length) != length then error("duplicate candidate")
        else .[] end
    ' "$contract_path"
  else
    python3 -c '
import json
import re
import sys


def object_value(value):
    if not isinstance(value, dict):
        raise ValueError("expected object")
    return value


with open(sys.argv[1], encoding="utf-8") as source:
    document = object_value(json.load(source))
if "models" not in document:
    sys.exit(0)
models = object_value(document["models"])
routes = object_value(models.get("routes"))
stage, complexity, pattern = sys.argv[2:]
if stage not in routes:
    sys.exit(0)
route = object_value(routes[stage])
if complexity in route:
    candidates = route[complexity]
elif "*" in route:
    candidates = route["*"]
else:
    sys.exit(0)
if not isinstance(candidates, list) or not 1 <= len(candidates) <= 6:
    raise ValueError("expected 1 to 6 candidates")
for candidate in candidates:
    if not isinstance(candidate, str) or re.fullmatch(pattern, candidate) is None:
        raise ValueError("invalid candidate")
    if candidate.startswith("claude:") and candidate not in (
        "claude:haiku", "claude:sonnet", "claude:opus", "claude:fable"
    ):
        raise ValueError("invalid claude model")
if len(set(candidates)) != len(candidates):
    raise ValueError("duplicate candidate")
sys.stdout.write("\n".join(candidates) + "\n")
' "$contract_path" "$stage" "$complexity" "$candidate_pattern"
  fi
}

# 全件を検証し終わるまで stdout に出さない。末尾候補や JSON が不正でも部分出力しない。
candidates="$(read_candidates 2>/dev/null)"
status=$?
case "$status" in
  0)
    [[ -z "$candidates" ]] || printf '%s\n' "$candidates"
    exit 0
    ;;
  *)
    printf '%s\n' "bdboard-harness route: cannot read valid model candidates from .claude/bdboard-harness.json (via $json_tool)" >&2
    exit 1
    ;;
esac
