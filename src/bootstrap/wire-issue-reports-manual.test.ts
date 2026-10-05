import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IssueDraft } from '../domain/issue-draft.js';
import { createFsIssueDraftStorage } from '../infrastructure/fs/fs-issue-draft-storage.js';
import { wireIssueReports } from './wire-issue-reports.js';

/** bdboard-4y8q.6.7: wireIssueReports が手書きの受け取り口を載せ、envInfo (bdboard・OS・Node の版) をサーバーが埋める。 */

const LOCAL_ENV = { incoming: { socket: { remoteAddress: '127.0.0.1', localPort: 8787 } } };
const TUNNEL_ENV = LOCAL_ENV;

describe('wireIssueReports manual drafts', () => {
  let root = '';
  afterEach(async () => {
    if (root !== '') await fs.rm(root, { recursive: true, force: true });
  });

  async function wire() {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bdboard-manual-wire-'));
    const draftsDir = path.join(root, 'drafts');
    const { issueReportsRouter } = wireIssueReports({
      repoRoot: root,
      env: { BDBOARD_ISSUE_DRAFTS_DIR: draftsDir },
      writeAccess: {},
      packRegistry: { listPacks: vi.fn(() => Promise.resolve([])) },
      applicationVersion: { getVersion: () => '9.8.7' },
      log: vi.fn(),
    });
    return { issueReportsRouter, storage: createFsIssueDraftStorage(draftsDir) };
  }

  const post = (router: Awaited<ReturnType<typeof wire>>['issueReportsRouter'], headers: Record<string, string> = {}, env = LOCAL_ENV) =>
    router.request(
      '/api/issue-reports/manual-drafts',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', host: 'localhost:8787', ...headers },
        body: JSON.stringify({ title: 'The board hangs', description: 'it froze' }),
      },
      env,
    );

  it('serves POST manual-drafts from the same router and fills envInfo on the server', async () => {
    const { issueReportsRouter, storage } = await wire();
    const res = await post(issueReportsRouter);
    expect(res.status).toBe(201);
    const { draft } = (await res.json()) as { draft: { id: string } };

    const stored: IssueDraft | undefined = await storage.get(draft.id);
    expect(stored).toMatchObject({ kind: 'C', source: 'manual', titleEditedByUser: true });
    expect(stored?.localOnly.envInfo).toEqual({
      bdboardVersion: '9.8.7',
      os: process.platform,
      nodeVersion: process.version,
    });
  });

  it('rejects the tunnel with 403 (the route is registered behind the local-only guard)', async () => {
    const { issueReportsRouter, storage } = await wire();
    const res = await post(issueReportsRouter, { 'cf-ray': 'abc123-NRT' }, TUNNEL_ENV);
    expect(res.status).toBe(403);
    expect((await storage.scan()).drafts).toHaveLength(0);
  });
});
