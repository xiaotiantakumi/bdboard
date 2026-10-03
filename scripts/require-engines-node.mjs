// bdboard-5st4: web の build (npm run build:web) が、古い node で「成功」しないようにする。
//
// 背景 (調査結果): vite の bin (vite/bin/vite.js) は `start()` の末尾で `return import('../dist/node/cli.js')`
// を await も catch もせずに返す。node 15 未満は unhandled rejection を警告にするだけでプロセスを落とさない
// ので、古い node では cli.js が `||=` などの構文を読めず SyntaxError で reject しても、vite build は
// 何もせず exit 0 になる。`&& node ../scripts/write-build-meta.mjs` は続けて走り、build:web 全体が成功に
// 見えた (2026-09-26, bdboard-qoxg)。vite 側は直せないので、build の先頭でこのスクリプトを通し、
// package.json の engines.node を満たさない node では tsc も vite も起動する前に非 0 で止める。
// (always-on-server.sh は同じ事故を build の後の成果物検査でも止める: scripts/build-artifact-check.mjs)
//
// 使い方: node scripts/require-engines-node.mjs [repoRoot]   (repoRoot の既定はこのファイルの親)
//   exit 0 = 満たす (engines.node が読めない・">=X.Y.Z" 以外で解釈できないときも fail-open)
//   exit 1 = 満たさない (stderr に要求版・現在版・案内)
//
// 制約: 古い Node でもパース・実行できなければ意味がない (node-version-guard.mjs と同じ。目安の下限は
// v14.13.1)。`||=` / `??=` / `?.` / `??` / import attributes / トップレベル await を使わない。
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readEnginesNodeRange, readNvmrc, satisfiesMinimum } from './node-version-guard.mjs';

const LINE_PREFIX = 'build:web: ';

export function formatNodeShortfall({ current, required, nvmrc }) {
  const currentLabel = `v${String(current).replace(/^v/, '')}`;
  const hint =
    nvmrc === undefined
      ? `PATH の先頭に Node.js ${required} を満たす node の bin を置いてから再実行してください。`
      : `.nvmrc (= ${nvmrc}) は自動では適用されません。その系列で ${required} を満たす node の bin を PATH の先頭に置いてから再実行してください。`;
  return [
    `Node.js ${required} が必要ですが、実行中の Node.js は ${currentLabel} です (package.json の engines.node)。`,
    'engines.node を満たさない node では tsc / vite を起動せずに止めます (Node 15 未満では vite が構文エラーを握りつぶして exit 0 を返し、何も build されないまま成功に見える)。',
    hint,
  ].map((line) => `${LINE_PREFIX}${line}`);
}

export function main(argv, nodeVersion) {
  const repoRoot = argv[0] === undefined ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') : path.resolve(argv[0]);
  const required = readEnginesNodeRange(repoRoot);
  const current = nodeVersion === undefined ? process.versions.node : nodeVersion;
  if (satisfiesMinimum(current, required)) {
    return { code: 0, lines: [] };
  }
  return { code: 1, lines: formatNodeShortfall({ current, required, nvmrc: readNvmrc(repoRoot) }) };
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const result = main(process.argv.slice(2));
  if (result.lines.length > 0) {
    process.stderr.write(`${result.lines.join('\n')}\n`);
  }
  process.exitCode = result.code;
}
