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
import { serverEnvInfo } from './wire-issue-draft-service.js';

export interface WireSelfErrorReporterDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly service: Pick<IssueDraftService, 'receive'>;
  readonly cache: Pick<BoardCache, 'listProjects' | 'listProjectRefs'>;
  readonly applicationVersion: ApplicationVersionProvider;
  readonly now?: () => Date;
  readonly log?: (message: string) => void;
}
export interface WiredSelfErrorReporter {
  /** 止めている (BDBOARD_SELF_ERROR_DRAFTS=off) ときは undefined。 */
  readonly reporter: SelfErrorReporter | undefined;
  /** wireBoardLifecycle の onRefreshResult にそのまま渡す。同期で、投げず、完了を待たない。止めているときは undefined (observer も作られない)。 */
  readonly onRefreshResult: ((result: RefreshResult, projects: readonly Project[]) => void) | undefined;
}

/**
 * BDBOARD_SELF_ERROR_DRAFTS の解釈 (U6)。既存の envBoolDefaultTrue は `0` / `false` だけを止める値とし、前後の空白も見ないが、
 * この設定は ticket の約束どおり `off` も止める値にするので、同じ helper は使わず、ここで解釈する (起動時に 1 回だけ読む。変えたら再起動が要る)。
 */
function selfErrorDraftsDisabled(env: NodeJS.ProcessEnv): boolean {
  return ['off', '0', 'false'].includes((env.BDBOARD_SELF_ERROR_DRAFTS ?? '').trim().toLowerCase());
}

export function wireSelfErrorReporter(deps: WireSelfErrorReporterDeps): WiredSelfErrorReporter {
  const log = deps.log ?? console.error;
  if (selfErrorDraftsDisabled(deps.env)) {
    log('Self error drafts: disabled (BDBOARD_SELF_ERROR_DRAFTS)');
    return { reporter: undefined, onRefreshResult: undefined };
  }
  const reporter = createSelfErrorReporter({
    service: deps.service,
    throttle: createSelfErrorThrottle(),
    listProjects: () => readProjectRefs(deps.cache),
    envInfo: serverEnvInfo(deps.applicationVersion),
    log,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
  return {
    reporter,
    onRefreshResult: (result, projects) => {
      // observeRefresh は reject しない約束だが、catch の中の log が投げた場合の未処理の reject でプロセスを落とさないための防御。
      void reporter.observeRefresh(result, projects).catch(() => undefined);
    },
  };
}
