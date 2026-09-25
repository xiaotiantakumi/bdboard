#!/usr/bin/env bash
#
# worktree-owner.sh — bdboard-gsnn: per-ticket worktree の持ち主レコードを見る/解除する。
#
# release は議長専用 (サブエージェントからの実行は hooks/worktree-owner-guard.sh が
# deny する)。show / list は読み取り専用で誰でも実行できる。
#
# 使い方:
#   worktree-owner.sh show <ticket-id> [--main <path>]
#   worktree-owner.sh list [--main <path>]
#   worktree-owner.sh release <ticket-id> [--main <path>]
#
# --main は省略時 $PWD の属する main checkout を lib-main-checkout.sh
# (bh_main_checkout) で解決する。worktree の中から呼んでも、その worktree が属する
# main checkout に正しく解決する。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB="$SCRIPT_DIR/../hooks/lib-main-checkout.sh"
if [ ! -r "$LIB" ]; then
  echo "worktree-owner.sh: lib-main-checkout.sh が見つかりません ($LIB)" >&2
  exit 1
fi
# shellcheck source=../hooks/lib-main-checkout.sh
. "$LIB"

usage() {
  cat >&2 <<'USAGE'
使い方:
  worktree-owner.sh show <ticket-id> [--main <path>]
  worktree-owner.sh list [--main <path>]
  worktree-owner.sh release <ticket-id> [--main <path>]
USAGE
}

CMD="${1:-}"
[ -n "$CMD" ] || { usage; exit 2; }
shift || true

TICKET_ID=''
MAIN_OVERRIDE=''
while [ $# -gt 0 ]; do
  case "$1" in
    --main)
      MAIN_OVERRIDE="${2:-}"
      shift 2 || { usage; exit 2; }
      ;;
    -*)
      echo "worktree-owner.sh: 不明なオプション $1" >&2
      usage
      exit 2
      ;;
    *)
      if [ -z "$TICKET_ID" ]; then
        TICKET_ID="$1"
      fi
      shift
      ;;
  esac
done

if [ -n "$MAIN_OVERRIDE" ]; then
  MAIN="$(bh_canon "$MAIN_OVERRIDE")"
else
  MAIN="$(bh_main_checkout "$PWD")"
fi
if [ -z "$MAIN" ]; then
  echo "worktree-owner.sh: main checkout を解決できません (git リポジトリの外?)" >&2
  exit 1
fi

case "$CMD" in
  show)
    [ -n "$TICKET_ID" ] || { usage; exit 2; }
    OWNER="$(bh_read_owner "$MAIN" "$TICKET_ID")"
    if [ -n "$OWNER" ]; then
      printf '%s: %s\n' "$TICKET_ID" "$OWNER"
    else
      printf '%s: (none)\n' "$TICKET_ID"
    fi
    ;;
  list)
    OWNER_DIR="$(bh_worktree_owner_dir "$MAIN")"
    if [ -d "$OWNER_DIR" ]; then
      for entry in "$OWNER_DIR"/*; do
        [ -e "$entry" ] || continue
        printf '%s: %s\n' "$(basename "$entry")" "$(cat "$entry" 2>/dev/null | tr -d '\n\r')"
      done
    fi
    ;;
  release)
    [ -n "$TICKET_ID" ] || { usage; exit 2; }
    OWNER_FILE="$(bh_worktree_owner_file "$MAIN" "$TICKET_ID")"
    if [ -f "$OWNER_FILE" ]; then
      rm -f "$OWNER_FILE"
      printf '%s: released\n' "$TICKET_ID"
    else
      printf '%s: (already unowned)\n' "$TICKET_ID"
    fi
    ;;
  *)
    usage
    exit 2
    ;;
esac
