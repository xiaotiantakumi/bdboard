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
      packRegistry: { listPacks: async () => [] },
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

  it('puts the version of the bdboard-harness pack this bdboard ships next to the draft (bdboard-4y8q.3.1)', async () => {
    await seed(makeDraft(ID_OLD_OPEN, 'pending'), 0);
    const pack = (name: string, version: string) => ({ name, version, description: '', hooks: [] });
    const { issueReportsRouter } = wireIssueReports({
      repoRoot: root,
      env: { BDBOARD_ISSUE_DRAFTS_DIR: draftsDir },
      writeAccess: {},
      packRegistry: { listPacks: async () => [pack('other-pack', '9.9.9'), pack('bdboard-harness', '0.57.0')] },
      log: vi.fn(),
    });
    const res = await issueReportsRouter.request(
      `/api/issue-reports/drafts/${ID_OLD_OPEN}`,
      { headers: { host: 'localhost:8787' } },
      { incoming: { socket: { remoteAddress: '127.0.0.1', localPort: 8787 } } },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { latestHarnessVersion: unknown }).latestHarnessVersion).toBe('0.57.0');
  });

  it('warns once with a code when the public body case table cannot be used (bdboard-uudb)', async () => {
    const log = vi.fn();
    wireIssueReports({
      repoRoot: root,
      env: { BDBOARD_ISSUE_DRAFTS_DIR: draftsDir },
      writeAccess: {},
      packRegistry: { listPacks: async () => [] },
      log,
      caseTableUsable: () => false,
    });
    await vi.waitFor(() => {
      expect(log).toHaveBeenCalledWith(expect.stringContaining('(case-table-fallback)'));
    });
    expect(log.mock.calls.filter(([message]) => String(message).includes('case-table-fallback'))).toHaveLength(1);
  });

  it('does not warn about the case table when it can be used', async () => {
    const log = vi.fn();
    const usable = vi.fn(() => true);
    wireIssueReports({
      repoRoot: root,
      env: { BDBOARD_ISSUE_DRAFTS_DIR: draftsDir },
      writeAccess: {},
      packRegistry: { listPacks: async () => [] },
      log,
      caseTableUsable: usable,
    });
    await vi.waitFor(() => {
      expect(usable).toHaveBeenCalledTimes(1);
    });
    expect(log.mock.calls.some(([message]) => String(message).includes('case-table-fallback'))).toBe(false);
  });

  // setImmediate の中で投げると、未処理の例外として起動の直後にサーバーが落ちる (vitest でも未処理の例外として実行全体が失敗する)。
  it.each([
    ['an error with a code', Object.assign(new RangeError('/Users/example-user/secret/path exploded'), { code: 'ERR_EXAMPLE' }), 'ERR_EXAMPLE'],
    ['an error without a code', new Error('/Users/example-user/secret/path exploded'), 'unknown'],
  ])(
    'logs only a code and does not crash when the case table check throws: %s (bdboard-qoxj)',
    async (_name, thrown, expectedCode) => {
      const log = vi.fn();
      wireIssueReports({
        repoRoot: root,
        env: { BDBOARD_ISSUE_DRAFTS_DIR: draftsDir },
        writeAccess: {},
        packRegistry: { listPacks: () => Promise.resolve([]) },
        log,
        caseTableUsable: () => {
          throw thrown;
        },
      });
      await vi.waitFor(() => {
        expect(log).toHaveBeenCalledWith(expect.stringContaining('(case-table-check-failed, '));
      });
      // 表についてのログはこの 1 行だけ: code だけで error.message とパスは出さず、退避の警告 (case-table-fallback) も出さない。
      const tableMessages = log.mock.calls.map(([message]) => String(message)).filter((message) => message.includes('case table'));
      expect(tableMessages).toEqual([`issue public body: case table check failed (case-table-check-failed, ${expectedCode})`]);
    },
  );

  it('answers null for the latest version when the pack cannot be read, without failing the read', async () => {
    await seed(makeDraft(ID_OLD_OPEN, 'pending'), 0);
    const { issueReportsRouter } = wireIssueReports({
      repoRoot: root,
      env: { BDBOARD_ISSUE_DRAFTS_DIR: draftsDir },
      writeAccess: {},
      packRegistry: { listPacks: () => Promise.reject(new Error('EIO')) },
      log: vi.fn(),
    });
    const res = await issueReportsRouter.request(
      `/api/issue-reports/drafts/${ID_OLD_OPEN}`,
      { headers: { host: 'localhost:8787' } },
      { incoming: { socket: { remoteAddress: '127.0.0.1', localPort: 8787 } } },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { latestHarnessVersion: unknown }).latestHarnessVersion).toBeNull();
  });
});
