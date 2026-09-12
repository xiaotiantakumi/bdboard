#!/usr/bin/env bash
#
# bdboard-harness / 工程 × 複雑度のモデル候補選択 (bdboard-p5l.14 / p5l.20)。
#
# 契約: プロジェクト/worktree のルートで bash scripts/route.sh <stage> <complexity>。
# .claude/bdboard-harness.json の該当セルを、無ければ同じ stage の * を読み、
# member:model を候補順に 1 行ずつ返す。契約/models/stage/セル不在は無出力 exit 0。
# 不正入力は無出力 exit 1 + stderr、引数不正は exit 2。モデルの実行は呼び出し側の責務。
#
# bash scripts/route.sh --excluded <stage> <complexity> (bdboard-p5l.22): 同じ契約を
# 同じ検証で読み、セルを引けた (宣言されていて妥当な) ときだけ、有効な除外の member を
# 宣言順・重複なしで 1 行ずつ返す (そのセルの候補に居るかは問わない — 除外は routes
# 全体に効くため)。契約/models/stage/セル不在は通常モードと同じく無出力 exit 0。
# 通常モードの出力はこのオプションの追加で一切変わらない。
#
# models.exclude (bdboard-p5l.20): until (YYYY-MM-DD) が今日以降の entry を「有効な
# 除外」として member を候補列から落としてから出力する。期限切れ entry は自動で無視
# (TypeScript 側 domain/harness-contract.ts の isModelExcludeActive と同じ判定 —
# until を含む当日まで有効・固定長 YYYY-MM-DD の辞書順比較。ただしこれは TS 側が
# valid とみなす契約に限る — until が不正な文字列 (YYYY-MM-DD でない) のとき、shell
# は文字列の辞書順比較をそのまま行うため実質永久に除外され続けるが、TS 側はパース時点
# で invalid として弾く。両者が一致するのは「TS が valid と認める until」の範囲だけ)。
# 除外で候補が全部落ちても通常モードは無出力 exit 0 (「候補なし」と同じ形) のまま。通常モードの出力だけでは
# 「宣言されていないセル (意見なし)」と「宣言されていたが除外で空になったセル」を
# 呼び出し側が区別できないので、後者は --excluded で除外中の member を別に問い合わせる
# (pre-bash-guard.sh 規則6 は候補が空のときだけこれを引き、除外中の member を名指しした
# 委譲を deny、それ以外の member は従来どおり fail-open で通す)。
# exclude entry 自体が壊れている (member/until が文字列でない等) 場合は
# その entry だけ無視する。member が TS 側 MODEL_EXCLUDE_MEMBER_PATTERN
# (^[a-z][a-z0-9-]{0,15}$) に合わない entry も同様に無視する — --excluded の出力は
# 1 行 1 member なので、改行入りの member が別の member 名に化けるのを防ぐ
# (bdboard-p5l.22。TS はこの形を契約ごと invalid にする)。
# (契約全体は壊さない — 壊れた exclude で振り分け機能そのものが
# 止まるのは過剰反応)。
#
# 依存: bash(3.2 互換) と jq または python3。jq を優先し、両方無ければ診断して
# exit 127 — 「候補が無い」(無出力 exit 0) と「そもそも振り分けを解決できなかった」を
# 呼び出し側が区別できる必要があるので、黙って既定動作へは落とさない。
# set -e に頼らず読取失敗を明示的に扱う。
set -uo pipefail
LC_ALL=C; export LC_ALL

usage() {
  printf '%s\n' 'usage: bash route.sh [--excluded] <stage> <low|med|high>' >&2
  exit 2
}

