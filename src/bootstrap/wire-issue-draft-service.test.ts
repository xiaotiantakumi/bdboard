/**
 * bdboard-4y8q.6.3 × 4y8q.6.7: main.ts の形 (下書きサービスを lifecycle より先に作り、wireIssueReports へ渡す) でも、
 * 手書きの下書きの envInfo はサーバーが埋める。wireIssueReports の applicationVersion は service を渡したときは使わない。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFsIssueDraftStorage } from '../infrastructure/fs/fs-issue-draft-storage.js';
import { wireIssueDraftService } from './wire-issue-draft-service.js';
import { wireIssueReports } from './wire-issue-reports.js';

const LOCAL_ENV = { incoming: { socket: { remoteAddress: '127.0.0.1', localPort: 8787 } } };

describe('wireIssueDraftService + wireIssueReports (main.ts composition)', () => {
  let root = '';
  afterEach(async () => {
    if (root !== '') await fs.rm(root, { recursive: true, force: true });
  });

  it('fills envInfo of a manual draft from the version given to wireIssueDraftService', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bdboard-draft-service-wire-'));
    const draftsDir = path.join(root, 'drafts');
    const env = { BDBOARD_ISSUE_DRAFTS_DIR: draftsDir };
    const service = wireIssueDraftService({ repoRoot: root, env, applicationVersion: { getVersion: () => '9.8.7' }, log: vi.fn() });
    const { issueReportsRouter } = wireIssueReports({
      repoRoot: root,
      env,
      service,
      writeAccess: {},
      packRegistry: { listPacks: vi.fn(() => Promise.resolve([])) },
      log: vi.fn(),
    });

    const res = await issueReportsRouter.request(
      '/api/issue-reports/manual-drafts',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', host: 'localhost:8787' },
        body: JSON.stringify({ title: 'The board hangs', description: 'it froze' }),
      },
      LOCAL_ENV,
    );
    expect(res.status).toBe(201);
    const { draft } = (await res.json()) as { draft: { id: string } };
    const stored = await createFsIssueDraftStorage(draftsDir).get(draft.id);
    expect(stored?.localOnly.envInfo).toEqual({ bdboardVersion: '9.8.7', os: process.platform, nodeVersion: process.version });
  });

  it.each(['1.2.3', 'unknown'])('includes bdVersion %s in a manual draft', async (bdVersion) => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bdboard-draft-service-version-'));
    const draftsDir = path.join(root, 'drafts');
    const env = { BDBOARD_ISSUE_DRAFTS_DIR: draftsDir };
    const service = wireIssueDraftService({ repoRoot: root, env, applicationVersion: { getVersion: () => '9.8.7' }, bdVersion: () => bdVersion, log: vi.fn() });
    const { issueReportsRouter } = wireIssueReports({ repoRoot: root, env, service, writeAccess: {}, packRegistry: { listPacks: vi.fn(() => Promise.resolve([])) }, log: vi.fn() });
    const res = await issueReportsRouter.request('/api/issue-reports/manual-drafts', { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost:8787' }, body: JSON.stringify({ title: 'The board hangs', description: 'it froze' }) }, LOCAL_ENV);
    expect(res.status).toBe(201);
    const { draft } = (await res.json()) as { draft: { id: string } };
    const stored = await createFsIssueDraftStorage(draftsDir).get(draft.id);
    expect(stored?.localOnly.envInfo).toEqual({ bdboardVersion: '9.8.7', os: process.platform, nodeVersion: process.version, bdVersion });
  });
});
