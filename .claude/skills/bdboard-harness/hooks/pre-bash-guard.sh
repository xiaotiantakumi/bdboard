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
# 見ると `bd dolt push --remote backup; bd dolt push` のように「先頭だけ行儀の良い」
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
      'remote を必ず明示してください: bd dolt push --remote <name>。' \
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

# 6. aimix run のモデル指定を、検証コントラクトの models 表のセル所属で照合する。
#
#    ここに置くのは意図的。規則 5 の後ろに置くと、その直前の
#    `[ -n "$CONTRACT_PATTERN_LIST" ] || exit 0` に食われて、hooks.denyBashPatterns を
#    持たない契約では規則 6 が一切走らなくなる。
#
#    判定は「そのセルの候補配列に含まれるか」だけで行う。vendor 名 (codex / cursor /
#    claude) で弾くと、セルの正当な 2 番手である cursor:... が道連れになる。
#    唯一の例外は models.exclude で候補が 0 件になったセルで、そこでは「除外中の
#    member を名指ししたか」だけを見る (bdboard-p5l.22、下の route.sh --excluded 参照)。
#
#    候補の抽出は scripts/route.sh に一本化する (jq/python3 の抽出ロジックをここへ
#    コピーしない)。hooks/ の隣が scripts/ という関係は正本
#    (harness/packs/bdboard-harness/) でも注入コピー
#    (.claude/skills/bdboard-harness/) でも同じなので、$0 からの相対で解決できる。
ROUTE_SCRIPT="$(cd "$(dirname "$0")/../scripts" 2>/dev/null && pwd)/route.sh"

# aimix run の argparse (allow_abbrev=True) と同じ長オプション解決をする。
# 完全一致を優先し、そうでなければ既知オプションの一意な前方一致だけを返す。
# 曖昧・未知な名前は空を返す。aimix 本体は曖昧名を argparse エラーにするが、hook は
# 素朴なトークン分割で引数内の断片も拾うため、そのトークンだけを無視して走査を続ける。
resolve_aimix_option() {
  resolve_name="$1"
  resolve_options='mode member members category model complexity task task-file diff-file rounds cwd run-dir git-diff qa json no-log brief help'

  for resolve_option in $resolve_options; do
    [ "$resolve_name" = "$resolve_option" ] && {
      printf '%s' "$resolve_option"
      return
    }
  done

  resolve_match=''
  resolve_count=0
  for resolve_option in $resolve_options; do
    case "$resolve_option" in
      "$resolve_name"*)
        resolve_match="$resolve_option"
        resolve_count=$((resolve_count + 1))
        ;;
    esac
  done
  [ "$resolve_count" -eq 1 ] && printf '%s' "$resolve_match"
}

