/**
 * bdboard-4y8q.1: 不具合報告の下書き (保存・受け取り API) の配線。
 *
 * 保存先ディレクトリの解決 (BDBOARD_ISSUE_DRAFTS_DIR での上書きを含む) とルーターの
 * 組み立てだけを行う。mount 順は mount-routes.ts 側の責務。
 */
import { randomBytes } from 'node:crypto';
import type { Hono } from 'hono';
import { createIssueDraftService } from '../application/issue-report/issue-draft-service.js';
import type { PackRegistryPort } from '../application/ports/pack-registry.js';
import { createFsIssueDraftStorage } from '../infrastructure/fs/fs-issue-draft-storage.js';
import { resolveIssueDraftsDir } from '../infrastructure/fs/resolve-issue-drafts-dir.js';
import { createIssueReportRoutes } from '../interface/http/issue-report-routes.js';
import type { WriteGuardDeps } from '../interface/http/write-guard.js';

export interface WireIssueReportsDeps {
  readonly repoRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly writeAccess: WriteGuardDeps;
  /** 最新の harness pack の版を読む (1 件の取得の「版の比較」、bdboard-4y8q.3.1)。 */
  readonly packRegistry: Pick<PackRegistryPort, 'listPacks'>;
  readonly log?: (message: string) => void;
}

/**
 * 版を比べる pack。注入先の .claude/bdboard-packs.json に記録される version (下書きの harnessVersionAtOccurrence)
 * と、この bdboard の harness/packs/bdboard-harness/pack.json の version を並べる。
 */
const COMPARED_PACK_NAME = 'bdboard-harness';

export function wireIssueReports(deps: WireIssueReportsDeps): { issueReportsRouter: Hono } {
  const log = deps.log ?? console.log;
  const draftsDir = resolveIssueDraftsDir(deps.repoRoot, deps.env);

  const service = createIssueDraftService({
    storage: createFsIssueDraftStorage(draftsDir),
    now: () => new Date(),
    // 添付画像と同じ採番規約: <epochMs>-<16桁hex> (ソート可能・衝突耐性・パスとして安全)。
    newId: () => `${Date.now()}-${randomBytes(8).toString('hex')}`,
  });

  const issueReportsRouter = createIssueReportRoutes({
    service,
    writeAccess: deps.writeAccess,
    latestHarnessVersion: async () =>
      (await deps.packRegistry.listPacks()).find((pack) => pack.name === COMPARED_PACK_NAME)?.version,
  });

  // 起動時の掃除 (bdboard-00qh): 見送り・投稿済みで 30 日を過ぎた下書きを画像ごと消す。待たない・失敗しても
  // 起動は止めない (service が警告だけ出して投げない)。開いている (pending) 下書きは消さない。
  // 万一投げても未処理の reject でプロセスを落とさない: ログは code だけ (パスも message も出さない)。
  void service.pruneOnStart().catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    log(`issue draft prune at start failed (${typeof code === 'string' ? code : 'unknown'})`);
  });

  log(`Issue report drafts: storing under ${draftsDir}`);

  return { issueReportsRouter };
}
