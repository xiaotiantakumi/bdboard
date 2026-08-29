import type { AiQuotaProviderSnapshot, AiQuotaSource } from '../ports/ai-quota-source.js';

export type AiQuotaState =
  | { readonly kind: 'ok'; readonly fetchedAt: Date; readonly providers: readonly AiQuotaProviderSnapshot[] }
  | { readonly kind: 'error'; readonly message: string };

export interface AiQuotaServiceDeps {
  readonly source: AiQuotaSource;
  readonly now: () => Date;
  /** キャッシュのTTL。既定5分: `ai-quota`は毎回数秒〜十数秒かかるpty経由の実行なので、
   *  ヘッダウィジェットの表示のたびに叩かない。 */
  readonly ttlMs?: number;
}

export interface AiQuotaService {
  /** キャッシュがあれば再利用し、無ければ`ai-quota`を実行して取得する。例外は投げず、
   *  失敗時は`{ kind: 'error' }`を返す(呼び出し側=interface層はこれをそのままJSONにできる)。 */
  getSnapshot(): Promise<AiQuotaState>;
  /** キャッシュがあればそれを返し、無ければ`null`を返す。`ai-quota`の実行(pty経由で
   *  数十秒かかり得るprobe)は一切起動しない。SSE購読者がいない間の閾値チェックのように
   *  「新鮮さより実プローブを起動しないこと」を優先したい呼び出し元向け。 */
  peekSnapshot(): AiQuotaState | null;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createAiQuotaService(deps: AiQuotaServiceDeps): AiQuotaService {
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;

  let cached: { readonly state: AiQuotaState; readonly cachedAt: number } | null = null;
  // 同時に複数リクエストが来てもai-quotaの実行は1回にまとめる(pty起動は重いため)。
  let inFlight: Promise<AiQuotaState> | null = null;

  const isFresh = (): boolean =>
    cached !== null && deps.now().getTime() - cached.cachedAt < ttlMs;

  const fetchFresh = async (): Promise<AiQuotaState> => {
    try {
      const result = await deps.source.fetch();
      const state: AiQuotaState = {
        kind: 'ok',
        fetchedAt: result.fetchedAt,
        providers: result.providers,
      };
      cached = { state, cachedAt: deps.now().getTime() };
      return state;
    } catch (err) {
      const state: AiQuotaState = { kind: 'error', message: errorMessage(err) };
      // 失敗も同じTTLでキャッシュする。ai-quotaが無い/壊れている環境で毎リクエスト
      // (pty起動の分だけ)待たせないため。
      cached = { state, cachedAt: deps.now().getTime() };
      return state;
    }
  };

  return {
    async getSnapshot(): Promise<AiQuotaState> {
      if (isFresh()) {
        // isFresh() ensures cached !== null
        return (cached as { readonly state: AiQuotaState }).state;
      }

      if (inFlight !== null) {
        return inFlight;
      }

      inFlight = fetchFresh().finally(() => {
        inFlight = null;
      });

      return inFlight;
    },

    peekSnapshot(): AiQuotaState | null {
      return cached ? cached.state : null;
    },
  };
}
