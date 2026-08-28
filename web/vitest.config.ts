import { availableParallelism } from 'node:os';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import rootPackage from '../package.json';

// bdboard-3tw.106: 並列worktreeセッションでCPUが過剰契約されると、jsdom環境の
// 起動(ファイル先頭テストに乗る固定コスト)がスケジューリング飢餓で5000msの
// testTimeoutを超えてflakeする。そのためワーカー数をキャップする。
// bdboard-255: 3tw.106のキャップは poolOptions.threads.* のみに置かれていたが、
// vitest 3の既定プールは `forks` のため実際には効いておらず、実測で9ワーカーが
// forkされていた(10コア機)。実効側の forks.maxForks に設定し直し、threads側にも
// 同値を残す(将来プールを切り替えてもキャップが黙って消えないように)。
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
    // maxWorkers はプール非依存のフォールバック(vitest 3.2.7 実装:
    // `poolOptions.maxForks ?? vitest.config.maxWorkers ?? threadsCount`)。
    // poolOptions.<pool>.* は現在の既定プールにのみ効き、将来既定プールが
    // 変わると黙って無効化される(まさに 3tw.106 が踏んだ罠)。両方に設定して
    // 安全網とする。
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