# 出力モード。candidates (既定) はセルの残り候補、excluded は有効な除外の member。
output_mode='candidates'
if [[ $# -ge 1 && "$1" == '--excluded' ]]; then
  output_mode='excluded'
  shift
fi

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

# 固定長 YYYY-MM-DD 同士の辞書順比較で日付順になる (TS 側と同じ前提)。UTC 固定で
# タイムゾーンによる「除外が 1 日ずれる」を避ける。
today="$(date -u +%Y-%m-%d)"

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
      --arg pattern "$candidate_pattern" --arg today "$today" \
      --arg mode "$output_mode" '
      def object:
        if type == "object" then . else error("expected object") end;
      if length == 1 then .[0] else error("expected one JSON document") end
      | object
      | . as $doc
      # models.exclude (bdboard-p5l.20): 壊れた entry は個別に無視する (map(select) を
      # 2 段に分けて「まずオブジェクトだけに絞る」→「その上で文字列型を確認する」の順にし、
      # 非オブジェクト要素に .member/.until を当てて落ちる事故を避ける)。
      | ( ($doc.models.exclude // [])
          | if type == "array" then . else [] end
          | map(select(type == "object"))
          | map(select((.member|type) == "string" and (.until|type) == "string"))
          | map(select(.member | test("^[a-z][a-z0-9-]{0,15}\\z")))
          | map(select(.until >= $today))
          | map(.member)
        ) as $active_excluded
      | $doc
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
        else . end
      # --excluded (bdboard-p5l.22): セルを引けて検証も通ったときだけ、有効な除外の
      # member を宣言順・重複なしで返す。
      | if $mode == "excluded" then
          ( $active_excluded
            | reduce .[] as $m ([]; if any(.[]; . == $m) then . else . + [$m] end)
            | .[] )
        else
          # 除外された member を候補列から落とし、残りの候補で解決する (bdboard-p5l.20)。
          # 全部落ちても無出力 exit 0 (「候補なし」と同じ形) — セル空の警告は Hygiene 側。
          ( map(select( (split(":")[0]) as $m | ($active_excluded | index($m)) == null ))
            | .[] )
        end
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


# jq は BOM も不正 UTF-8 も黙って読む。Python の既定 (strict utf-8) だと
# 同じ契約が jq のマシンでは通り python3 のマシンでは exit 1 になるので、
# 「両経路は交換可能」というこのスクリプトの契約が壊れる。実測で確認した
# 差分は BOM 付きファイルと、読み取らない文字列中の不正 UTF-8 の 2 種。
with open(sys.argv[1], encoding="utf-8-sig", errors="replace") as source:
    document = object_value(json.load(source))
if "models" not in document:
    sys.exit(0)
models = object_value(document["models"])
routes = object_value(models.get("routes"))
stage, complexity, pattern, today, mode = sys.argv[2:]

# models.exclude (bdboard-p5l.20): 壊れた entry は個別に無視する (TypeScript 側
# domain/harness-contract.ts の isModelExcludeActive と同じ判定: until を含む当日
# まで有効・固定長 YYYY-MM-DD の辞書順比較)。
# 宣言順・重複なしのリスト (--excluded の出力順を jq 経路と揃えるため set にしない)。
active_excluded = []
exclude_raw = models.get("exclude")
if isinstance(exclude_raw, list):
    for entry in exclude_raw:
        if not isinstance(entry, dict):
            continue
        member = entry.get("member")
        until = entry.get("until")
        if not isinstance(member, str) or not isinstance(until, str):
            continue
        if re.fullmatch(r"[a-z][a-z0-9-]{0,15}", member) is None:
            continue
        if until >= today and member not in active_excluded:
            active_excluded.append(member)

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
# --excluded (bdboard-p5l.22): セルを引けて検証も通ったときだけ、有効な除外の
# member を宣言順・重複なしで返す。
if mode == "excluded":
    if active_excluded:
        sys.stdout.write("\n".join(active_excluded) + "\n")
    sys.exit(0)
# 除外された member を候補列から落とし、残りの候補で解決する (bdboard-p5l.20)。
# 全部落ちても無出力 exit 0 (「候補なし」と同じ形) — セル空の警告は Hygiene 側。
remaining = [c for c in candidates if c.split(":", 1)[0] not in active_excluded]
if remaining:
    sys.stdout.write("\n".join(remaining) + "\n")
' "$contract_path" "$stage" "$complexity" "$candidate_pattern" "$today" "$output_mode"
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
