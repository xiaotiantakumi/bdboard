# shellcheck shell=bash
# lib-main-checkout.sh — 「このディレクトリ (の属する checkout) が main checkout
# (per-ticket worktree の親) か」を判定する共有ヘルパー (bdboard-kxqb)。
#
# hooks/server-guard.sh (PreToolUse(Bash) 規則 7/8) と hooks/pre-edit-guard.sh
# (PreToolUse(Edit|Write|MultiEdit|NotebookEdit) 規則 2) の両方から `.` で読み込む。
# main checkout 判定ロジックを二重実装しないための一本化 (bdboard-kxqb)。単独では
# 実行しない。
#
# 呼び出し元のローカル変数と衝突しないよう、関数名・内部作業変数とも bh_
# (bdboard-harness) 接頭辞に統一する。
#
#   bh_canon <dir>
#     絶対パスを realpath 相当へ正規化する (cd && pwd -P)。cd に失敗したら
#     (存在しないディレクトリ等) 入力をそのまま返す。
#
#   bh_main_checkout <dir>
#     <dir> が属する worktree ファミリーの「main checkout」の絶対パスを返す
#     (git common dir の親。worktree からでも同じ main checkout に解決する)。
#     <dir> が git リポジトリでない・解決できない場合は空文字を返す (呼び出し元は
#     fail-open すること)。
#
#   bh_dir_is_main <dir> <main>
#     <dir> の属する checkout の toplevel が <main> (bh_main_checkout の戻り値) と
#     一致するか。worktree は main の下 (.claude/worktrees/) に置かれるが、その
#     toplevel は worktree 自身になるため前方一致では判定できず、git に toplevel を
#     答えさせて比較する。存在しない dir・git 対象外はすべて偽 (fail-open)。

bh_canon() {
  (cd "$1" 2>/dev/null && pwd -P) || printf '%s' "$1"
}

bh_main_checkout() {
  bh_mc_common="$(git -C "$1" rev-parse --git-common-dir 2>/dev/null)"
  [ -n "$bh_mc_common" ] || return 0
  case "$bh_mc_common" in
    /*) ;;
    *) bh_mc_common="$1/$bh_mc_common" ;;
  esac
  (cd "$bh_mc_common/.." 2>/dev/null && pwd -P)
}

bh_dir_is_main() {
  bh_dim_top="$(git -C "$1" rev-parse --show-toplevel 2>/dev/null)" || return 1
  [ -n "$bh_dim_top" ] || return 1
  [ "$(bh_canon "$bh_dim_top")" = "$2" ]
}

bh_worktree_owner_dir() {
  printf '%s/.git/bdboard-worktree-owners' "$1"
}

bh_worktree_owner_file() {
  printf '%s/%s' "$(bh_worktree_owner_dir "$1")" "$2"
}

bh_ticket_id_for_dir() {
  bh_tifd_top="$(git -C "$1" rev-parse --show-toplevel 2>/dev/null)" || return 1
  [ -n "$bh_tifd_top" ] || return 1
  bh_tifd_top="$(bh_canon "$bh_tifd_top")"
  [ "$bh_tifd_top" != "$2" ] || return 1
  case "$bh_tifd_top" in
    "$2"/.claude/worktrees/*) ;;
    *) return 1 ;;
  esac
  [ "$(bh_main_checkout "$bh_tifd_top")" = "$2" ] || return 1
  printf '%s' "${bh_tifd_top#"$2"/.claude/worktrees/}"
}

bh_read_owner() {
  bh_ro_file="$(bh_worktree_owner_file "$1" "$2")"
  [ -f "$bh_ro_file" ] || return 0
  cat "$bh_ro_file" 2>/dev/null | tr -d '\n\r'
}

bh_claim_owner() {
  bh_co_dir="$(bh_worktree_owner_dir "$1")"
  mkdir -p "$bh_co_dir" 2>/dev/null || return 1
  bh_co_file="$bh_co_dir/$2"
  bh_co_agent="$3"
  ( set -C; printf '%s\n' "$bh_co_agent" >"$bh_co_file" ) 2>/dev/null
}
