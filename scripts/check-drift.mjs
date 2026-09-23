// bdboard-ky15: オープン中のブランチと origin/main が「同じファイル」を触り始めた
// ことを、マージ直前ではなく作業中に知らせる。
//
// 背景 (bdboard-3tw.152 / PR #86): 17時にオープンした PR が翌朝マージされるまでの間に、
// 無関係な5つの PR が同じ StatusPill.tsx / index.css を触って main へ着地し、最終
// rebase で実テキスト衝突になった。既存の Merge serialization 手順ではこれを防げない:
// - merge-slot と CAS が守るのは「マージ直前の瞬間」に main が動いたかどうかで、
//   PR が生きている数時間〜1日の間に積み上がる衝突ではない。
// - main 側の `npm run verify` はマージ後の意味的非互換を捕まえるが、事前の警告に
//   ならない (壊れてから分かる)。
//
// ここで見るのは「マージベース以降に main が触ったファイル」と「同じくブランチが
// 触ったファイル」の積集合だけ。これは rebase したときに衝突しうるファイルの上界で、
// 実際に衝突するかはハンク次第 (別関数を触っていれば衝突しない)。だから判定ではなく
// 早期警告として扱い、**発見をゲートにしない** (重なりがあっても exit 0) — ゲートに
// すると「衝突しないのに止まる」誤検知でいずれ無視されるようになる。
// 逆に「チェック自体が実行できなかった」ときだけ exit 2 を返す。これを 0 と混ぜると、
// stdout だけ拾う呼び出し側から見て「調べて問題なし」と区別が付かなくなる。
//
// 見るのは **コミット済みの変更だけ**。作業ツリーの未コミット編集は入らない。
//
// 「hot file の一覧を CLAUDE.md に載せる」案 (チケットの候補2) は採らなかった。
// どのファイルが hot かは時期で変わり、手で書いた一覧は必ず腐る。マージベースから
// 計算すれば常に現在の事実になる。
import { pathToFileURL } from 'node:url';

import { main } from './check-drift/cli.mjs';

export { computeDrift, formatDriftReport } from './check-drift/compute.mjs';
export { parseMergeTreeConflictFiles } from './check-drift/git.mjs';

// pathToFileURL を使う。`file://${argv[1]}` だと、リポジトリのパスに空白や非ASCIIが
// 含まれるときに import.meta.url 側だけがパーセントエンコードされて一致せず、
// main() が走らないまま無言で exit 0 になる (fable レビューで再現あり)。
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exitCode = main(process.argv.slice(2));
}
