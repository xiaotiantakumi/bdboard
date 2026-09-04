import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { resolveE2EPort } from './e2e-port.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// Never the always-on dev port (8787) — see CLAUDE.md "Always-On Local
// Hosting". This server is spun up fresh per test run by global-setup.ts and
// torn down afterwards. Port selection lives in resolveE2EPort(); env
// BDBOARD_E2E_PORT overrides when set.
const port = resolveE2EPort();
// Playwright はこの config を main / ローダー / 各ワーカープロセスで再 import して再評価する。
// ワーカーは fork 時点の親 env を継承するので、ここで process.env へ書くことだけが
// main / globalSetup / 全ワーカーを同一ポートに収束させる唯一の手段。別プロセスなので
// モジュールレベルのメモ化では代替できない。この書き戻しが無いとワーカーは独自採番し
// baseURL と global-setup が spawn したサーバの bind ポートが食い違い、全 spec が接続拒否になる。
process.env.BDBOARD_E2E_PORT = port;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: here,
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['line']] : [['list']],
  timeout: 30_000,
  expect: { timeout: 5_000 },
  globalSetup: path.join(here, 'global-setup.ts'),
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
