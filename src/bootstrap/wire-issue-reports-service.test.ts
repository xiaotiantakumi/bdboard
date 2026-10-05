/** bdboard-4y8q.6.3: wireIssueReports が注入 service を再利用する。 */
import { describe, expect, it, vi } from 'vitest';
import type { IssueDraftService } from '../application/issue-report/issue-draft-service.js';
import { wireIssueReports } from './wire-issue-reports.js';

describe('wireIssueReports service injection', () => {
  it('uses the supplied service without pruning or creating a second one', () => {
    const pruneOnStart = vi.fn();
    const service = { receive: vi.fn(), pruneOnStart } as unknown as IssueDraftService;
    const log = vi.fn();
    // 万一 service を使わない退行があっても、本物の ~/.bdboard/issue-drafts を掃除しないよう保存先は存在しない場所に向ける。
    const env = { BDBOARD_ISSUE_DRAFTS_DIR: '/nonexistent/bdboard-issue-drafts-test' };
    const result = wireIssueReports({ repoRoot: '/nonexistent', env, service, writeAccess: {}, packRegistry: { listPacks: () => Promise.resolve([]) }, log, caseTableUsable: () => true });
    expect(result.issueReportsRouter).toBeDefined();
    expect(pruneOnStart).not.toHaveBeenCalled();
    // 2 つ目のサービスを作ると「保存先」のログが出る。
    expect(log.mock.calls.flat().some((line) => String(line).startsWith('Issue report drafts: storing under'))).toBe(false);
  });
});
