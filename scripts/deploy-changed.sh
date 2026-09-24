#!/usr/bin/env bash
# scripts/deploy-changed.sh — always-on-server.sh の deploy 再起動判定。
# テスト専用ファイルやディレクトリだけの変更は実行中のサーバーに影響しないため除外する。
# 直接実行時は一時 Git リポジトリ等で判定できる簡易 CLI として動作する。
set -u

# パスのどこかに一致するテスト専用ファイル・ディレクトリのパターン。
# test-support は前後を '/' '.' '-' か文字列端で区切って照合する (レビュー指摘: アンカー無しだと
# "latest-support.ts" のような無関係な本物のファイル名が誤って除外されてしまう)。
DEPLOY_CHANGED_EXCLUDE_PATTERN='(^|/)__fixtures__/|(^|[/.-])test-support([/.-]|$)|\.test\.(ts|mjs|tsx)$'

# always-on-server.sh の deploy がこの pathspec で deploy_relevant_changed を呼ぶ。
# scripts/deploy-changed.test.mjs もこの配列をそのまま読んでテストする (bdboard-kpim: 呼び出し
# 側にリテラルを複製すると、pathspec を変えてもテストが呼び出し側の引数の書き換え忘れに
# 気付けない、というレビュー指摘への対応)。src/main.ts が委譲する
# src/bootstrap/wire-feature-routes.ts の SPA フォールバックが web/dist/index.html を、
# src/infrastructure/chat/help-content.ts と web/src/helpContent.ts (web バンドルへ直接
# import) が docs/help-content.json を、それぞれ起動時 (web/src/helpContent.ts はビルド時) に
# 1 回だけ読むため、いずれも変更があれば再起動が要る。
DEPLOY_RESTART_PATHSPEC=(src/ web/ docs/help-content.json package.json package-lock.json .env)

# deploy_relevant_changed <repo-dir> <old-sha> <new-sha> <pathspec...>
# old と new が同じなら変更なし。除外後にパスが残れば再起動が必要。
# --no-renames: rename detection が有効だと `git diff --name-only` は移動先のパスしか
# 出さないため、非テストファイルをテスト専用ディレクトリへ rename しただけの差分が
# 誤って「変更なし」判定になりうる (レビュー指摘)。旧パス・新パス両方を見る。
deploy_relevant_changed() {
  local repo_dir="$1"
  local old_sha="$2"
  local new_sha="$3"
  shift 3
  [ "$old_sha" != "$new_sha" ] || return 1
  local filtered
  filtered="$(git -C "$repo_dir" diff --no-renames --name-only "$old_sha" "$new_sha" -- "$@" 2>/dev/null \
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
