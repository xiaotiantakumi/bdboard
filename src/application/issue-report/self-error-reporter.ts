/**
 * bdboard-4y8q.6.3: リフレッシュ失敗をローカルの本体エラー下書きへ送る。4y8q.6.4: API の 5xx・処理されなかった例外 (`report()`) も同じ間引きを通す。
 *
 * bdboard-4y8q.6.10: 間引きの記録は「保存の前に取る」(同じキーが同時に来ても二重の下書きにしないため) が、保存に失敗したら**取り消す**。
 * 失敗した報告が 1 時間 `throttled` (= 報告済み) に見えて、下書きが 1 件もできないままになるのを避ける。
 * - `report()`: 同じキーの保存が終わらないうちにもう一度来たら、保存を重ねず 1 回目の結果を待つ (成功なら `throttled`、失敗なら `skipped`)。
 * - `observeRefresh()`: 記録は tracker (6.2) が聞いた時点で取る。保存に失敗した報告は `tracker.release(report)` で返す (キーを忘れさせ、
 *   kind の連続の回に出した報告なら、次にその kind が見えた結果を再び due にする。レビュー F1)。
 */
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
 * 1 時間以内に**保存できている** (保存中の同じキーの 1 回目が成功した場合を含む) ので送らなかった (画面が二重に報告しなくてよい)。
 * `skipped`: 形の合わない source・保存できなかった (保存中の同じキーの 1 回目が失敗した場合を含む。失敗は間引きの記録に残らず、次の `report()` が
 * もう一度保存を試みる)・内部の失敗。
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

/** 保存中の同じキーに合流した呼び出しの結果。1 回目が保存できたら `throttled`、できなかったら `skipped`。reporter の外で作る (入力を保持しないため)。 */
function joinedOutcome(inFlight: Promise<SelfErrorReportOutcome>): Promise<SelfErrorReportOutcome> {
  return inFlight.then((outcome) => (outcome === 'recorded' ? 'throttled' : 'skipped'), () => 'skipped');
}

export function createSelfErrorReporter(deps: SelfErrorReporterDeps): SelfErrorReporter {
  const now = deps.now ?? (() => new Date());
  const tracker = createRefreshErrorTracker({ throttle: deps.throttle });
  // 直近の observeRefresh が受けた discovery の一覧 (接頭辞はキャッシュのもの)。report() が伏せるときに、キャッシュの一覧へ足す。
  let observedProjects: readonly RefreshErrorProject[] = [];
  // 保存中の report() のキー → その結果。同じキーが保存の終わらないうちにもう一度来ても、保存を重ねない。終わったらすぐ消える (残らない)。
  const pendingByKey = new Map<string, Promise<SelfErrorReportOutcome>>();

  /**
   * 保存に失敗した報告の巻き戻し (次の同じ報告がもう一度 receive に届くように)。throw しない (巻き戻しの失敗はログに code だけ出す)。
   * `report()` の報告は throttle のキーを忘れる。リフレッシュの報告は tracker に返す (tracker が聞いたキーを忘れ、kind の連続で出した報告なら次の更新を再び due にする。
   * キーをここで作り直さない: tracker のキーの作り方と、due の理由は tracker だけが知っている)。
   */
  function undo(rewind: () => void): void {
    try {
      rewind();
    } catch (error) {
      deps.log(`self error draft failed (${safeCode(error)})`);
    }
  }

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
        const key = selfErrorKey(input.source, errorText);
        // 同じキーの保存が終わっていない: 二重の下書きにしない。1 回目の結果を待つ (成功ならもう保存できている = throttled。失敗なら何も保存していない = skipped で、
        // この呼び出しは保存を重ねない。同時に来た全員が失敗のたびに再試行して、壊れた保存先を押しつぶさないため。再試行は次の report())。
        const inFlight = pendingByKey.get(key);
        // await せず、外で作った then に渡す: 保存が終わらない間、合流した呼び出しが入力 (errorText は最大十数 KB) を抱えたまま待ち続けない
        // (ここで書いた矢印関数は、この関数の変数を使わなくても同じスコープの入力ごと保持する。V8 で確かめた)。
        if (inFlight !== undefined) return joinedOutcome(inFlight);
        // 記録は保存の前に取る (同じキーが同時に来ても、2 回目以降は上の待ちか、ここの false になる)。保存に失敗したら取り消す。
        if (!deps.throttle.shouldReport(key, now())) return 'throttled';
        // この async 関数は、最初の await (receive) より前に終わらないこと: 先に終わると finally の delete が下の set より先に走り、
        // 終わった試みの entry が残り続けて、このキーの report() がずっとそれに合流する (receive に二度と届かない)。
        const attempt = (async (): Promise<SelfErrorReportOutcome> => {
          try {
            const saved = await receive({ ...input, errorText, ...(agentNote !== undefined ? { agentNote } : {}) }, currentEnv);
            if (!saved) undo(() => { deps.throttle.forget(key); });
            return saved ? 'recorded' : 'skipped';
          } finally {
            // 結果を出す前に消す: 結果を見た呼び出しが、終わった保存にもう一度合流しない。
            pendingByKey.delete(key);
          }
        })();
        pendingByKey.set(key, attempt);
        return await attempt;
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
        // tracker は聞いた時点で throttle に記録している。保存に失敗した報告は tracker に返し、次の更新がもう一度 receive に届くようにする。
        const tasks = reports.map(async (item) => {
          if (!(await receive(item))) undo(() => { tracker.release(item); });
        });
        return Promise.all(tasks).then(() => undefined);
      } catch (error) {
        deps.log(`self error draft failed (${safeCode(error)})`);
        return Promise.resolve();
      }
    },
  };
}
