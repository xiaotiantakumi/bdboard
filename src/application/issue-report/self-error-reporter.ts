/** bdboard-4y8q.6.3: リフレッシュ失敗をローカルの本体エラー下書きへ送る。4y8q.6.4: API の 5xx・処理されなかった例外 (`report()`) も同じ間引きを通す。 */
import type { DraftEnvInfo } from '../../domain/issue-draft.js';
import { createRefreshErrorTracker, selfErrorKey } from '../../domain/refresh-error-tracker.js';
import type { RefreshErrorInput, RefreshErrorProject, SelfErrorReport } from '../../domain/refresh-error-tracker.js';
import { createSelfErrorMasker } from '../../domain/self-error-mask.js';
import { isReportableSelfErrorSource } from '../../domain/self-error-source.js';
import type { SelfErrorApiSource } from '../../domain/self-error-source.js';
import type { SelfErrorThrottle } from '../../domain/self-error-throttle.js';
import type { IssueDraftService } from './issue-draft-service.js';

export interface SelfErrorReportInput {
  /** 閉じた語彙 (self-error-source.ts)。型で `api:…` に絞り、`report()` が実行時にも形を検査する (形が合わなければ送らない)。 */
  readonly source: SelfErrorApiSource;
  readonly errorText: string;
  readonly agentNote?: string;
  readonly project?: { readonly name: string; readonly path: string };
}
/**
 * `report()` の結果。`recorded`: 下書きに保存した (新規・統合・大量発生への丸め込みのどれでも)。`throttled`: 同じ出どころ・同じエラー文を
 * 1 時間以内に報告済みなので送らなかった (画面が二重に報告しなくてよい)。`skipped`: 形の合わない source・保存できなかった・内部の失敗。
 */
export type SelfErrorReportOutcome = 'recorded' | 'throttled' | 'skipped';
export interface SelfErrorReporterDeps {
  readonly service: Pick<IssueDraftService, 'receive'>;
  readonly throttle: SelfErrorThrottle;
  /** キャッシュの一覧。`report()` はこれに、直近の `observeRefresh` が受けた discovery の一覧を足して伏せる (一度もキャッシュに載らないプロジェクトの名前・パスも伏せるため)。 */
  readonly listProjects: () => readonly RefreshErrorProject[];
  readonly envInfo: () => Partial<DraftEnvInfo>;
  readonly log: (message: string) => void;
  readonly now?: () => Date;
}
export interface SelfErrorReporter {
  report(input: SelfErrorReportInput): Promise<SelfErrorReportOutcome>;
  observeRefresh(result: RefreshErrorInput, projects: readonly RefreshErrorProject[]): Promise<void>;
}

function safeCode(error: unknown): string {
  const code = (error as { readonly code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(code) ? code : 'unknown';
}

/** tracker の報告 (`bd-refresh:<kind>`) と `report()` の入力 (`api:…`) の両方を受ける内部の形。 */
type ReceiveInput = Omit<SelfErrorReportInput, 'source'> & { readonly source: string };

export function createSelfErrorReporter(deps: SelfErrorReporterDeps): SelfErrorReporter {
  const now = deps.now ?? (() => new Date());
  const tracker = createRefreshErrorTracker({ throttle: deps.throttle });
  // 直近の observeRefresh が受けた discovery の一覧 (接頭辞はキャッシュのもの)。report() が伏せるときに、キャッシュの一覧へ足す。
  let observedProjects: readonly RefreshErrorProject[] = [];

  /** 保存できたら true。保存できなかったときはログに code だけ出す。 */
  async function receive(input: ReceiveInput, envInfo?: Partial<DraftEnvInfo>): Promise<boolean> {
    try {
      const result = await deps.service.receive({
        kind: 'C', source: input.source, errorText: input.errorText,
        ...(input.agentNote !== undefined ? { agentNote: input.agentNote } : {}),
        envInfo: envInfo ?? deps.envInfo(), ...(input.project !== undefined ? { project: input.project } : {}),
      });
      if (!result.ok) deps.log(`self error draft not saved (${result.reason})`);
      return result.ok;
    } catch (error) {
      deps.log(`self error draft failed (${safeCode(error)})`);
      return false;
    }
  }

  return {
    async report(input) {
      try {
        // 形の合わない source は伏せも間引きもせずに捨てる (指紋と題名に入るので、閉じた語彙だけ通す)。メッセージに source は入れない。
        if (!isReportableSelfErrorSource(input.source)) {
          deps.log('self error draft rejected (invalid source)');
          return 'skipped';
        }
        // discovery の一覧を足す: キャッシュにだけ頼ると、一度もキャッシュに載らないプロジェクトの名前・パスが伏せられない (6.3 の tracker と同じ理由)。
        const mask = createSelfErrorMasker([...observedProjects, ...deps.listProjects()]);
        const currentEnv = deps.envInfo();
        const errorText = mask(input.errorText);
        const agentNote = input.agentNote === undefined ? undefined : mask(input.agentNote);
        if (!deps.throttle.shouldReport(selfErrorKey(input.source, errorText), now())) return 'throttled';
        const saved = await receive({ ...input, errorText, ...(agentNote !== undefined ? { agentNote } : {}) }, currentEnv);
        return saved ? 'recorded' : 'skipped';
      } catch (error) {
        deps.log(`self error draft failed (${safeCode(error)})`);
        return 'skipped';
      }
    },
    observeRefresh(result, projects) {
      let reports: readonly SelfErrorReport[];
      try {
        observedProjects = projects;
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
