# shellcheck shell=bash
# worktree-owner-guard.sh — pre-bash-guard.sh の規則 9「worktree の持ち主保護」
# (bdboard-gsnn)。
#
# 単独では実行しない。pre-bash-guard.sh の規則 7 (server-guard.sh) の直後から `.` で
# 読み込まれ、呼び出し元の COMMAND / HOOK_CWD / AGENT_ID / deny() / matches() を前提に
# する。判定できないものは return 0 で呼び出し元へ戻す (fail-open)。
#
# 設計は hooks/README.md「9 の worktree 所有権保護」を参照。要約:
#   - サブエージェント (agent_id あり) が「持ち主でない worktree」を実効ディレクトリ
#     または対象 (worktree remove の引数・branch -D のブランチ名) として、公開/マージ系
#     の操作 (git push / git commit / git worktree remove / git branch -D bd/<id> /
#     gh pr merge / npm run merge-pr -- <sub>) をするのを deny する。
#   - 持ち主は「そのチケット worktree でこれらの操作のどれかを最初に行ったサブ
#     エージェント」(git worktree add の成功時点ではなく遅延クレーム)。記録の無い
#     worktree (このガードより前に作られたもの含む) は最初に触ったサブエージェントが
#     その場で持ち主になる。議長 (agent_id 無し) は常に対象外。
#   - 解除は議長専用の scripts/worktree-owner.sh release <id> (このファイルの末尾で
#     サブエージェントからの実行を deny する)。解除後は次に触ったサブエージェントが
#     新しい持ち主になる。
#   - git push は cwd ベースの判定 (通常のクレーム可能な経路) に加えて、各 refspec の
#     両側の文字列 (先頭の + と refs/heads/・heads/・refs/ の前置きを剥がした後) を
#     bd/* と照合する deny 専用の判定も行う (bdboard-qpxq #797 / bdboard-ob0l)。
#     こちらはクレームしない — push 対象の文字列だけからは「その id の worktree に
#     実際に触れた」とは言えないため (bdboard-ob0l F3)。git branch -D bd/<id> も同じ
#     理由でクレームしない (ブランチ名文字列だけから見ており、実効ディレクトリとは
#     無関係。bdboard-ob0l で修正: opus レビューで発見・確認した F3 と同型のバグ)。
#

# 引用符を考慮したセグメント分割 (server-guard.sh の bdboard-kmh2 由来の
# sg_mask_quoted_separators) はあえて再利用しない。規則 9 が見るのは各セグメントの
# 先頭語 (git/npm/gh) と直後のサブコマンドだけなので、引用符内の ; & | が素朴な分割で
# 余分なセグメントを作っても本物の呼び出しの先頭語が分断されることはない。唯一の
# 副作用は「引用符の中にたまたま git commit 等の並びがあると誤検知で deny 側に倒れる」
# ことだけで、これは規則 6 (bdboard-wa48)と同じ「言及しただけで deny」方針・「見逃しより
# 誤検知」原則と整合する。既にレビュー済みで枯れている規則 7/8 のコードへ手を入れる
# リスクの方がこの誤検知リスクより大きいと判断した (詳細は bdboard-gsnn の PR 本文)。
#
# 限界: 実効ディレクトリの解決はこのファイル専用の簡易版で、cd / pushd / popd と
# git -C・npm --prefix の直接指定だけを追う。NAME=値 代入の展開・別ファイルへ書いて
# 実行する迂回・絶対パス/バックスラッシュ経由の git 呼び出しは追わない (規則 7/8 の
# 既知の限界と同種。見逃しは fail-open のまま = このチケット以前と同じ無防備さで、
# 新規の後退ではない)。複数の `git -C a -C b` は前の -C からの相対で連鎖して解決する
# (bdboard-2i15)。`git branch` の force delete 検出は `-D` に加えて `--delete`/`-d` と
# `--force`/`-f` の組み合わせ (順不同) も見る (bdboard-2i15)。`npx npm run merge-pr` の
# ような間接実行 (npm が先頭語にならない形) は引き続き対象外 (bdboard-2i15 では見送り)。

