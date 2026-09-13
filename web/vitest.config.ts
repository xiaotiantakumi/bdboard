import { availableParallelism } from 'node:os';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import rootPackage from '../package.json';

// mockReset / restoreMocks は意図的に設定しない (bdboard-cqur)。mockReset を有効にすると (restoreMocks
// と併用しても同じ) 各テストの直前 (beforeAll の後) に reset が走り、モジュールトップの
// vi.fn().mockReturnValue(...) や beforeAll で仕込んだ実装まで全ファイルで消える。代わりに
// restoreAllMocks の直前の resetAllMocks をリポジトリルートの src/vitest-mock-cleanup-pairing.test.ts が検査する。

// bdboard-3tw.106: 並列worktreeセッションでCPUが過剰契約されると、jsdom環境の
// 起動(ファイル先頭テストに乗る固定コスト)がスケジューリング飢餓で5000msの
// testTimeoutを超えてflakeする。そのためワーカー数をキャップする。
// bdboard-255: 3tw.106のキャップは Vitest 3 のプール固有設定だけに置かれ、既定プール
// と一致せず実測で9ワーカーが fork されていた(10コア機)。Vitest 4 では poolOptions と
// maxForks / maxThreads が廃止され、maxWorkers がプール非依存で唯一の上限になったため、
// プール変更でキャップが黙って効かなくなる罠を防げる。
// 上限値 max(2, ceil(cores/4)) はserver側 vitest.config.ts と同一の根拠
// (worktree並行運用で同時2〜6本のverifyを想定し、1本あたり2〜3ワーカー)。
const maxTestWorkers = Math.max(2, Math.ceil(availableParallelism() / 4));

export default defineConfig({
  plugins: [react()],
  define: {
    __BDBOARD_VERSION__: JSON.stringify(rootPackage.version),
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Vitest 4 の maxWorkers はプール非依存で唯一のワーカー上限。3tw.106 で起きた
    // プール変更によりキャップが黙って効かなくなる事故を防ぐ。
    maxWorkers: maxTestWorkers,
  },
});
