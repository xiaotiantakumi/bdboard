/** bdboard-4y8q.6.3: リフレッシュ失敗をローカルの本体エラー下書きへ送る。 */
import type { DraftEnvInfo } from '../../domain/issue-draft.js';
import { createRefreshErrorTracker, selfErrorKey } from '../../domain/refresh-error-tracker.js';
import type { RefreshErrorInput, RefreshErrorProject, SelfErrorReport } from '../../domain/refresh-error-tracker.js';
import { createSelfErrorMasker } from '../../domain/self-error-mask.js';
import type { SelfErrorThrottle } from '../../domain/self-error-throttle.js';
import type { IssueDraftService } from './issue-draft-service.js';

export interface SelfErrorReportInput {
  readonly source: string;
  readonly errorText: string;
  readonly agentNote?: string;
  readonly project?: { readonly name: string; readonly path: string };
}
export interface SelfErrorReporterDeps {
  readonly service: Pick<IssueDraftService, 'receive'>;
  readonly throttle: SelfErrorThrottle;
  readonly listProjects: () => readonly RefreshErrorProject[];
  readonly envInfo: () => Partial<DraftEnvInfo>;
  readonly log: (message: string) => void;
  readonly now?: () => Date;
}
export interface SelfErrorReporter {
  report(input: SelfErrorReportInput): Promise<void>;
  observeRefresh(result: RefreshErrorInput, projects: readonly RefreshErrorProject[]): Promise<void>;
}

function safeCode(error: unknown): string {
  const code = (error as { readonly code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(code) ? code : 'unknown';
}

export function createSelfErrorReporter(deps: SelfErrorReporterDeps): SelfErrorReporter {
  const now = deps.now ?? (() => new Date());
  const tracker = createRefreshErrorTracker({ throttle: deps.throttle });

  async function receive(input: SelfErrorReportInput, envInfo?: Partial<DraftEnvInfo>): Promise<void> {
    try {
      const result = await deps.service.receive({
        kind: 'C', source: input.source, errorText: input.errorText,
        ...(input.agentNote !== undefined ? { agentNote: input.agentNote } : {}),
        envInfo: envInfo ?? deps.envInfo(), ...(input.project !== undefined ? { project: input.project } : {}),
      });
      if (!result.ok) deps.log(`self error draft not saved (${result.reason})`);
    } catch (error) {
      deps.log(`self error draft failed (${safeCode(error)})`);
    }
  }

  return {
    async report(input) {
      try {
        const mask = createSelfErrorMasker(deps.listProjects());
        const currentEnv = deps.envInfo();
        const errorText = mask(input.errorText);
        const agentNote = input.agentNote === undefined ? undefined : mask(input.agentNote);
        if (!deps.throttle.shouldReport(selfErrorKey(input.source, errorText), now())) return;
        await receive({ ...input, errorText, ...(agentNote !== undefined ? { agentNote } : {}) }, currentEnv);
      } catch (error) {
        deps.log(`self error draft failed (${safeCode(error)})`);
      }
    },
    observeRefresh(result, projects) {
      let reports: readonly SelfErrorReport[];
      try {
        reports = tracker.observe(result, projects, now());
        const tasks = reports.map(async (item) => receive(item));
        return Promise.all(tasks).then(() => undefined);
      } catch (error) {
        deps.log(`self error draft failed (${safeCode(error)})`);
        return Promise.resolve();
      }
    },
  };
}
