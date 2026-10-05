/**
 * bdboard-4y8q.9.4: 届いた issue (ほかの人が出した公開 issue) を定期的に確かめる配線。
 *
 * メンテナ環境 (bdboard 自身の `.beads` がある main checkout) のときだけ、サービスとタイマーを作る。そうでなければ何も作らず、
 * gh も bd も呼ばない (`enabled: false`)。メンテナ環境でも `BDBOARD_EXTERNAL_ISSUES_DISABLED=1` なら同じく何も作らない (bdboard-em45。
 * メインチェックアウトから回す e2e のサーバー用)。ルートへの載せ方は wire-issue-reports.ts、終了時の停止は wire-shutdown.ts。
 *
 * gh を起動する道は、1 時間に 12 回までの関所 (`createBudgetedCommandRunner`) を通る 1 つだけ。定期の確認・手動の refresh・
 * ページ送りのどの組み合わせでも、この関所が上限を保つ (docs/ISSUE-REPORTING.md 8節)。
 */
import { createSlidingWindowBudget } from '../application/issue-report/call-budget.js';
import { createExternalIssueService, type ExternalIssueService } from '../application/issue-report/external-issue-service.js';
import {
  createExternalIssueScheduler,
  type ExternalIssueSchedulerTimerHandle,
} from '../application/issue-report/external-issue-scheduler.js';
import type { CommandRunner } from '../application/ports/command-runner.js';
import type { ExternalIssueSnapshotStoragePort } from '../application/ports/external-issue-snapshot-storage.js';
import type { BdExternalRefReaderPort, ExternalIssueSourcePort } from '../application/ports/external-issue-source.js';
import {
  EXTERNAL_ISSUE_GH_CALLS_PER_HOUR,
  EXTERNAL_ISSUE_GH_CALL_WINDOW_MS,
  EXTERNAL_ISSUE_GH_MAX_PAGES,
  EXTERNAL_ISSUE_POLL_DEFAULT_INTERVAL_MS,
  EXTERNAL_ISSUE_POLL_FIRST_DELAY_MS,
  resolveExternalIssuePollIntervalMs,
} from '../domain/external-issue-poll-policy.js';
import { createBdCliExternalRefReader } from '../infrastructure/bd/bd-cli-external-ref-reader.js';
import { envBool, envInt, envString } from '../infrastructure/env.js';
import { createFsExternalIssueSnapshotStorage } from '../infrastructure/fs/fs-external-issue-snapshot-storage.js';
import { isMaintainerEnvironment } from '../infrastructure/fs/is-maintainer-environment.js';
import { resolveExternalIssuesDir } from '../infrastructure/fs/resolve-external-issues-dir.js';
import { createBudgetedCommandRunner } from '../infrastructure/gh/budgeted-command-runner.js';
import { createGhCliExternalIssueSource } from '../infrastructure/gh/gh-cli-external-issue-source.js';

/** 読む対象のリポジトリ。gh のソースと、bd の external_ref の紐付けの判定 (サービス) の両方に同じものを渡す。環境変数での差し替えは無い。 */
export const EXTERNAL_ISSUES_REPO_SLUG = 'xiaotiantakumi/bdboard';

/**
 * `1` または `true` (大小無視) のとき、メンテナ環境でも届いた issue の確認を作らない (bdboard-em45)。
 * メンテナ環境の判定 (`.beads` の有無) の手前で見るので、無効のときは `.beads` も見ない。
 * e2e のサーバー (test/e2e/global-setup.ts) が、メインチェックアウトから起動されたときに本物の gh を呼ばないために立てる。
 */
export const EXTERNAL_ISSUES_DISABLED_ENV = 'BDBOARD_EXTERNAL_ISSUES_DISABLED';

/**
 * 上限に達したときに画面へ出る理由 (一覧の `error.detail`)。gh の rate limit や未ログインの文言 (`gh-cli-failure.ts` のパターン)
 * に当たらない文面にする: 当たると、読み取りの層がその種類に分類して、手元の上限だと分からなくなる。
 */
const GH_BUDGET_EXHAUSTED_MESSAGE = `gh call limit reached: at most ${EXTERNAL_ISSUE_GH_CALLS_PER_HOUR} gh calls per hour (local limit); try again later`;

export interface ExternalIssuePorts {
  readonly source: ExternalIssueSourcePort;
  readonly refReader: BdExternalRefReaderPort;
  readonly storage: ExternalIssueSnapshotStoragePort;
}

