/**
 * bdboard-4y8q.1: 不具合報告の下書き (保存・受け取り API) の配線。
 *
 * 保存先ディレクトリの解決 (BDBOARD_ISSUE_DRAFTS_DIR での上書きを含む) とルーターの
 * 組み立てだけを行う。mount 順は mount-routes.ts 側の責務。
 */
import { randomBytes } from 'node:crypto';
import type { Hono } from 'hono';
import { createIssueDraftService } from '../application/issue-report/issue-draft-service.js';
import { memoizeAsyncWithTtl } from '../application/issue-report/memoize-with-ttl.js';
import type { ApplicationVersionProvider } from '../application/ports/application-version.js';
import type { PackRegistryPort } from '../application/ports/pack-registry.js';
import { caseFoldingTableUsable } from '../domain/issue-public-casefold.js';
import { createFsIssueDraftStorage } from '../infrastructure/fs/fs-issue-draft-storage.js';
import { resolveIssueDraftsDir } from '../infrastructure/fs/resolve-issue-drafts-dir.js';
import { createPackageJsonVersionProvider } from '../infrastructure/version/package-json-version-provider.js';
import { createIssueReportManualRoutes } from '../interface/http/issue-report-manual-routes.js';
import { createIssueReportRoutes } from '../interface/http/issue-report-routes.js';
import type { WriteGuardDeps } from '../interface/http/write-guard.js';

export interface WireIssueReportsDeps {
  readonly repoRoot: string;
  /** 下書きの時刻と、最新の pack の版の使い回しの時計 (既定は現在時刻。テストが差し替える)。 */
  readonly now?: () => Date;
  readonly env: NodeJS.ProcessEnv;
  readonly writeAccess: WriteGuardDeps;
  /** 最新の harness pack の版を読む (1 件の取得の「版の比較」、bdboard-4y8q.3.1)。 */
  readonly packRegistry: Pick<PackRegistryPort, 'listPacks'>;
  readonly log?: (message: string) => void;
  /** 手書きの下書き (bdboard-4y8q.6.7) の envInfo に入れる bdboard の版 (既定は package.json の version)。 */
  readonly applicationVersion?: ApplicationVersionProvider;
  /** 公開本文の大文字小文字の表が使えるか (既定は caseFoldingTableUsable。テストが差し替える)。 */
  readonly caseTableUsable?: () => boolean;
}

/**
 * 最新の pack の版 (listPacks が全 pack を読む) を使い回す時間 (bdboard-pnvj)。版が変わるのは bdboard の更新のときで、
 * 再起動でもキャッシュは作り直される。ずれるのは「版の比較」の表示だけで、30 秒は問題にならない。
 */
export const LATEST_HARNESS_VERSION_TTL_MS = 30_000;

/**
 * 版を比べる pack。注入先の .claude/bdboard-packs.json に記録される version (下書きの harnessVersionAtOccurrence)
 * と、この bdboard の harness/packs/bdboard-harness/pack.json の version を並べる。
 */
const COMPARED_PACK_NAME = 'bdboard-harness';

export function wireIssueReports(deps: WireIssueReportsDeps): { issueReportsRouter: Hono } {
  const log = deps.log ?? console.log;
  const draftsDir = resolveIssueDraftsDir(deps.repoRoot, deps.env);
  const now = deps.now ?? (() => new Date());
  const applicationVersion = deps.applicationVersion ?? createPackageJsonVersionProvider();

  const service = createIssueDraftService({
    storage: createFsIssueDraftStorage(draftsDir),
    now,
    // 添付画像と同じ採番規約: <epochMs>-<16桁hex> (ソート可能・衝突耐性・パスとして安全)。
    newId: () => `${Date.now()}-${randomBytes(8).toString('hex')}`,
    // 手書きの下書きの envInfo はサーバーが埋める (画面からは受けない)。
    envInfo: () => ({ bdboardVersion: applicationVersion.getVersion(), os: process.platform, nodeVersion: process.version }),
  });

  const latestHarnessVersion = memoizeAsyncWithTtl(
    async () => (await deps.packRegistry.listPacks()).find((pack) => pack.name === COMPARED_PACK_NAME)?.version,
    LATEST_HARNESS_VERSION_TTL_MS,
    () => now().getTime(),
  );
  const issueReportsRouter = createIssueReportRoutes({
    service,
    writeAccess: deps.writeAccess,
    latestHarnessVersion,
  });
  // 人が手で書く下書きの受け取り口 (ローカル直アクセスのみ。bdboard-4y8q.6.7)。
  issueReportsRouter.route('/', createIssueReportManualRoutes({ service }));

  // 起動時の掃除 (bdboard-00qh): 見送り・投稿済みで 30 日を過ぎた下書きを画像ごと消す。待たない・失敗しても
  // 起動は止めない (service が警告だけ出して投げない)。開いている (pending) 下書きは消さない。
  // 万一投げても未処理の reject でプロセスを落とさない: ログは code だけ (パスも message も出さない)。
  void service.pruneOnStart().catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    log(`issue draft prune at start failed (${typeof code === 'string' ? code : 'unknown'})`);
  });

  log(`Issue report drafts: storing under ${draftsDir}`);

  // 公開本文の大文字小文字の表 (bdboard-uudb)。エンジンの自己検査に落ちると、以前の正規表現の探し方に黙って戻る (結果は同じだが、
  // 大きい鍵で組み立てが数分かかる)。起動の後に 1 回だけ確かめ (表は 0.1〜0.3 秒で作られ、以後の組み立てが使う)、落ちたら code だけ出す。
  // 確かめる処理が投げても、setImmediate の中の未処理の例外でサーバーを落とさない: ログは code だけ (パスも message も出さない)。
  // 表は作れなかったので、最初の組み立てが同じ理由で投げうる (そのときは組み立ての側の失敗として表に出る)。
  const caseTableUsable = deps.caseTableUsable ?? caseFoldingTableUsable;
  setImmediate(() => {
    try {
      if (!caseTableUsable()) log('issue public body: case table unavailable, using the slow regex search (case-table-fallback)');
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      log(`issue public body: case table check failed (case-table-check-failed, ${typeof code === 'string' ? code : 'unknown'})`);
    }
  });

  return { issueReportsRouter };
}
