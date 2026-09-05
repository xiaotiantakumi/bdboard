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
    // ** を使わないのは fixtures/ 等の下位ディレクトリを構造的に除外するため — 将来そこに
    // *.test.ts が増えると @playwright/test import で test:server が落ちるトラップになる。
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs', 'test/e2e/*.test.ts'],
    // bdboard-npf9: Windows は Linux/macOS よりプロセス生成が大幅に遅く、サブプロセスを
    // 起こすテストが既定の5000msを食い潰す。scripts/check-drift.test.mjs (bdboard-pqhe) と
    // src/infrastructure/process/node-streaming-command-runner.test.ts の別ファイル2件で同じ
    // flake が起き、落ちるたびに第3引数で個別に足す whack-a-mole が破綻したため一律化する。
    // 後者の `terminates the child on timeout and waits for it to exit` は Windows の正常時12 run
    // 連続で1100〜1196msに収まる一方、遅い run では5000msを超えて落ちる二峰性がある。失敗した
    // attempt では5019msで打ち切られ、同じ attempt の runner 全体も check-drift が14047ms
    // (正常時5673〜6368ms)、sqlite-chat-message-repository が18157ms (正常時1374ms) と遅かったが、
    // job は最後まで走りきっておりハングではない。
    // このテストの構造的な最悪ケースは timeoutMs: 1000 + STOP_GRACE_MS = 3000 + プロセス消滅
    // ポーリング20×10ms = 200ms、計約4200ms。既定5000msの余裕は16%しかなく構造的に足りないため、
    // 15000msは約3.5倍の余裕を取る。固定タイマー部分は負荷でスケールしないので十分である。
    // macOS/Linux は本当に遅くなったときに素早く落ちるシグナルを保ちたいので据え置く。既存の
    // gitサブプロセスを起こすテストの個別15000ms指定は、macOS/Linuxを5000msから守るため残す。
    // Windowsでは同じ15000msに一致して冗長になるだけで無害である。
    testTimeout: process.platform === 'win32' ? 15_000 : 5_000,
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
