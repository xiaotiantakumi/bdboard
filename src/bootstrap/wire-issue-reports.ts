/**
 * bdboard-4y8q.1: 不具合報告の下書き (保存・受け取り API) の配線。
 *
 * 保存先ディレクトリの解決 (BDBOARD_ISSUE_DRAFTS_DIR での上書きを含む) とルーターの
 * 組み立てだけを行う。mount 順は mount-routes.ts 側の責務。
 *
 * 届いた issue の読み取り API (bdboard-4y8q.9.4) も同じルーターに載せる。サービスとタイマーは
 * wire-external-issues.ts が作り、メンテナ環境でなければ作らない。
 */
import type { Hono } from 'hono';
import type { IssueDraftService } from '../application/issue-report/issue-draft-service.js';
import { memoizeAsyncWithTtl } from '../application/issue-report/memoize-with-ttl.js';
import type { ApplicationVersionProvider } from '../application/ports/application-version.js';
import type { CommandRunner } from '../application/ports/command-runner.js';
import type { PackRegistryPort } from '../application/ports/pack-registry.js';
import { caseFoldingTableUsable } from '../domain/issue-public-casefold.js';
import { createPackageJsonVersionProvider } from '../infrastructure/version/package-json-version-provider.js';
import { createExternalIssueRoutes } from '../interface/http/external-issue-routes.js';
import { createIssueReportManualRoutes } from '../interface/http/issue-report-manual-routes.js';
import { createIssueReportRoutes } from '../interface/http/issue-report-routes.js';
import type { WriteGuardDeps } from '../interface/http/write-guard.js';
import { wireExternalIssues, type WiredExternalIssues } from './wire-external-issues.js';
import { wireIssueDraftService } from './wire-issue-draft-service.js';

export interface WireIssueReportsDeps {
  readonly repoRoot: string;
  /** 下書きの時刻と、最新の pack の版の使い回しの時計 (既定は現在時刻。テストが差し替える)。 */
  readonly now?: () => Date;
  readonly env: NodeJS.ProcessEnv;
  /** 届いた issue の gh と bd の呼び出しに使う。無いとき (テスト) は届いた issue を無効にする。 */
  readonly commandRunner?: CommandRunner;
  readonly writeAccess: WriteGuardDeps;
  /** 最新の harness pack の版を読む (1 件の取得の「版の比較」、bdboard-4y8q.3.1)。 */
  readonly packRegistry: Pick<PackRegistryPort, 'listPacks'>;
  readonly log?: (message: string) => void;
  /** service を渡さないときだけ使う: 自分で作るサービスの envInfo に入れる bdboard の版 (既定は package.json の version)。 */
  readonly applicationVersion?: ApplicationVersionProvider;
  /** 公開本文の大文字小文字の表が使えるか (既定は caseFoldingTableUsable。テストが差し替える)。 */
  readonly caseTableUsable?: () => boolean;
  readonly service?: IssueDraftService;
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

export function wireIssueReports(deps: WireIssueReportsDeps): {
  issueReportsRouter: Hono;
  /** 届いた issue のタイマーの持ち主。main.ts が終了時に `stop` を呼ぶ。 */
  externalIssues: WiredExternalIssues;
} {
  const log = deps.log ?? console.log;
  const now = deps.now ?? (() => new Date());
  // main.ts は作ったサービスを渡す (版はそちらで埋める)。渡さないとき (テスト) だけここで作る。
  const service =
    deps.service ??
    wireIssueDraftService({
      repoRoot: deps.repoRoot,
      env: deps.env,
      applicationVersion: deps.applicationVersion ?? createPackageJsonVersionProvider(),
      now,
      log,
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
  // 届いた issue (ほかの人が出した公開 issue) の読み取り口と定期確認 (メンテナ環境だけ。bdboard-4y8q.9.4)。
  const externalIssues = wireExternalIssues({
    repoRoot: deps.repoRoot,
    env: deps.env,
    log,
    ...(deps.commandRunner !== undefined ? { commandRunner: deps.commandRunner } : {}),
  });
  issueReportsRouter.route('/', createExternalIssueRoutes({ service: externalIssues.service, now: externalIssues.now }));

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

  return { issueReportsRouter, externalIssues };
}