matches '(^|[^[:alnum:]_./-])(git|gh|npm)([^[:alnum:]_-]|$)|\.sh([^[:alnum:]_-]|$)' || return 0

[ -n "$AGENT_ID" ] || return 0

LIB_MAIN_CHECKOUT_WOG="$(dirname "$0")/lib-main-checkout.sh"
[ -r "$LIB_MAIN_CHECKOUT_WOG" ] || return 0
# shellcheck source=lib-main-checkout.sh
. "$LIB_MAIN_CHECKOUT_WOG"

WOG_MAIN="$(bh_main_checkout "$HOOK_CWD")"
[ -n "$WOG_MAIN" ] || return 0

wog_audit() {
  wog_log_dir="${TMPDIR:-/tmp}"
  wog_flat="$(printf '%s' "$COMMAND" | tr '\n\r\t' '   ')"
  printf '%s\t%s\tagent=%s\tcwd=%s\tcmd=%s\n' \
    "$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)" "$1" "$AGENT_ID" \
    "$HOOK_CWD" "${wog_flat:0:300}" \
    >>"${wog_log_dir%/}/bdboard-worktree-owner-guard.log" 2>/dev/null || true
}

# 引数: id, label (deny 文言用)。持ち主が自分以外なら deny、記録が無ければこの
# agent_id でクレームして allow (遅延クレーム)。
wog_check_id() {
  wog_id="$1"
  wog_label="$2"
  wog_allow_claim="${3:-yes}"
  wog_owner="$(bh_read_owner "$WOG_MAIN" "$wog_id")"
  if [ -z "$wog_owner" ]; then
    if [ "$wog_allow_claim" != 'yes' ] || [ -z "$WOG_SEG_GENUINE" ]; then
      # 引用符内から漏れ出た偽のセグメントによる誤クレームを防ぐ (bdboard-s9gi)、
      # または push refspec 対象由来でクレームを許可されていない (bdboard-ob0l F3)。
      # 本物の呼び出しでないと判定できた場合、またはクレーム不可の判定経路の
      # 場合のみここに来る。deny 側の判定 (下の既存ロジック) は変更しない —
      # 既に持ち主がいる場合はこの判定を経由せずそちらに進む。
      return 0
    fi
    if bh_claim_owner "$WOG_MAIN" "$wog_id" "$AGENT_ID"; then
      wog_audit "9-claim-$wog_label-$wog_id"
      return 0
    fi
    wog_owner="$(bh_read_owner "$WOG_MAIN" "$wog_id")"
    [ -n "$wog_owner" ] || return 0
  fi
  [ "$wog_owner" = "$AGENT_ID" ] && return 0
  wog_audit "9-$wog_label-$wog_id"
  deny \
    "bdboard-harness: worktree bd/$wog_id は別のサブエージェント (${wog_owner:0:24}) の持ち物です。$wog_label はできません。" \
    'このチケットの prepare/gate/finish/push/merge は、別ディレクトリからでも行わないでください。議長に報告してください。' \
    "持ち主が動けないなら議長に bash .claude/skills/bdboard-harness/scripts/worktree-owner.sh release $wog_id を頼んでください。"
}

# 引数: dir, label。dir が登録済みの per-ticket worktree なら wog_check_id へ。
# そうでなければ何もしない (main checkout 自身や無関係なディレクトリは対象外)。
wog_check_dir() {
  wog_cd_id="$(bh_ticket_id_for_dir "$1" "$WOG_MAIN")" || return 0
  [ -n "$wog_cd_id" ] || return 0
  wog_check_id "$wog_cd_id" "$2"
}

