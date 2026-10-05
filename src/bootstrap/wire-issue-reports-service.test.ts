/** bdboard-4y8q.6.3: wireIssueReports が注入 service を再利用する。 */
import { describe, expect, it, vi } from 'vitest';
import type { IssueDraftService } from '../application/issue-report/issue-draft-service.js';
import { wireIssueReports } from './wire-issue-reports.js';

describe('wireIssueReports service injection', () => {
  it('uses the supplied service without pruning or creating a second one', () => {
    const service = { receive: vi.fn(), pruneOnStart: vi.fn() } as unknown as IssueDraftService;
    const result = wireIssueReports({ repoRoot: '/tmp', env: {}, service, writeAccess: {}, packRegistry: { listPacks: async () => [] }, log: vi.fn(), caseTableUsable: () => true });
    expect(result.issueReportsRouter).toBeDefined();
    expect(service.pruneOnStart).not.toHaveBeenCalled();
  });
});
