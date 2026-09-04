import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';

// bdboard-255: worktree並行運用(同時2〜6本のverify)でvitestワーカーがコアを
// 食い尽くし、10コア機でload average 200超に達した対策。vitest 3の既定プールは
// `forks` なので上限は poolOptions.forks.maxForks に設定する(threads側にも同値を
// 置き、将来プールを切り替えてもキャップが黙って消えないようにする)。
// 上限値 max(2, ceil(cores/4)) は「1本あたり2〜3ワーカー」の想定(10コア機で3、
// 4コアCIで2)。実測: キャップ無しは10コア機で9ワーカー/27s、maxForks=3で3ワーカー
// (壁時計の実測値はbdboard-255のnotes参照)。
const maxTestWorkers = Math.max(2, Math.ceil(availableParallelism() / 4));

export default defineConfig({
  test: {
    // scripts/ 側は運用スクリプト (verify 実行スロット等, bdboard-d48) のテスト。
    // test/e2e/*.test.ts は Playwright 補助 (ポート採番等) の vitest 単体テスト (bdboard-2ob0)。
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs', 'test/e2e/**/*.test.ts'],
    // maxWorkers はプール非依存のフォールバック(vitest 3.2.7 実装:
    // `poolOptions.maxForks ?? vitest.config.maxWorkers ?? threadsCount`)。
    // poolOptions.<pool>.* は現在の既定プールにのみ効き、将来既定プールが
    // 変わると黙って無効化される(threads→forks の既定変更で 3tw.106 の
    // キャップが死んでいたのと同じ罠)。両方に設定して安全網とする。
    maxWorkers: maxTestWorkers,
    poolOptions: {
      forks: {
        maxForks: maxTestWorkers,
      },
      threads: {
        maxThreads: maxTestWorkers,
      },
    },
  },
});