# 引数: pr番号。<main>/.git/bdboard-merge/pr-<N>.json の .id を返す (無ければ空)。
# $JSON_TOOL が空 (jq も python3 も無い) なら常に空を返す (fail-open)。
wog_ticket_id_for_pr() {
  wog_pr_num="$1"
  wog_state_file="$WOG_MAIN/.git/bdboard-merge/pr-$wog_pr_num.json"
  [ -f "$wog_state_file" ] || return 0
  case "$JSON_TOOL" in
    jq)
      jq -r '
        try (.id) catch ""
        | if type == "string" then . else "" end
      ' <"$wog_state_file" 2>/dev/null
      ;;
    python3)
      python3 -c '
import json, sys
try:
    doc = json.load(sys.stdin)
except Exception:
    sys.exit(0)
value = doc.get("id") if isinstance(doc, dict) else None
sys.stdout.write(value if isinstance(value, str) else "")
' <"$wog_state_file" 2>/dev/null
      ;;
  esac
}

WOG_NL=$'\n'
# バックスラッシュ改行 (行継続) は素の $WOG_NL 分割に巻き込まれる前に空白へ潰す
# (bdboard-gsnn のレビューで発見: 以前は誤って "\$WOG_NL" というリテラル文字列を
# 探していて行継続を一切結合できていなかった)。
WOG_SEGMENTS="${COMMAND//\\$WOG_NL/ }"
WOG_SEGMENTS="${WOG_SEGMENTS//&&/$WOG_NL}"
WOG_SEGMENTS="${WOG_SEGMENTS//\|\|/$WOG_NL}"
# 単独の `|` も区切りとして扱う (上の || 置換より後段なので、ここに残るのは
# 本物の単独パイプだけ)。
WOG_SEGMENTS="${WOG_SEGMENTS//|/$WOG_NL}"
WOG_SEGMENTS="${WOG_SEGMENTS//;/$WOG_NL}"
WOG_SEGMENTS="${WOG_SEGMENTS//&/$WOG_NL}"

WOG_DIR="$(bh_canon "$HOOK_CWD")"
WOG_PREV_DIR="$WOG_DIR"
WOG_SUBSHELL_DIR=''
WOG_RELEASE_SCRIPT_BASE='worktree-owner.sh'

WOG_QUOTE_STATE='n'

# $1 の生テキストを走査し、引用符の開閉状態 ($WOG_QUOTE_STATE: n=通常 / '=シングル
# クォート内 / "=ダブルクォート内) をセグメントをまたいで引き継ぐ。素朴な区切り文字
# 分割 (WOG_SEGMENTS) が引用符の中で ; & | を割ってしまっても、次のセグメントの
# 先頭が「本当に引用符の外で始まったか」を判定できるようにするため (bdboard-s9gi)。
# シングルクォート内はバックスラッシュに特別な意味を持たせない (POSIX 準拠)。
# ダブルクォート内・通常状態ではバックスラッシュは直後の1文字をエスケープする
# (閉じクォート文字の直前がバックスラッシュなら閉じない)。ヒアドキュメント本体や
# $() のネストは追わない (このファイルの既存の「限界」節と同種、規則7/8ほどの
# 厳密さは元々持たない設計)。
wog_scan_quote_state() {
  wog_qs_s="$1"
  wog_qs_len=${#wog_qs_s}
  wog_qs_i=0
  while [ "$wog_qs_i" -lt "$wog_qs_len" ]; do
    wog_qs_c="${wog_qs_s:wog_qs_i:1}"
    case "$WOG_QUOTE_STATE" in
      n)
        case "$wog_qs_c" in
          '\')
            wog_qs_i=$((wog_qs_i + 1))
            ;;
          "'") WOG_QUOTE_STATE="'" ;;
          '"') WOG_QUOTE_STATE='"' ;;
        esac
        ;;
      "'")
        [ "$wog_qs_c" = "'" ] && WOG_QUOTE_STATE='n'
        ;;
      '"')
        case "$wog_qs_c" in
          '\')
            wog_qs_i=$((wog_qs_i + 1))
            ;;
          '"') WOG_QUOTE_STATE='n' ;;
        esac
        ;;
    esac
    wog_qs_i=$((wog_qs_i + 1))
  done
}

