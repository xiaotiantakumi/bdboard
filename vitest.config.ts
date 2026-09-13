import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';

// mockReset / restoreMocks は意図的に設定しない (bdboard-cqur)。mockReset を有効にすると (restoreMocks
// と併用しても同じ) 各テストの直前 (beforeAll の後) に reset が走り、モジュールトップの
// vi.fn().mockReturnValue(...) や beforeAll で仕込んだ実装まで全ファイルで消える。代わりに
// restoreAllMocks の直前の resetAllMocks をリポジトリルートの src/vitest-mock-cleanup-pairing.test.ts が検査する。

// bdboard-255: worktree並行運用(同時2〜6本のverify)でvitestワーカーがコアを
// 食い尽くし、10コア機でload average 200超に達した対策。Vitest 4 ではプールごとの
// maxForks / maxThreads と poolOptions が廃止され、maxWorkers がプール非依存で唯一の
// ワーカー上限になった。これにより、プール変更でキャップが黙って効かなくなる罠を防ぐ。
// 上限値 max(2, ceil(cores/4)) は「1本あたり2〜3ワーカー」の想定(10コア機で3、
// 4コアCIで2)。実測: キャップ無しは10コア機で9ワーカー/27s、3ワーカー上限で3ワーカー
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
    // scripts/check-drift.test.mjs の CLI テストだけは個別指定をやめ、describe 単位で
    // Windows 60s / 他 15s にしている (bdboard-ypjz)。
    testTimeout: process.platform === 'win32' ? 15_000 : 5_000,
    // Vitest 4 の maxWorkers はプール非依存で唯一のワーカー上限。bdboard-255 / 3tw.106
    // で起きた、実行プールの変更によりキャップが黙って効かなくなる事故を防ぐ。
    maxWorkers: maxTestWorkers,
  },
});
