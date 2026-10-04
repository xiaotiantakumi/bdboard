import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IssueDraft } from '../domain/issue-draft.js';
import { createFsIssueDraftStorage } from '../infrastructure/fs/fs-issue-draft-storage.js';
import { wireIssueReports } from './wire-issue-reports.js';

/** bdboard-00qh: 起動時の掃除が配線されている (期限切れの見送り済みだけが、起動のあとに消える)。 */

const DAY_MS = 24 * 60 * 60 * 1000;
const ID_OLD_DISMISSED = '1758812345001-a1b2c3d4e5f6a7b8';
const ID_OLD_OPEN = '1758812345002-a1b2c3d4e5f6a7b8';

function makeDraft(id: string, status: IssueDraft['status']): IssueDraft {
  return {
    id,
    kind: 'A',
    fingerprint: `A:slug-${id}`,
    title: 'title',
    body: 'body',
    titleEditedByUser: false,
    bodyEditedByUser: false,
    localOnly: {
      symptomRaw: 'symptom',
      causeRaw: 'cause',
      preventionRaw: 'prevention',
      errorTextTruncated: false,
      envInfo: { bdboardVersion: '0.1.2', os: 'darwin', nodeVersion: 'v22.14.0' },
    },
    occurredProjects: [],
    occurrenceCount: 1,
    firstOccurredAt: '2026-01-01T00:00:00.000Z',
    lastOccurredAt: '2026-01-01T00:00:00.000Z',
    status,
    ...(status === 'dismissed' ? { dismissReason: 'not a bug' } : {}),
    draftSchemaVersion: 1,
  };
}

describe('wireIssueReports: the start-up prune', () => {
  let root: string;
  let draftsDir: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bdboard-wire-issue-reports-'));
    draftsDir = path.join(root, 'issue-drafts');
  });

  afterEach(async () => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function seed(draft: IssueDraft, ageMs: number): Promise<void> {
    await createFsIssueDraftStorage(draftsDir, { warn: () => undefined }).save(draft);
    const when = new Date(Date.now() - ageMs);
    await fs.utimes(path.join(draftsDir, draft.id, 'draft.json'), when, when);
  }

  const exists = (id: string): Promise<boolean> =>
    fs.access(path.join(draftsDir, id)).then(() => true, () => false);

  it('removes a dismissed draft past 30 days after start-up, and leaves an open one that old alone', async () => {
    await seed(makeDraft(ID_OLD_DISMISSED, 'dismissed'), 40 * DAY_MS);
    await seed(makeDraft(ID_OLD_OPEN, 'pending'), 40 * DAY_MS);

    wireIssueReports({
      repoRoot: root,
      env: { BDBOARD_ISSUE_DRAFTS_DIR: draftsDir },
      writeAccess: {},
      log: vi.fn(),
    });

    // 起動の掃除は待たずに走る (void) ので、消えるまで待つ。負荷の高い実行でも落ちないよう長めに。
    await vi.waitFor(
      async () => {
        expect(await exists(ID_OLD_DISMISSED)).toBe(false);
      },
      { timeout: 4000, interval: 25 }, // テストの既定の 5 秒より短く
    );
    expect(await exists(ID_OLD_OPEN)).toBe(true);
  });
});
