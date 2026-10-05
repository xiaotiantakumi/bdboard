import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeGhAndBd, createTempMaintainerRoot } from './external-issues-wiring-test-support.js';
import { wireIssueReports } from './wire-issue-reports.js';

/** bdboard-4y8q.9.4: wireIssueReports が届いた issue の読み取り口と refresh を同じルーターに載せる。 */

const LOCAL_ENV = { incoming: { socket: { remoteAddress: '127.0.0.1', localPort: 8787 } } };
const CF_HEADERS = { 'cf-ray': 'abc123-NRT', 'cf-connecting-ip': '203.0.113.9' } as const;
const LIST_PATH = '/api/issue-reports/external';
const REFRESH_PATH = '/api/issue-reports/external/refresh';

describe('wireIssueReports: incoming issues', () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function wire(options: { maintainer: boolean }) {
    const temp = await createTempMaintainerRoot();
    if (!options.maintainer) await fs.rm(path.join(temp.root, '.beads'), { recursive: true });
    const fake = createFakeGhAndBd();
    const { issueReportsRouter, externalIssues } = wireIssueReports({
      repoRoot: temp.root,
      env: {},
      commandRunner: fake.runner,
      writeAccess: {},
      packRegistry: { listPacks: vi.fn(() => Promise.resolve([])) },
      log: vi.fn(),
    });
    // 実際の setTimeout の 60 秒のタイマーが残らないように止める。
    cleanups.push(() => externalIssues.stop(), temp.remove);
    const get = (headers: Record<string, string> = {}) => issueReportsRouter.request(LIST_PATH, { headers }, LOCAL_ENV);
    const refresh = (headers: Record<string, string> = {}) =>
      issueReportsRouter.request(
        REFRESH_PATH,
        { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost:8787', ...headers }, body: '{}' },
        LOCAL_ENV,
      );
    return { fake, externalIssues, get, refresh };
  }

  it('is not enabled outside the maintainer environment: GET says so, POST is 404, and gh and bd are never run', async () => {
    const { fake, externalIssues, get, refresh } = await wire({ maintainer: false });

    expect(externalIssues.enabled).toBe(false);
    expect(await (await get()).json()).toMatchObject({ enabled: false, issues: [] });
    expect((await refresh()).status).toBe(404);
    expect(fake.run).not.toHaveBeenCalled();
  });

  it('is not enabled when the wiring has no command runner', async () => {
    const temp = await createTempMaintainerRoot();
    cleanups.push(temp.remove);
    const { issueReportsRouter, externalIssues } = wireIssueReports({
      repoRoot: temp.root,
      env: {},
      writeAccess: {},
      packRegistry: { listPacks: vi.fn(() => Promise.resolve([])) },
      log: vi.fn(),
    });
    expect(externalIssues.enabled).toBe(false);
    expect(await (await issueReportsRouter.request(LIST_PATH, {}, LOCAL_ENV)).json()).toMatchObject({ enabled: false });
  });

  it('answers GET with the idle empty list before the first check, and never runs gh for a read', async () => {
    const { fake, get } = await wire({ maintainer: true });

    for (let read = 0; read < 20; read += 1) {
      const res = await get();
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ enabled: true, state: 'idle', fetchedAt: null, issues: [] });
    }
    expect(fake.run).not.toHaveBeenCalled();
  });

  it('refreshes from the local machine, then shows the issue to a reader coming through the tunnel', async () => {
    const { fake, get, refresh } = await wire({ maintainer: true });

    const refreshed = await refresh();
    expect(refreshed.status).toBe(200);
    expect(fake.ghCalls()).toHaveLength(1);

    const viaTunnel = await get(CF_HEADERS);
    expect(viaTunnel.status).toBe(200);
    expect(await viaTunnel.json()).toMatchObject({
      enabled: true,
      state: 'ok',
      issues: [{ number: 1, title: 'issue 1', url: 'https://github.com/xiaotiantakumi/bdboard/issues/1', needsRejudge: false }],
    });
    expect(fake.ghCalls()).toHaveLength(1);
  });

  it('keeps the refresh behind the local-only guard (a tunnel request gets 403 and starts nothing) and limits it to once a minute', async () => {
    const { fake, refresh } = await wire({ maintainer: true });

    const viaTunnel = await refresh(CF_HEADERS);
    expect(viaTunnel.status).toBe(403);
    expect(fake.run).not.toHaveBeenCalled();

    expect((await refresh()).status).toBe(200);
    const second = await refresh();
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(fake.ghCalls()).toHaveLength(1);
  });

  it('keeps the routes next to the existing issue-report routes (pending-count still answers)', async () => {
    const temp = await createTempMaintainerRoot();
    cleanups.push(temp.remove);
    const { issueReportsRouter } = wireIssueReports({
      repoRoot: temp.root,
      env: {},
      writeAccess: {},
      packRegistry: { listPacks: vi.fn(() => Promise.resolve([])) },
      log: vi.fn(),
    });
    const res = await issueReportsRouter.request('/api/issue-reports/pending-count', {}, LOCAL_ENV);
    expect(res.status).toBe(200);
  });
});
