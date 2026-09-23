// bdboard-sso1.53: check-drift.mjs から move-only 分割。積集合の計算とレポート本文 (「衝突しうるファイル」節)。

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
