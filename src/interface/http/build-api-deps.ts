import type { ApplicationVersionProvider } from '../../application/ports/application-version.js';
import type { BoardCache } from '../../application/ports/board-cache.js';
import type { BoardThresholdsConfigPort } from '../../application/ports/board-thresholds-config.js';
import type { CommentReader } from '../../application/ports/comment-reader.js';
import type { DependencyWriterPort } from '../../application/ports/dependency-writer.js';
import type { HumanDecisionsPort } from '../../application/ports/human-decisions.js';
import type { HygieneThresholdsConfigPort } from '../../application/ports/hygiene-thresholds-config.js';
import type { IssueWriterPort } from '../../application/ports/issue-writer.js';
import type { LeaseReader } from '../../application/ports/lease-reader.js';
import type { MergeSlotReader } from '../../application/ports/merge-slot-reader.js';
import type { PrStatusReader } from '../../application/ports/pr-status-reader.js';
import type { ProcessScanner } from '../../application/ports/process-scanner.js';
import type { SessionLinkWriterPort } from '../../application/ports/session-link-writer.js';
import type { SessionTailReader } from '../../application/ports/session-tail-reader.js';
import type { WorktreeScanner } from '../../application/ports/worktree-scanner.js';
import type { ReclaimScheduler } from '../../application/lease/reclaim-scheduler.js';
import { resolveBoardThresholds } from '../../domain/board-thresholds.js';
import { resolveHygieneThresholds } from '../../domain/hygiene-thresholds.js';
import type { AgentSession, SessionLink } from '../../domain/session.js';
import type { EventHub } from '../sse/event-hub.js';
import type { ApiDeps, ApiStatus } from './routes.js';
import type { WriteGuardDeps } from './write-guard.js';

export interface BuildApiDepsParams {
  readonly cache: BoardCache;
  readonly applicationVersion: ApplicationVersionProvider;
  readonly now: () => Date;
  readonly getStatus: () => ApiStatus;
  readonly refresh: () => Promise<void>;
  readonly events: EventHub;
  readonly boardThresholdsConfigStore: BoardThresholdsConfigPort;
  readonly hygieneThresholdsConfigStore: HygieneThresholdsConfigPort;
  readonly sessions?: () => readonly AgentSession[];
  readonly links?: () => readonly SessionLink[];
  readonly commentReader?: CommentReader;
  readonly prStatusReader?: PrStatusReader;
  readonly processScanner?: ProcessScanner;
  readonly humanDecisions?: HumanDecisionsPort;
  readonly worktreeScanner?: WorktreeScanner;
  readonly issueWriter?: IssueWriterPort;
  readonly dependencyWriter?: DependencyWriterPort;
  readonly sessionLinkWriter?: SessionLinkWriterPort;
  readonly sessionTail?: SessionTailReader;
  readonly writeAccess?: WriteGuardDeps;
  readonly leaseReader?: LeaseReader;
  readonly mergeSlotReader?: MergeSlotReader;
  readonly reclaimScheduler?: ReclaimScheduler;
}

export function buildApiDeps(params: BuildApiDepsParams): ApiDeps {
  const {
    boardThresholdsConfigStore,
    hygieneThresholdsConfigStore,
    ...rest
  } = params;

  return {
    ...rest,
    getBoardThresholds: async () =>
      resolveBoardThresholds(await boardThresholdsConfigStore.read()),
    getHygieneThresholds: async () =>
      resolveHygieneThresholds(await hygieneThresholdsConfigStore.read()),
  };
}