# hook のコマンド分割は空白分割 (set -f) だが、aimix が受け取るのはシェルが引用符を外した
# 後の引数である。そこで空白で割った断片を「開いた引用符が閉じるまで」つなぎ直し、引用符
# 文字を取り除いてから 1 語として aimix_words に入れる (bdboard-uaqe レビュー)。これを
# しないと次の 3 つがいずれも aimix の実際の解釈とずれる:
#   - `--task "x --comp y"` の中の断片を complexity と読んで判定を放棄する
#   - `"--complexity" high` をオプションと認識せず、既定の med セルで照合する
#   - `--members " cursor"` の先頭 member を読めず、除外で空になったセルを素通りする
# バックスラッシュエスケープ・$()・変数展開は扱わない近似。引用符の種類は各断片で最初に
# 現れたものだけを数える。閉じない引用符 (シェルなら構文エラー) は残りを 1 語にする。
aimix_segment_words() {
  aimix_words=()
  aimix_pending=''
  aimix_quote=''
  aimix_dq='"'
  aimix_sq="'"
  set -f
  # shellcheck disable=SC2086
  set -- $1
  set +f
  for aimix_piece in "$@"; do
    if [ -n "$aimix_quote" ]; then
      aimix_pending="$aimix_pending $aimix_piece"
      aimix_count="${aimix_piece//[!$aimix_quote]/}"
      [ $(( ${#aimix_count} % 2 )) -eq 1 ] || continue
      aimix_quote=''
      aimix_unquoted="${aimix_pending//$aimix_dq/}"
      aimix_words[${#aimix_words[@]}]="${aimix_unquoted//$aimix_sq/}"
      aimix_pending=''
      continue
    fi
    # 先に現れた引用符の種類を、その手前までの長さで決める (無い種類は断片全体の長さ)。
    aimix_before_dq="${aimix_piece%%"$aimix_dq"*}"
    aimix_before_sq="${aimix_piece%%"$aimix_sq"*}"
    aimix_first=''
    if [ "${#aimix_before_dq}" -lt "${#aimix_before_sq}" ]; then
      aimix_first="$aimix_dq"
    elif [ "${#aimix_before_sq}" -lt "${#aimix_before_dq}" ]; then
      aimix_first="$aimix_sq"
    fi
    if [ -n "$aimix_first" ]; then
      aimix_count="${aimix_piece//[!$aimix_first]/}"
      if [ $(( ${#aimix_count} % 2 )) -eq 1 ]; then
        aimix_quote="$aimix_first"
        aimix_pending="$aimix_piece"
        continue
      fi
    fi
    aimix_unquoted="${aimix_piece//$aimix_dq/}"
    aimix_words[${#aimix_words[@]}]="${aimix_unquoted//$aimix_sq/}"
  done
  if [ -n "$aimix_quote" ]; then
    aimix_unquoted="${aimix_pending//$aimix_dq/}"
    aimix_words[${#aimix_words[@]}]="${aimix_unquoted//$aimix_sq/}"
  fi
}

# 1 セグメントを 1 回だけ走査し、規則 6 が使う実効引数をグローバル変数へ入れる。
# 語への分割は aimix_segment_words (引用符をつなぎ直す近似) に任せる。
# 値を取るオプションは `--name=value` と `--name value` の両方を受け、同じものは後勝ち。
scan_aimix_segment() {
  route_stage='consult'
  route_member_flag=''
  route_members_flag=''
  route_model=''
  route_complexity='med'

  aimix_segment_words "$1"
  set -- "${aimix_words[@]}"
  while [ $# -gt 0 ]; do
    scan_token="$1"
    shift
    case "$scan_token" in
      --*) ;;
      *) continue ;;
    esac

    scan_body="${scan_token#--}"
    scan_has_equals=''
    case "$scan_body" in
      *=*)
        scan_name="${scan_body%%=*}"
        scan_value="${scan_body#*=}"
        scan_has_equals='yes'
        ;;
      *)
        scan_name="$scan_body"
        scan_value=''
        ;;
    esac

    scan_option="$(resolve_aimix_option "$scan_name")"
    [ -n "$scan_option" ] || continue

    case "$scan_option" in
      mode | member | members | category | model | complexity | task | task-file | diff-file | rounds | cwd | run-dir)
        # argparse は `-` で始まる 2 文字以上の引数を値として取らない。ただし空白を含む
        # 引数は位置引数扱いなので値として取る (`--task "--member cursor"` 等)。
        if [ -z "$scan_has_equals" ] && [ $# -gt 0 ]; then
          case "$1" in
            *' '*) scan_value="$1"; shift ;;
            -?*) ;;
            *) scan_value="$1"; shift ;;
          esac
        fi
        case "$scan_option" in
          mode) route_stage="$scan_value" ;;
          member) route_member_flag="$scan_value" ;;
          members) route_members_flag="$scan_value" ;;
          model) route_model="$scan_value" ;;
          complexity) route_complexity="$scan_value" ;;
        esac
        ;;
    esac
  done
}

first_aimix_member() {
  # argparse の _resolve_specs と同じく comma split → strip → 空要素除外の先頭。
  # hook の素朴な token 分割で残る引用符は member 名に混ぜない。
  first_members="$(printf '%s' "$1" | tr -d "\"'")"
  first_old_ifs="$IFS"
  IFS=','
  set -f
  # shellcheck disable=SC2086
  set -- $first_members
  set +f
  IFS="$first_old_ifs"
  while [ $# -gt 0 ]; do
    first_member="$(printf '%s' "$1" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    [ -n "$first_member" ] && {
      printf '%s' "$first_member"
      return
    }
    shift
  done
}

# stderr は 3 行以内という不変条件を守る。member/model はコマンド行由来 (= route.sh の
# 候補正規表現を通っていない) 文字列なので、規則 5 の contract message と同じ理由で
# 改行/CR/TAB を空白へ潰し、長さを切ってから出す。
route_safe() {
  route_safe_value="$(printf '%s' "$1" | tr '\n\r\t' '   ')"
  printf '%s' "${route_safe_value:0:200}"
}

# 規則 6 専用のセグメント分割。規則 1〜5 と違って複数のフラグが 1 セグメントに揃って
# いることを前提にするので、先に行継続 (`\` + 改行) を畳む。畳まないと、実際に文書化
# されている複数行の呼び出し形 (agents/*.md の `aimix run ... \` 形式) で
# 「--model が別行 → 誤 deny」「--complexity が別行 → 照合を素通り」の両方が起きる。
# 規則 1〜5 は単一トークン照合なので、こちらだけ畳んで影響範囲を閉じる。
aimix_command_segments() {
  printf '%s\n' "$COMMAND" | sed -e :a -e '/\\$/N; s/\\\n/ /; ta' | tr ';&|' '\n\n\n'
}

AIMIX_SEGMENTS="$(aimix_command_segments |
  grep -E '(^|[^[:alnum:]_-])aimix[[:space:]]+run([[:space:]]|$)' 2>/dev/null)"
if [ -n "$AIMIX_SEGMENTS" ] && [ -r "$ROUTE_SCRIPT" ]; then
  while IFS= read -r aimix_segment; do
    [ -n "$aimix_segment" ] || continue

    # ゲート対象は implement / refactor だけ。consult / review / debate は素通り。
    # (現在の aimix run --mode に refactor は無いが、先回りしてゲートしておく。)
    scan_aimix_segment "$aimix_segment"
    case "$route_stage" in
      implement | refactor) ;;
      *) continue ;;
    esac

    # エスケープハッチを先に見る。環境変数でも、コマンド頭のインライン代入でもよい。
    # 理由が空 (BDBOARD_ROUTE_OVERRIDE= / ="" / ='') は「理由なし」なので通さない。
    #
    # インライン代入は **aimix より前のプレフィックスだけ** を見る。セグメント全体の
    # 部分一致にすると、`--task "... BDBOARD_ROUTE_OVERRIDE=x ..."` のように引数の
    # 中身で黙ってゲートが外れる。しかも下の deny 文言自身がこの文字列を含むので、
    # deny 文や README を委譲ブリーフへ貼って再試行するだけで無効化できてしまう。
    route_override="${BDBOARD_ROUTE_OVERRIDE:-}"
    route_override_prefix="${aimix_segment%%aimix*}"
    case "$route_override_prefix" in
      *BDBOARD_ROUTE_OVERRIDE=*)
        route_override_rest="${route_override_prefix#*BDBOARD_ROUTE_OVERRIDE=}"
        case "$route_override_rest" in
          '"'*) route_override_rest="${route_override_rest#\"}"
                route_override="${route_override_rest%%\"*}" ;;
          "'"*) route_override_rest="${route_override_rest#\'}"
                route_override="${route_override_rest%%\'*}" ;;
          *) route_override="${route_override_rest%%[[:space:]]*}" ;;
        esac
        ;;
    esac
    [ -n "$route_override" ] && continue

    # --complexity 省略は aimix の既定 med として判定する。aimix が実際に使うセルで
    # 照合するだけで、チケットの bdboard.complexity 未記録を deny にするかは引き続き
    # Phase 2 (bdboard-p5l.19) の話。明示値が choices 外なら aimix 自身がエラーにするため
    # hook は素通りさせる。
    case "$route_complexity" in
      low | med | high) ;;
      *) continue ;;
    esac

    # _resolve_specs と同じ優先順位。空でない --member が最優先。そうでなければ
    # --members の comma 区切りから先頭の空でない member を使う。この経路では
    # aimix が --model を無視して tier 既定モデルを選ぶため、候補のあるセルでは後で deny。
    route_member=''
    route_member_from_members=''
    if [ -n "$route_member_flag" ]; then
      route_member="$route_member_flag"
    elif [ -n "$route_members_flag" ]; then
      route_member="$(first_aimix_member "$route_members_flag")"
      [ -n "$route_member" ] && route_member_from_members='yes'
    fi

    # route.sh は「候補なし」を無出力 exit 0、契約不正を exit 1、jq/python3 不在を
    # exit 127 で返す。deny してよいのは「候補を実際に取れた」ときと、下の「除外で
    # 空になったセルで除外中の member を名指しした」ときだけ。
    ROUTE_CANDIDATES="$(cd "$REPO_ROOT" 2>/dev/null &&
      bash "$ROUTE_SCRIPT" "$route_stage" "$route_complexity" 2>/dev/null)"
    [ $? -eq 0 ] || continue

    # 候補が空 (bdboard-p5l.22)。通常出力だけでは「宣言されていないセル = 意見なし」と
    # 「宣言されていたが models.exclude で空になったセル」を区別できない。後者で素通り
    # させると、除外した member 自身の委譲まで通ってしまう。そこで route.sh --excluded
    # で「セルを引けたときだけ」有効な除外 member の一覧を問い合わせ、名指しされた
    # member がそこに居れば deny する。居なければ従来どおり fail-open で通す — 空セルを
    # 全面 deny にすると、枠逼迫の退避 (exclude) が委譲の全停止になってしまうため。
    # --excluded が非 0 (契約不正・古い route.sh で usage exit 2 等) なら判定しない。
    if [ -z "$ROUTE_CANDIDATES" ]; then
      [ -n "$route_member" ] || continue
      ROUTE_EXCLUDED="$(cd "$REPO_ROOT" 2>/dev/null &&
        bash "$ROUTE_SCRIPT" --excluded "$route_stage" "$route_complexity" 2>/dev/null)"
      [ $? -eq 0 ] || continue
      route_excluded_hit=''
      while IFS= read -r route_excluded_member; do
        [ -n "$route_excluded_member" ] || continue
        [ "$route_excluded_member" = "$route_member" ] && route_excluded_hit='yes'
      done <<ROUTE_EXCLUDED_EOF