export interface WireExternalIssuesDeps {
  /** bdboard の checkout のルート。メンテナ環境かの判定、bd の読み取り先、写しの置き場の基点になる。 */
  readonly repoRoot: string;
  readonly env: NodeJS.ProcessEnv;
  /** gh と bd を呼ぶ道具。無いとき (テスト) は無効になる。 */
  readonly commandRunner?: CommandRunner;
  /** 既定は console.log。 */
  readonly log?: (message: string) => void;
  /**
   * gh の呼び出しの枠と、手動 refresh の間隔を測る時計 (ミリ秒)。既定は単調な `performance.now()`
   * (壁時計が進んでも、枠が早く空かないように)。
   */
  readonly monotonicNow?: () => number;
  /** テスト用: メンテナ環境の判定の差し替え (既定は `<repoRoot>/.beads` の有無)。 */
  readonly isMaintainerEnvironment?: (repoRoot: string) => boolean;
  /** テスト用: 偽のポート。渡すと gh・bd・保存先を作らない (`commandRunner` が無くても有効になる)。 */
  readonly ports?: ExternalIssuePorts;
  /** テスト用: 偽のタイマー (既定はグローバルの setTimeout)。 */
  readonly timers?: {
    readonly setTimer: (callback: () => void, ms: number) => ExternalIssueSchedulerTimerHandle;
    readonly clearTimer: (handle: ExternalIssueSchedulerTimerHandle) => void;
  };
}

export interface WiredExternalIssues {
  readonly enabled: boolean;
  /** 無効のときは undefined。 */
  readonly service: ExternalIssueService | undefined;
  /** 手動 refresh の間隔を測る時計 (ルートへ渡す)。 */
  readonly now: () => number;
  /** タイマーを止める (終了時)。無効のときは何もしない。何度呼んでも安全。 */
  readonly stop: () => void;
}

/** gh は枠のある runner だけを通し、bd は素の runner で読む。枠は 1 つだけ作って gh に使う。 */
function createPortsFromRunner(
  deps: WireExternalIssuesDeps,
  commandRunner: CommandRunner,
  now: () => number,
): ExternalIssuePorts {
  const budget = createSlidingWindowBudget({
    limit: EXTERNAL_ISSUE_GH_CALLS_PER_HOUR,
    windowMs: EXTERNAL_ISSUE_GH_CALL_WINDOW_MS,
    now,
  });
  const ghRunner = createBudgetedCommandRunner(commandRunner, budget, GH_BUDGET_EXHAUSTED_MESSAGE);
  return {
    source: createGhCliExternalIssueSource(ghRunner, {
      ghPath: envString(deps.env, 'BDBOARD_GH_PATH', 'gh'),
      repoSlug: EXTERNAL_ISSUES_REPO_SLUG,
      maxPages: EXTERNAL_ISSUE_GH_MAX_PAGES,
    }),
    refReader: createBdCliExternalRefReader(commandRunner, { bdPath: envString(deps.env, 'BDBOARD_BD_PATH', 'bd') }),
    storage: createFsExternalIssueSnapshotStorage(resolveExternalIssuesDir(deps.repoRoot)),
  };
}

export function wireExternalIssues(deps: WireExternalIssuesDeps): WiredExternalIssues {
  const now = deps.monotonicNow ?? (() => performance.now());
  const log = deps.log ?? console.log;
  const maintainer = deps.isMaintainerEnvironment ?? isMaintainerEnvironment;

  // 環境変数で止められているか、メンテナ環境でなければ何も作らない (タイマーも、写しの置き場も、gh・bd の呼び出しも)。
  if (envBool(deps.env, EXTERNAL_ISSUES_DISABLED_ENV) || !maintainer(deps.repoRoot)) {
    return { enabled: false, service: undefined, now, stop: () => undefined };
  }
  const ports = deps.ports ?? (deps.commandRunner === undefined ? undefined : createPortsFromRunner(deps, deps.commandRunner, now));
  if (ports === undefined) {
    return { enabled: false, service: undefined, now, stop: () => undefined };
  }

  const service = createExternalIssueService({
    ...ports,
    projectRootPath: deps.repoRoot,
    repoSlug: EXTERNAL_ISSUES_REPO_SLUG,
  });
  const baseIntervalMs = resolveExternalIssuePollIntervalMs(
    envInt(deps.env, 'BDBOARD_EXTERNAL_ISSUES_INTERVAL_MS', EXTERNAL_ISSUE_POLL_DEFAULT_INTERVAL_MS),
  );
  const scheduler = createExternalIssueScheduler({
    poll: () => service.poll(),
    baseIntervalMs,
    ...deps.timers,
    // ログには止まった種類だけを残す (detail には gh の stderr の一部が入りうる)。detail は整えて 300 文字までにした上で
    // GET の応答には載る (トンネル越しの Basic 認証の読み手にも見える。refresh はローカルだけ)。
    onResult: (outcome) => {
      if (outcome.state === 'error') log(`external issues: poll failed (${outcome.error?.kind ?? 'failed'})`);
    },
  });
  scheduler.start();
  log(
    `external issues: enabled (first check in ${EXTERNAL_ISSUE_POLL_FIRST_DELAY_MS / 1000}s, then every ${baseIntervalMs / 60_000} min)`,
  );
  return { enabled: true, service, now, stop: () => scheduler.stop() };
}
