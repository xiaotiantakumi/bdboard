import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));

// Never the always-on dev port (8787) — see CLAUDE.md "Always-On Local
// Hosting". This server is spun up fresh per test run by global-setup.ts and
// torn down afterwards.
const port = process.env.BDBOARD_E2E_PORT ?? '8799';
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
