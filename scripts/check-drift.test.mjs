import { describe, expect, it } from 'vitest';
import { computeDrift, formatDriftReport } from './check-drift.mjs';

const CTX = {
  mergeBase: '0123456789abcdef',
  upstream: 'origin/main',
  aheadCount: 5,
};

describe('computeDrift', () => {
  it('returns only the files both sides touched', () => {
    const drift = computeDrift(
      ['web/src/components/StatusPill.tsx', 'web/src/index.css', 'src/main.ts'],
      ['web/src/index.css', 'web/src/components/StatusPill.tsx', 'docs/PLAN.md'],
    );

    expect(drift.overlap).toEqual([
      'web/src/components/StatusPill.tsx',
      'web/src/index.css',
    ]);
    expect(drift.mainFileCount).toBe(3);
    expect(drift.branchFileCount).toBe(3);
  });

  it('keeps the upstream ordering rather than the branch ordering', () => {
    // 出力は git の並び (パス辞書順) で読まれる前提。ブランチ側の順に引きずられると
    // 実行ごとに並びが変わって差分が読みにくくなる。
    const drift = computeDrift(['a.ts', 'b.ts'], ['b.ts', 'a.ts']);
    expect(drift.overlap).toEqual(['a.ts', 'b.ts']);
  });

  it('is empty when the two sides touch disjoint files', () => {
    const drift = computeDrift(['src/a.ts'], ['src/b.ts']);
    expect(drift.overlap).toEqual([]);
    expect(drift.mainFileCount).toBe(1);
    expect(drift.branchFileCount).toBe(1);
  });

  it('does not report the same file twice', () => {
    // git diff --name-only は重複を出さないが、集合演算をリストの filter で書くと
    // 入力が重複した瞬間に件数が水増しされる。件数はレポートの見出しに出るので、
    // ここが狂うと「2件」と言いながら1ファイルしか並ばない表示になる。
    const drift = computeDrift(['src/a.ts', 'src/a.ts'], ['src/a.ts']);
    expect(drift.overlap).toEqual(['src/a.ts']);
    expect(drift.mainFileCount).toBe(1);
  });

  it('handles either side being empty', () => {
    expect(computeDrift([], ['src/a.ts']).overlap).toEqual([]);
    expect(computeDrift(['src/a.ts'], []).overlap).toEqual([]);
    expect(computeDrift([], []).branchFileCount).toBe(0);
  });
});

describe('formatDriftReport', () => {
  it('names every overlapping file and the rebase command', () => {
    const report = formatDriftReport(
      computeDrift(['web/src/index.css'], ['web/src/index.css']),
      CTX,
    );

    expect(report).toContain('origin/main は 5 コミット進んでいます');
    expect(report).toContain('1 件あります');
    expect(report).toContain('  web/src/index.css');
    expect(report).toContain('git rebase origin/main');
  });

  it('says so explicitly when nothing overlaps', () => {
    const report = formatDriftReport(computeDrift(['a.ts'], ['b.ts']), CTX);

    expect(report).toContain('重なるファイルはありません');
    // 件数を添えるのは「0件」と「比較材料が無い」を読み手が区別できるようにするため。
    expect(report).toContain('origin/main 側 1 ファイル / ブランチ側 1 ファイル');
    expect(report).not.toContain('git rebase');
  });

  it('distinguishes an unmoved upstream from a genuine zero overlap', () => {
    const report = formatDriftReport(computeDrift([], ['a.ts']), {
      ...CTX,
      aheadCount: 0,
    });

    expect(report).toContain('重なりようがありません');
    expect(report).not.toContain('重なるファイルはありません');
  });

  it('distinguishes an untouched branch from a genuine zero overlap', () => {
    const report = formatDriftReport(computeDrift(['a.ts'], []), CTX);

    expect(report).toContain('まだファイルを変更していません');
    expect(report).not.toContain('重なるファイルはありません');
  });

  it('never tells the caller it is a verdict', () => {
    // 「衝突する」と断言すると、ハンクが離れていて実際は衝突しないケースで
    // 信用を失う。常に exit 0 で返すのと同じ理由。
    const report = formatDriftReport(computeDrift(['a.ts'], ['a.ts']), CTX);
    expect(report).toContain('上界であって判定ではありません');
  });
});
