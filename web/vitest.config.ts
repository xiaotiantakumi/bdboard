import { availableParallelism } from 'node:os';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // bdboard-3tw.106: 並列worktreeセッションでCPUが過剰契約されると、jsdom環境の
    // 起動(ファイル先頭テストに乗る固定コスト)がスケジューリング飢餓で5000msの
    // testTimeoutを超えてflakeする。既定はコア数いっぱいまでワーカーを立てるため、
    // 半分にキャップして自環境起因の競合を減らす(単独実行時の壁時計への影響は軽微)。
    poolOptions: {
      threads: {
        maxThreads: Math.max(2, Math.floor(availableParallelism() / 2)),
      },
    },
  },
});
