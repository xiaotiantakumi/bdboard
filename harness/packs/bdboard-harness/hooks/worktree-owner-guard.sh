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
# 新規の後退ではない)。git branch -D の検出は `-D` 短縮形のみ対応
# (`--delete --force` の長形式は対象外)。

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
  wog_owner="$(bh_read_owner "$WOG_MAIN" "$wog_id")"
  if [ -z "$wog_owner" ]; then
    if bh_claim_owner "$WOG_MAIN" "$wog_id" "$AGENT_ID"; then
      return 0
    fi
    wog_owner="$(bh_read_owner "$WOG_MAIN" "$wog_id")"
    [ -n "$wog_owner" ] || return 0
  fi
  [ "$wog_owner" = "$AGENT_ID" ] && return 0
  wog_audit "9-$wog_label-$wog_id"
  deny \
    "bdboard-harness: worktree bd/$wog_id は別のサブエージェント (${wog_owner:0:24}) の持ち物です。$wog_label はできません。" \
    '自分のチケットの worktree で作業してください。読み取り・テスト実行は止めていません。' \
    "持ち主が動けないなら議長に scripts/worktree-owner.sh release $wog_id を頼んでください。"
}

# 引数: dir, label。dir が登録済みの per-ticket worktree なら wog_check_id へ。
# そうでなければ何もしない (main checkout 自身や無関係なディレクトリは対象外)。
wog_check_dir() {
  wog_cd_id="$(bh_ticket_id_for_dir "$1" "$WOG_MAIN")" || return 0
  [ -n "$wog_cd_id" ] || return 0
  wog_check_id "$wog_cd_id" "$2"
}

WOG_NL=$'\n'
WOG_SEGMENTS="${COMMAND//\$WOG_NL/ }"
WOG_SEGMENTS="${WOG_SEGMENTS//&&/$WOG_NL}"
WOG_SEGMENTS="${WOG_SEGMENTS//\|\|/$WOG_NL}"
WOG_SEGMENTS="${WOG_SEGMENTS//;/$WOG_NL}"
WOG_SEGMENTS="${WOG_SEGMENTS//&/$WOG_NL}"

WOG_DIR="$(bh_canon "$HOOK_CWD")"
WOG_PREV_DIR="$WOG_DIR"
WOG_SUBSHELL_DIR=''
WOG_RELEASE_SCRIPT_BASE='worktree-owner.sh'

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

  wog_clean="$(printf '%s' "$wog_seg" | tr -d "\"'")"
  # shellcheck disable=SC2086
  set -- $wog_clean

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
        '議長は直接 scripts/worktree-owner.sh release <id> を実行して引き継ぎを解除します。'
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
          -C) wog_git_dir="$(wog_resolve_dir "${2:-}")"; shift; shift ;;
          -c | --git-dir | --work-tree | --namespace) shift; shift ;;
          -*) shift ;;
          *) break ;;
        esac
      done
      case "${1:-}" in
        push) wog_check_dir "$wog_git_dir" 'git push' ;;
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
              wog_target="$(wog_resolve_dir "$wog_wt_path")"
              wog_wt_id="$(bh_ticket_id_for_dir "$wog_target" "$WOG_MAIN")" || wog_wt_id=''
              [ -n "$wog_wt_id" ] && wog_check_id "$wog_wt_id" 'git worktree remove'
            fi
          fi
          ;;
        branch)
          shift
          wog_branch_force=''
          wog_branch_names=''
          for wog_barg in "$@"; do
            case "$wog_barg" in
              -D) wog_branch_force='yes' ;;
              -*) ;;
              *) wog_branch_names="$wog_branch_names $wog_barg" ;;
            esac
          done
          if [ -n "$wog_branch_force" ]; then
            for wog_bname in $wog_branch_names; do
              case "$wog_bname" in
                bd/*) wog_check_id "${wog_bname#bd/}" 'git branch -D' ;;
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
        'run merge-pr' | 'run-script merge-pr') wog_check_dir "$wog_npm_dir" 'npm run merge-pr' ;;
      esac
      ;;
    gh)
      shift
      case "${1:-} ${2:-}" in
        'pr merge') wog_check_dir "$WOG_DIR" 'gh pr merge' ;;
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
