#!/usr/bin/env bash
# scripts/deploy-changed.sh — always-on-server.sh の deploy 再起動判定。
# テスト専用ファイルやディレクトリだけの変更は実行中のサーバーに影響しないため除外する。
# 直接実行時は一時 Git リポジトリ等で判定できる簡易 CLI として動作する。
set -u

# パスのどこかに一致するテスト専用ファイル・ディレクトリのパターン。
DEPLOY_CHANGED_EXCLUDE_PATTERN='(test-support|__fixtures__)|\.test\.(ts|mjs|tsx)$'

# deploy_relevant_changed <repo-dir> <old-sha> <new-sha> <pathspec...>
# old と new が同じなら変更なし。除外後にパスが残れば再起動が必要。
deploy_relevant_changed() {
  repo_dir="$1"
  old_sha="$2"
  new_sha="$3"
  shift 3
  [ "$old_sha" != "$new_sha" ] || return 1
  filtered="$(git -C "$repo_dir" diff --name-only "$old_sha" "$new_sha" -- "$@" 2>/dev/null \
    | grep -Ev "$DEPLOY_CHANGED_EXCLUDE_PATTERN")"
  [ -n "$filtered" ]
}

# 直接実行時の簡易 CLI (テスト用)。
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  [ $# -ge 3 ] || { printf 'usage: %s <repo> <old-sha> <new-sha> [-- <pathspec>...]\n' "$0" >&2; exit 2; }
  repo="$1"; old="$2"; new="$3"; shift 3
  [ "${1:-}" != '--' ] || shift
  deploy_relevant_changed "$repo" "$old" "$new" "$@"
  exit $?
fi
