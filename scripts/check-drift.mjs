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
// 早期警告として扱い、常に exit 0 で返す — ゲートにすると「衝突しないのに止まる」
// 誤検知でいずれ無視されるようになる。
//
// 「hot file の一覧を CLAUDE.md に載せる」案 (チケットの候補2) は採らなかった。
// どのファイルが hot かは時期で変わり、手で書いた一覧は必ず腐る。マージベースから
// 計算すれば常に現在の事実になる。
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 衝突しうるファイルの積集合。純関数なのでテストはここを見る。
 *
 * どちらも「マージベース以降に触られたパス」の集合。順序は main 側の並び
 * (git の出力順 = パス辞書順) を保つ。
 */
export function computeDrift(mainFiles, branchFiles) {
  const branchSet = new Set(branchFiles);
  const seen = new Set();
  const overlap = [];

  for (const file of mainFiles) {
    if (!branchSet.has(file) || seen.has(file)) {
      continue;
    }
    seen.add(file);
    overlap.push(file);
  }

  return {
    overlap,
    mainFileCount: new Set(mainFiles).size,
    branchFileCount: branchSet.size,
  };
}

/**
 * 人間 (とエージェント) 向けの本文。exit code は持たせない。
 *
 * upstream が動いていない / ブランチが何も触っていないケースを先に畳むのは、
 * 「重なり0件」を毎回同じ文で出すと、本当に0件なのか比較する材料が無いのかが
 * 区別できなくなるため。
 */
export function formatDriftReport(drift, ctx) {
  const { mergeBase, upstream, aheadCount } = ctx;
  const head = `drift: merge-base ${mergeBase.slice(0, 7)} 以降、${upstream} は ${aheadCount} コミット進んでいます。`;

  if (aheadCount === 0) {
    return `${head}\ndrift: 重なりようがありません (rebase 不要)。`;
  }
  if (drift.branchFileCount === 0) {
    return `${head}\ndrift: このブランチはまだファイルを変更していません。`;
  }

  if (drift.overlap.length === 0) {
    return (
      `${head}\n` +
      `drift: 重なるファイルはありません` +
      ` (${upstream} 側 ${drift.mainFileCount} ファイル / ブランチ側 ${drift.branchFileCount} ファイル)。`
    );
  }

  const list = drift.overlap.map((file) => `  ${file}`).join('\n');
  return (
    `${head}\n` +
    `drift: ${upstream} とこのブランチが両方触ったファイルが ${drift.overlap.length} 件あります:\n` +
    `${list}\n` +
    `drift: 今のうちに rebase してください — 衝突が出るならこの中です。\n` +
    `drift:   git fetch origin && git rebase ${upstream}\n` +
    `drift: (ハンクが離れていれば衝突しません。これは上界であって判定ではありません。)`
  );
}

function git(args) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function changedFiles(from, to) {
  const out = git(['diff', '--name-only', `${from}..${to}`]);
  return out === '' ? [] : out.split('\n');
}

function main(argv) {
  const upstream = 'origin/main';
  const shouldFetch = !argv.includes('--no-fetch');

  if (shouldFetch) {
    // 古い origin/main と比べた drift は意味が無い (それが検知したいものそのもの)。
    // ネットワークが無い環境向けに --no-fetch を残す。
    try {
      git(['fetch', 'origin', 'main', '--quiet']);
    } catch (error) {
      console.error(`drift: git fetch に失敗しました。手元の ${upstream} で続けます (${error.message.trim()})`);
    }
  }

  let mergeBase;
  try {
    mergeBase = git(['merge-base', upstream, 'HEAD']);
  } catch {
    console.error(
      `drift: ${upstream} と HEAD の merge-base が取れませんでした。` +
        ' origin remote があり、origin/main を fetch 済みかを確認してください。',
    );
    return 0;
  }

  if (mergeBase === git(['rev-parse', 'HEAD'])) {
    console.log('drift: HEAD が merge-base そのものです (このブランチにはまだコミットがありません)。');
    return 0;
  }

  const aheadCount = Number.parseInt(git(['rev-list', '--count', `${mergeBase}..${upstream}`]), 10);
  const drift = computeDrift(changedFiles(mergeBase, upstream), changedFiles(mergeBase, 'HEAD'));

  console.log(formatDriftReport(drift, { mergeBase, upstream, aheadCount }));
  return 0;
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  process.exitCode = main(process.argv.slice(2));
}
