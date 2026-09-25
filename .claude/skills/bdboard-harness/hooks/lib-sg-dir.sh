# shellcheck shell=bash
# lib-sg-dir.sh — server-guard.sh (規則 7/8) から分離した部品 (bdboard-qj0t): 実効ディレクトリの解決
# (sg_expand/sg_resolve_dir)。単独では実行しない。server-guard.sh から `.` で読み込まれる。

sg_expand() {
  sg_out="$1"
  case "$sg_out" in
    *'$'* | '~' | '~/'*) ;;
    *) printf '%s' "$sg_out"; return 0 ;;
  esac
  while IFS= read -r sg_var_line; do
    [ -n "$sg_var_line" ] || continue
    sg_var_name="${sg_var_line%%=*}"
    sg_var_value="${sg_var_line#*=}"
    sg_out="${sg_out//\$\{$sg_var_name\}/$sg_var_value}"
    sg_out="${sg_out//\$$sg_var_name/$sg_var_value}"
  done <<SG_VARS_EOF
$SG_VARS
SG_VARS_EOF
  case "$sg_out" in
    '~' | '~/'*) sg_out="${HOME}${sg_out#\~}" ;;
  esac
  printf '%s' "$sg_out"
}

sg_resolve_dir() {
  sg_target="$(sg_expand "$1")"
  case "$sg_target" in
    '') printf '%s' "${HOME:-$SG_DIR}" ;;
    -) printf '%s' "$SG_PREV_DIR" ;;
    /*) sg_canon "$sg_target" ;;
    *) sg_canon "$SG_DIR/$sg_target" ;;
  esac
}