wog_resolve_dir() {
  case "$1" in
    '') printf '%s' "${HOME:-$WOG_DIR}" ;;
    -) printf '%s' "$WOG_PREV_DIR" ;;
    /*) bh_canon "$1" ;;
    *) bh_canon "$WOG_DIR/$1" ;;
  esac
}

set -f
while IFS= read -r wog_seg; do
  wog_seg="${wog_seg#"${wog_seg%%[![:space:]]*}"}"
  [ -n "$wog_seg" ] || continue
  wog_seg_raw="$wog_seg"
  WOG_SEG_GENUINE=''
  [ "$WOG_QUOTE_STATE" = 'n' ] && WOG_SEG_GENUINE='yes'
  wog_scan_quote_state "$wog_seg_raw"
  case "$wog_seg" in
    '('* )
      WOG_SUBSHELL_DIR="$WOG_DIR"
      wog_seg="${wog_seg#\(}"
      wog_seg="${wog_seg#"${wog_seg%%[![:space:]]*}"}"
      ;;
    '{'*)
      wog_seg="${wog_seg#\{}"
      wog_seg="${wog_seg#"${wog_seg%%[![:space:]]*}"}"
      ;;
  esac
  wog_closes_subshell=''
  case "$wog_seg" in *')') wog_closes_subshell='yes' ;; esac

  # `)` も一緒に剥がす (サブシェル閉じ括弧が最終トークンに残って `(cmd)` 形の
  # 呼び出しが先頭語判定をすり抜けるのを防ぐ。閉じ判定自体は上の wog_seg の
  # 生の文字列に対して既に済んでいるので、ここで剥がしても影響しない)。
  wog_clean="$(printf '%s' "$wog_seg" | tr -d "\"')")"
  # shellcheck disable=SC2086
  set -- $wog_clean

  case "$wog_seg" in
    *bdboard-worktree-owners*)
      wog_audit 'owner-record-tamper-denied'
      deny \
        'bdboard-harness: worktree の所有権記録 (bdboard-worktree-owners) への直接操作はサブエージェントから禁止です。' \
        'worktree-owner-guard.sh 経由の通常操作か、議長への報告で対応してください。' \
        '議長は必要なら直接ファイルを操作できます (agent_id が無いため対象外)。'
      ;;
  esac

  # release スクリプトの呼び出し検出はこのセグメントの全トークンを見る (bash/sh
  # 経由の間接実行にも耐えるため。先頭語だけの判定では bash scripts/worktree-owner.sh
  # release <id> のような形を取りこぼす)。
  wog_release_hit=''
  for wog_tok in "$@"; do
    if [ -n "$wog_release_hit" ] && [ "$wog_tok" = 'release' ]; then
      wog_audit 'release-denied'
      deny \
        'bdboard-harness: worktree-owner.sh release はサブエージェントから実行できません (議長専用)。' \
        '持ち主が動けない worktree があれば、その id を最終報告で議長に伝えてください。' \
        '議長は bash .claude/skills/bdboard-harness/scripts/worktree-owner.sh release <id> を実行して引き継ぎを解除します。'
    fi
    if [ -n "$wog_release_hit" ]; then
      wog_release_hit=''
    fi
    if [ "${wog_tok##*/}" = "$WOG_RELEASE_SCRIPT_BASE" ]; then
      wog_release_hit='yes'
    fi
  done

  while [ $# -gt 0 ]; do
    case "$1" in
      nohup | exec | command | builtin | time | sudo | caffeinate) shift ;;
      *) break ;;
    esac
  done
  if [ $# -eq 0 ]; then
    if [ -n "$wog_closes_subshell" ] && [ -n "$WOG_SUBSHELL_DIR" ]; then
      WOG_DIR="$WOG_SUBSHELL_DIR"
      WOG_SUBSHELL_DIR=''
    fi
    continue
  fi
  wog_word="${1##*/}"

  case "$wog_word" in
    cd | pushd)
      WOG_PREV_DIR="$WOG_DIR"
      WOG_DIR="$(wog_resolve_dir "${2:-}")"
      ;;
    popd)
      WOG_DIR="$WOG_PREV_DIR"
      ;;
    git)
      shift
      wog_git_dir="$WOG_DIR"
      while [ $# -gt 0 ]; do
        case "$1" in
          -C)
            # 複数の -C は本物の git と同じく「直前の -C からの相対」で連鎖させる
            # (bdboard-2i15): wog_resolve_dir は $WOG_DIR を基準に解決するので、
            # 一時的に $WOG_DIR を直前の wog_git_dir に差し替えてから呼ぶ。
            wog_c_saved_dir="$WOG_DIR"
            WOG_DIR="$wog_git_dir"
            wog_git_dir="$(wog_resolve_dir "${2:-}")"
            WOG_DIR="$wog_c_saved_dir"
            shift; shift
            ;;
          -c | --git-dir | --work-tree | --namespace) shift; shift ;;
          -*) shift ;;
          *) break ;;
        esac
      done
      case "${1:-}" in
        push)
          wog_check_dir "$wog_git_dir" 'git push'
          shift
          for wog_ptok in "$@"; do
            case "$wog_ptok" in
              -*) continue ;;
            esac
            wog_psrc="${wog_ptok%%:*}"
            wog_pdst="${wog_ptok#*:}"
            [ "$wog_pdst" = "$wog_ptok" ] && wog_pdst=''
            for wog_pside in "$wog_psrc" "$wog_pdst"; do
              [ -n "$wog_pside" ] || continue
              wog_pside="${wog_pside#+}"
              case "$wog_pside" in
                refs/heads/*) wog_pside="${wog_pside#refs/heads/}" ;;
                heads/*) wog_pside="${wog_pside#heads/}" ;;
                refs/*) wog_pside="${wog_pside#refs/}" ;;
              esac
              case "$wog_pside" in
                bd/*) wog_check_id "${wog_pside#bd/}" 'git push' no ;;
              esac
            done
          done
          ;;
        commit) wog_check_dir "$wog_git_dir" 'git commit' ;;
        worktree)
          if [ "${2:-}" = 'remove' ]; then
            shift 2
            wog_wt_path=''
            for wog_warg in "$@"; do
              case "$wog_warg" in
                -*) ;;
                *) wog_wt_path="$wog_warg"; break ;;
              esac
            done
            if [ -n "$wog_wt_path" ]; then
              wog_saved_dir="$WOG_DIR"
              WOG_DIR="$wog_git_dir"
              wog_target="$(wog_resolve_dir "$wog_wt_path")"
              WOG_DIR="$wog_saved_dir"
              wog_wt_id="$(bh_ticket_id_for_dir "$wog_target" "$WOG_MAIN")" || wog_wt_id=''
              if [ -z "$wog_wt_id" ]; then
                # パスとして解決できない/worktree の実体と一致しない場合、bare なチケット id や
                # ブランチ名として渡された可能性がある。basename 一致でフォールバックする。
                wog_wt_base="${wog_wt_path##*/}"
                case "$wog_wt_base" in
                  */*|'') ;;
                  *)
                    if [ -d "$WOG_MAIN/.claude/worktrees/$wog_wt_base" ]; then
                      wog_wt_id="$(bh_ticket_id_for_dir "$WOG_MAIN/.claude/worktrees/$wog_wt_base" "$WOG_MAIN")" || wog_wt_id=''
                    fi
                    ;;
                esac
              fi
              [ -n "$wog_wt_id" ] && wog_check_id "$wog_wt_id" 'git worktree remove'
              if [ -n "$wog_wt_id" ]; then
                # 許可された worktree remove は、そのチケットの所有権記録も一緒に消す (bdboard-gsnn round2: 残置記録が次の正当な持ち主を誤って deny するのを防ぐ)。
                rm -f "$(bh_worktree_owner_file "$WOG_MAIN" "$wog_wt_id")" 2>/dev/null || true
              fi
            fi
          fi
          ;;
        branch)
          shift
          wog_branch_delete=''
          wog_branch_force=''
          wog_branch_names=''
          for wog_barg in "$@"; do
            case "$wog_barg" in
              -D) wog_branch_delete='yes'; wog_branch_force='yes' ;;
              -d | --delete) wog_branch_delete='yes' ;;
              -f | --force) wog_branch_force='yes' ;;
              -*) ;;
              *) wog_branch_names="$wog_branch_names $wog_barg" ;;
            esac
          done
          if [ -n "$wog_branch_delete" ] && [ -n "$wog_branch_force" ]; then
            for wog_bname in $wog_branch_names; do
              case "$wog_bname" in
                bd/*)
                  wog_bd_id="${wog_bname#bd/}"
                  # worktree が既に無いチケットの branch -D は所有権チェック対象外 (記録を汚さない。bdboard-gsnn round2)。
                  # ブランチ名文字列だけから見ているので (呼び出し元の実効ディレクトリとは無関係)、
                  # push-refspec 側の対象走査 (F3) と同じ理由でクレームはしない — deny のみ
                  # (bdboard-ob0l 追加分、opus レビューで発見: 未所有の bd/<id> に別 agent から
                  # branch -D すると幽霊クレームが書かれ、本当の持ち主を締め出していた)。
                  if [ -d "$WOG_MAIN/.claude/worktrees/$wog_bd_id" ]; then
                    wog_check_id "$wog_bd_id" 'git branch -D' no
                  fi
                  ;;
              esac
            done
          fi
          ;;
      esac
      ;;
    npm)
      shift
      wog_npm_dir="$WOG_DIR"
      while [ $# -gt 0 ]; do
        case "$1" in
          --prefix) wog_npm_dir="$(wog_resolve_dir "${2:-}")"; shift; shift ;;
          --prefix=*) wog_npm_dir="$(wog_resolve_dir "${1#--prefix=}")"; shift ;;
          -s | --silent | -q | --quiet) shift ;;
          -*) shift ;;
          *) break ;;
        esac
      done
      case "${1:-} ${2:-}" in
        'run merge-pr' | 'run-script merge-pr')
          wog_check_dir "$wog_npm_dir" 'npm run merge-pr'
          # prepare は state ファイルがまだ無いので PR番号ひも付けは効かない (state ファイルが出来る gate/finish/verify 以降でのみ有効)。ネットワーク呼び出しはしない (hook タイムアウト回避のため)。
          for wog_tok in "$@"; do
            case "$wog_tok" in
              ''|*[!0-9]*) ;;
              *)
                wog_pr_ticket="$(wog_ticket_id_for_pr "$wog_tok")"
                [ -n "$wog_pr_ticket" ] && wog_check_id "$wog_pr_ticket" 'npm run merge-pr'
                break
                ;;
            esac
          done
          ;;
      esac
      ;;
    gh)
      shift
      case "${1:-} ${2:-}" in
        'pr merge')
          wog_check_dir "$WOG_DIR" 'gh pr merge'
          for wog_tok in "$@"; do
            case "$wog_tok" in
              ''|*[!0-9]*) ;;
              *)
                wog_pr_ticket="$(wog_ticket_id_for_pr "$wog_tok")"
                [ -n "$wog_pr_ticket" ] && wog_check_id "$wog_pr_ticket" 'gh pr merge'
                break
                ;;
            esac
          done
          ;;
      esac
      ;;
  esac

  if [ -n "$wog_closes_subshell" ] && [ -n "$WOG_SUBSHELL_DIR" ]; then
    WOG_DIR="$WOG_SUBSHELL_DIR"
    WOG_SUBSHELL_DIR=''
  fi
done <<WOG_SEGMENTS_EOF
$WOG_SEGMENTS
WOG_SEGMENTS_EOF
set +f

return 0