$ROUTE_EXCLUDED
ROUTE_EXCLUDED_EOF
      [ -n "$route_excluded_hit" ] || continue
      deny \
        "bdboard-harness: $(route_safe "$route_member") は検証コントラクトの models.exclude で除外中です (${route_stage}/${route_complexity} セルは除外で候補が 0 件)。" \
        '除外されていない member で委譲するか、models.exclude の until を見直してください。' \
        'どうしても表から外れるなら BDBOARD_ROUTE_OVERRIDE="<理由>" を前置してください。'
    fi

    route_candidate_list="$(printf '%s' "$ROUTE_CANDIDATES" | tr '\n' ',' | sed 's/,$//')"

    if [ -z "$route_member" ]; then
      deny \
        'bdboard-harness: 振り分け表のあるこの工程/複雑度では --member と --model の明示が必須です (--member が無いと aimix は --model を無視して自分でモデルを選びます)。' \
        "候補: $(route_safe "$route_candidate_list")" \
        'どうしても表から外れるなら BDBOARD_ROUTE_OVERRIDE="<理由>" を前置してください。'
    fi

    if [ -n "$route_member_from_members" ]; then
      deny \
        'bdboard-harness: --members では aimix が --model を無視し tier 既定モデルで先頭 member を実行します。--member <member> --model <候補> で呼んでください。' \
        "候補: $(route_safe "$route_candidate_list")" \
        'どうしても表から外れるなら BDBOARD_ROUTE_OVERRIDE="<理由>" を前置してください。'
    fi

    # --model の必須チェックは「セルの候補を実際に取れた」後に置く。前に置くと、
    # models 表を宣言していないプロジェクト (照合は必ず fail-open) でも deny だけが
    # 発火し、しかも案内する route.sh は無出力なので従いようがない。実際 bdboard 自身の
    # 契約にはまだ models 節が無く、そこでは「強制力ゼロ・摩擦のみ」になっていた。
    # ここに置けば「表を持つプロジェクトでだけ、どの候補を使ったかを明示させる」になる。
    if [ -z "$route_model" ]; then
      deny \
        'bdboard-harness: 振り分け表のあるこの工程/複雑度では aimix run に --model の明示が必須です (どの候補を使ったか記録に残らないため)。' \
        "候補: $(route_safe "$route_candidate_list")" \
        'どうしても表から外れるなら BDBOARD_ROUTE_OVERRIDE="<理由>" を前置してください。'
    fi

    route_wanted="$route_member:$route_model"
    route_hit=''
    while IFS= read -r route_candidate; do
      [ "$route_candidate" = "$route_wanted" ] && route_hit='yes'
    done <<ROUTE_CANDIDATES_EOF
$ROUTE_CANDIDATES
ROUTE_CANDIDATES_EOF
    [ -n "$route_hit" ] && continue

    deny \
      "bdboard-harness: $(route_safe "$route_wanted") は検証コントラクトの ${route_stage}/${route_complexity} セルの候補ではありません。" \
      "候補: $(route_safe "$route_candidate_list")" \
      'どうしても表から外れるなら BDBOARD_ROUTE_OVERRIDE="<理由>" を前置してください。'
  done <<AIMIX_SEGMENTS_EOF
$AIMIX_SEGMENTS
AIMIX_SEGMENTS_EOF
fi

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
