import type { CommandRunner } from '../application/ports/command-runner.js';
import type { ExternalIssueSourcePort, BdExternalRefReaderPort } from '../application/ports/external-issue-source.js';
import type { ExternalIssueSnapshotStoragePort } from '../application/ports/external-issue-snapshot-storage.js';
import { createExternalIssueService, type ExternalIssueService } from '../application/issue-report/external-issue-service.js';
import { createSlidingWindowBudget } from '../application/issue-report/call-budget.js';
import { createExternalIssueScheduler, type ExternalIssueSchedulerTimerHandle } from '../application/issue-report/external-issue-scheduler.js';
import {
  EXTERNAL_ISSUE_GH_CALLS_PER_HOUR,
  EXTERNAL_ISSUE_GH_CALL_WINDOW_MS,
  EXTERNAL_ISSUE_GH_MAX_PAGES,
  EXTERNAL_ISSUE_POLL_DEFAULT_INTERVAL_MS,
  EXTERNAL_ISSUE_POLL_FIRST_DELAY_MS,
  resolveExternalIssuePollIntervalMs,
} from '../domain/external-issue-poll-policy.js';
import { createBdCliExternalRefReader } from '../infrastructure/bd/bd-cli-external-ref-reader.js';
import { envInt, envString } from '../infrastructure/env.js';
import { createFsExternalIssueSnapshotStorage } from '../infrastructure/fs/fs-external-issue-snapshot-storage.js';
import { isMaintainerEnvironment as defaultMaintainerCheck } from '../infrastructure/fs/is-maintainer-environment.js';
import { resolveExternalIssuesDir } from '../infrastructure/fs/resolve-external-issues-dir.js';
import { createBudgetedCommandRunner } from '../infrastructure/gh/budgeted-command-runner.js';
import { createGhCliExternalIssueSource } from '../infrastructure/gh/gh-cli-external-issue-source.js';

export const EXTERNAL_ISSUES_REPO_SLUG = 'xiaotiantakumi/bdboard';
const EXHAUSTED_MESSAGE = `gh call limit reached: at most ${EXTERNAL_ISSUE_GH_CALLS_PER_HOUR} gh calls per hour (local limit); try again later`;

export interface WireExternalIssuesDeps {
  readonly repoRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly commandRunner?: CommandRunner;
  readonly log?: (message: string) => void;
  readonly monotonicNow?: () => number;
  readonly isMaintainerEnvironment?: (repoRoot: string) => boolean;
  readonly ports?: { source?: ExternalIssueSourcePort; refReader?: BdExternalRefReaderPort; storage?: ExternalIssueSnapshotStoragePort };
  readonly timers?: {
    setTimer: (callback: () => void, ms: number) => ExternalIssueSchedulerTimerHandle;
    clearTimer: (handle: ExternalIssueSchedulerTimerHandle) => void;
  };
}

export interface WiredExternalIssues {
  readonly enabled: boolean;
  readonly service: ExternalIssueService | undefined;
  readonly now: () => number;
  readonly stop: () => void;
}

export function wireExternalIssues(deps: WireExternalIssuesDeps): WiredExternalIssues {
  const now = deps.monotonicNow ?? (() => performance.now());
  const isMaintainer = deps.isMaintainerEnvironment ?? defaultMaintainerCheck;
  if (!isMaintainer(deps.repoRoot) || (deps.commandRunner === undefined && deps.ports?.source === undefined)) {
    return { enabled: false, service: undefined, now, stop: () => undefined };
  }
  const runner = deps.commandRunner;
  const budget = createSlidingWindowBudget({ limit: EXTERNAL_ISSUE_GH_CALLS_PER_HOUR, windowMs: EXTERNAL_ISSUE_GH_CALL_WINDOW_MS, now });
  const source = deps.ports?.source ?? createGhCliExternalIssueSource(
    createBudgetedCommandRunner(runner!, budget, EXHAUSTED_MESSAGE),
    { ghPath: envString(deps.env, 'BDBOARD_GH_PATH', 'gh'), repoSlug: EXTERNAL_ISSUES_REPO_SLUG, maxPages: EXTERNAL_ISSUE_GH_MAX_PAGES },
  );
  const refReader = deps.ports?.refReader ?? createBdCliExternalRefReader(runner!, { bdPath: envString(deps.env, 'BDBOARD_BD_PATH', 'bd') });
  const storage = deps.ports?.storage ?? createFsExternalIssueSnapshotStorage(resolveExternalIssuesDir(deps.repoRoot));
  const service = createExternalIssueService({ source, refReader, storage, projectRootPath: deps.repoRoot, repoSlug: EXTERNAL_ISSUES_REPO_SLUG });
  const baseIntervalMs = resolveExternalIssuePollIntervalMs(
    envInt(deps.env, 'BDBOARD_EXTERNAL_ISSUES_INTERVAL_MS', EXTERNAL_ISSUE_POLL_DEFAULT_INTERVAL_MS),
  );
  const scheduler = createExternalIssueScheduler({
    poll: () => service.poll(),
    baseIntervalMs,
    ...(deps.timers !== undefined ? deps.timers : {}),
    onResult: (result) => {
      if (result.state === 'error') deps.log?.(`external issues: poll failed (${result.error?.kind ?? 'failed'})`);
    },
  });
  scheduler.start();
  const log = deps.log ?? console.log;
  log(`external issues: enabled (first check in ${EXTERNAL_ISSUE_POLL_FIRST_DELAY_MS / 1000}s, then every ${baseIntervalMs / 60_000} min)`);
  return { enabled: true, service, now, stop: () => scheduler.stop() };
}
