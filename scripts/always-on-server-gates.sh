#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2154
# scripts/always-on-server-gates.sh — always-on-server.sh の「停止前ゲート」2 つ (node 版・build 成果物)。
# always-on-server.sh が deploy-changed.sh と同じ位置 (pull の前) で source する (bdboard-oga4:
# always-on-server.sh の 500 行上限を守るための純粋な切り出し。挙動は変えていない)。
# 単体では実行しない。呼び出し側が SCRIPT_DIR / MAIN / OLD_HEAD / NEW_HEAD / CURRENT_PIDS /
# BUILD_STAMP を持ち、audit / die を定義済みであることを前提にする (SC2154 はそのため)。

# --- node 版ゲート (bdboard-qoxg)。npm install / build:web / 旧 listener の停止 / 起動の前に、
# PATH 上の node が main checkout の package.json の engines.node を満たすか確かめる。
# 2026-09-26 に nvm 既定の v14.15.0 で deploy が走り、build:web は `||=` の SyntaxError を
# 出しながら exit 0 を返し、スクリプトは旧 listener を止めてから起動に失敗した (約 10 分停止)。
# build の終了コードは当てにならないので、版は止める前に直接見る。node の切り替えはしない
# (使うべき node を表示するだけ)。チェッカーは $SCRIPT_DIR 側 (古い node でもパースできる
# 書き方)、読む package.json は $MAIN 側。チェッカー自体が走らないときも fail-closed (サーバーは無傷)。
#
# 1 回目は pull の前 (ロック取得直後) に見る。一番よくある原因 (シェル既定の node が古いだけ) は
# ここで main checkout に触れずに止まり、node を直して同じコマンドを再実行すれば最初からやり直せる。
# pull の後は、pull が package.json を変えたとき (engines.node が上がりうる) だけもう一度見る。
# pull の後に止まると、deploy の再実行は OLD_HEAD == NEW_HEAD で「変更なし」になって何もしないので、
# 入れ直しの手順を別に出す (PR #825 のレビュー)。チェックは $MAIN を cwd にして走らせる
# (asdf / mise など cwd で node を選ぶ shim でも、npm run start と同じ node を見るため)。
node_version_gate() {
  checker="$SCRIPT_DIR/node-version-check.mjs"
  untouched='サーバーは触っていません (旧プロセスのまま)。'
  if [ "$1" = 'after-pull' ]; then
    retry=(
      "pull は完了しています ($(git -C "$MAIN" rev-parse --short "$OLD_HEAD")..$(git -C "$MAIN" rev-parse --short "$NEW_HEAD"))。deploy を同じコマンドで再実行しても、変更なしと判定されて何もしません。"
      "node を直したら main checkout で npm install と npm --prefix web install をしてから、restart --expect-pid ${CURRENT_PIDS:-<PID>} --build で入れ直してください (サーバーが止まっていれば start --build)。"
    )
  else
    retry=('node を直して同じコマンドを再実行してください (pull はまだしていません)。')
  fi
  if [ ! -f "$checker" ]; then
    audit "$CURRENT_PIDS" '' 'node-version-check-failed'
    die 2 "node-version-check.mjs が見つかりません: $checker" "${retry[@]}" "$untouched"
  fi
  if ! (cd "$MAIN" && command -v node >/dev/null 2>&1); then
    audit "$CURRENT_PIDS" '' 'node-version-check-failed'
    die 2 'node が PATH にありません。engines.node を満たす node の bin を PATH の先頭に置いてください。' \
      "${retry[@]}" "$untouched"
  fi
  node_out="$(cd "$MAIN" && node "$checker" "$MAIN" 2>&1)"
  node_rc=$?
  [ "$node_rc" -ne 0 ] || return 0
  if [ "$node_rc" -eq 3 ]; then
    audit "$CURRENT_PIDS" '' 'node-version'
    [ -z "$node_out" ] || printf '%s\n' "$node_out" >&2
    die 2 "${retry[@]}" "$untouched"
  fi
  audit "$CURRENT_PIDS" '' 'node-version-check-failed'
  [ -z "$node_out" ] || printf '%s\n' "$node_out" | tail -n 5 >&2
  die 2 \
    "node の版チェックを実行できませんでした (node $(cd "$MAIN" && node --version 2>&1), $(cd "$MAIN" && command -v node), exit $node_rc)。node が古すぎるか、チェッカーが壊れています (上の出力を参照)。" \
    "PATH の先頭に $MAIN/package.json の engines.node を満たす node の bin を置いてください (nvm があれば .nvmrc の系列)。" \
    "${retry[@]}" "$untouched"
}

# --- build 成果物ゲート (bdboard-5st4)。build:web の終了コードも build-meta.json の sha も当てにならない
# (2026-09-26: 古い node で vite が構文エラーを握りつぶして exit 0、build-meta.json だけ HEAD の sha になり
# index.html は古いまま)。build の直前に作った stamp (ロックディレクトリ内) より後に web/dist/index.html が
# 更新されたかを見る。mtime の比較は stat ではなく node (build-artifact-check.mjs。BSD/GNU の stat 書式差を
# 避ける。node の版は上のゲートで確認済み)。止まったときは pull や install が済んでいることがあり、deploy の
# 再実行は「変更なし」で何もしないので、入れ直しは restart --build を案内する。チェッカーが走らないときも fail-closed。
build_artifact_gate() {
  artifact_out="$(cd "$MAIN" && node "$SCRIPT_DIR/build-artifact-check.mjs" "$MAIN/web/dist/index.html" "$BUILD_STAMP" 2>&1)"
  artifact_rc=$?
  [ "$artifact_rc" -ne 0 ] || return 0
  if [ "$artifact_rc" -eq 3 ]; then
    audit "$CURRENT_PIDS" '' 'build-artifact-stale'
    artifact_msg='npm run build:web は成功を返しましたが、web/dist/index.html が今回の build で作られていません。'
  else
    audit "$CURRENT_PIDS" '' 'build-artifact-check-failed'
    artifact_msg="build 成果物のチェックを実行できませんでした (exit $artifact_rc)。"
  fi
  [ -z "$artifact_out" ] || printf '%s\n' "$artifact_out" | tail -n 5 >&2
  die 2 "$artifact_msg" \
    "pull や install は済んでいることがあります。原因を直したら deploy の再実行ではなく restart --expect-pid ${CURRENT_PIDS:-<PID>} --build で入れ直してください (サーバーが止まっていれば start --build)。" \
    'サーバーは触っていません (旧プロセスのまま)。'
}
