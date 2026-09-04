import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { resolveE2EPort } from './e2e-port.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// Never the always-on dev port (8787) — see CLAUDE.md "Always-On Local
// Hosting". This server is spun up fresh per test run by global-setup.ts and
// torn down afterwards. Port selection (including 8787 avoidance on auto-alloc)
// lives in resolveE2EPort(); env BDBOARD_E2E_PORT overrides when set (CI uses 8799).
const port = resolveE2EPort();
// global-setup.ts は別モジュールだが同一 Node プロセスで走る。env に書いておかないと
// config の baseURL と実サーバの bind ポートが食い違い、全 spec が接続拒否で落ちる。
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
