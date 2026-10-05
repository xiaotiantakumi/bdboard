/** bdboard-4y8q.6.3: 本体エラー reporter と refresh callback を組み立てる。 */
import type { RefreshResult } from '../application/board/refresh-projects.js';
import { readProjectRefs } from '../application/board/read-cached-projects.js';
import { createSelfErrorReporter } from '../application/issue-report/self-error-reporter.js';
import type { SelfErrorReporter } from '../application/issue-report/self-error-reporter.js';
import type { BoardCache } from '../application/ports/board-cache.js';
import type { IssueDraftService } from '../application/issue-report/issue-draft-service.js';
import type { Project } from '../domain/project.js';
import { createSelfErrorThrottle } from '../domain/self-error-throttle.js';
import type { ApplicationVersionProvider } from '../application/ports/application-version.js';

export interface WireSelfErrorReporterDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly service: Pick<IssueDraftService, 'receive'>;
  readonly cache: Pick<BoardCache, 'listProjects' | 'listProjectRefs'>;
  readonly applicationVersion: ApplicationVersionProvider;
  readonly now?: () => Date;
  readonly log?: (message: string) => void;
}
export interface WiredSelfErrorReporter {
  readonly reporter: SelfErrorReporter;
  readonly onRefreshResult: (result: RefreshResult, projects: readonly Project[]) => void;
}

export function wireSelfErrorReporter(deps: WireSelfErrorReporterDeps): WiredSelfErrorReporter {
  const log = deps.log ?? console.error;
  const disabled = ['off', '0', 'false'].includes((deps.env.BDBOARD_SELF_ERROR_DRAFTS ?? '').trim().toLowerCase());
  const reporter = createSelfErrorReporter({
    service: deps.service, throttle: createSelfErrorThrottle(),
    listProjects: () => readProjectRefs(deps.cache),
    envInfo: () => ({ bdboardVersion: deps.applicationVersion.getVersion(), os: process.platform, nodeVersion: process.version }),
    log, ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
  if (disabled) {
    log('Self error drafts: disabled (BDBOARD_SELF_ERROR_DRAFTS)');
    return {
      reporter: { report: async () => undefined, observeRefresh: async () => undefined },
      onRefreshResult: () => undefined,
    };
  }
  return {
    reporter,
    onRefreshResult: (result, projects) => {
      void reporter.observeRefresh(result, projects).catch(() => undefined);
    },
  };
}
