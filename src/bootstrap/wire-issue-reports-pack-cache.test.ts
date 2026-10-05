import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFsIssueDraftStorage } from '../infrastructure/fs/fs-issue-draft-storage.js';
import type { IssueDraft } from '../domain/issue-draft.js';
import { wireIssueReports } from './wire-issue-reports.js';

const ID = '1758812345002-a1b2c3d4e5f6a7b8';
const DRAFT: IssueDraft = {
  id: ID, kind: 'A', fingerprint: 'A:slug', title: 'title', body: 'body', titleEditedByUser: true, bodyEditedByUser: false,
  localOnly: { symptomRaw: '', causeRaw: '', preventionRaw: '', errorTextTruncated: false, envInfo: { bdboardVersion: '1', os: 'darwin', nodeVersion: 'v22' } },
  occurredProjects: [], occurrenceCount: 1, firstOccurredAt: '2026-10-01T00:00:00.000Z', lastOccurredAt: '2026-10-01T00:00:00.000Z', status: 'pending', draftSchemaVersion: 1,
};
describe('wireIssueReports pack version cache', () => {
  let root = '';
  afterEach(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });
  it('loads the pack list once within 30 seconds and again after expiry', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bdboard-pack-cache-'));
    const draftsDir = path.join(root, 'drafts');
    await createFsIssueDraftStorage(draftsDir).save(DRAFT);
    let time = new Date('2026-10-04T12:00:00Z');
    const listPacks = vi.fn(async () => [{ name: 'bdboard-harness', version: '1.2.3', description: '', hooks: [] }]);
    const { issueReportsRouter } = wireIssueReports({ repoRoot: root, env: { BDBOARD_ISSUE_DRAFTS_DIR: draftsDir }, writeAccess: {}, packRegistry: { listPacks }, now: () => time, log: vi.fn() });
    const get = () => issueReportsRouter.request(`/api/issue-reports/drafts/${ID}`, { headers: { host: 'localhost:8787' } }, { incoming: { socket: { remoteAddress: '127.0.0.1', localPort: 8787 } } });
    await get(); await get();
    expect(listPacks).toHaveBeenCalledTimes(1);
    time = new Date(time.getTime() + 30_001);
    await get();
    expect(listPacks).toHaveBeenCalledTimes(2);
  });
});
