/**
 * bdboard-4y8q.1: 不具合報告の下書き (保存・受け取り API) の配線。
 *
 * 保存先ディレクトリの解決 (BDBOARD_ISSUE_DRAFTS_DIR での上書きを含む) とルーターの
 * 組み立てだけを行う。mount 順は mount-routes.ts 側の責務。
 */
import { randomBytes } from 'node:crypto';
import type { Hono } from 'hono';
import { createIssueDraftService } from '../application/issue-report/issue-draft-service.js';
import { createFsIssueDraftStorage } from '../infrastructure/fs/fs-issue-draft-storage.js';
import { resolveIssueDraftsDir } from '../infrastructure/fs/resolve-issue-drafts-dir.js';
import { createIssueReportRoutes } from '../interface/http/issue-report-routes.js';
import type { WriteGuardDeps } from '../interface/http/write-guard.js';

export interface WireIssueReportsDeps {
  readonly repoRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly writeAccess: WriteGuardDeps;
  readonly log?: (message: string) => void;
}

export function wireIssueReports(deps: WireIssueReportsDeps): { issueReportsRouter: Hono } {
  const log = deps.log ?? console.log;
  const draftsDir = resolveIssueDraftsDir(deps.repoRoot, deps.env);

  const service = createIssueDraftService({
    storage: createFsIssueDraftStorage(draftsDir),
    now: () => new Date(),
    // 添付画像と同じ採番規約: <epochMs>-<16桁hex> (ソート可能・衝突耐性・パスとして安全)。
    newId: () => `${Date.now()}-${randomBytes(8).toString('hex')}`,
  });

  const issueReportsRouter = createIssueReportRoutes({ service, writeAccess: deps.writeAccess });

  log(`Issue report drafts: storing under ${draftsDir}`);

  return { issueReportsRouter };
}
