import { evaluateUpdateCheck, type UpdateCheck } from '../../domain/update-check.js';
import type { ApplicationVersionProvider } from '../ports/application-version.js';
import type { ReleaseSource } from '../ports/release-source.js';

export interface UpdateCheckServiceDeps {
  readonly applicationVersion: ApplicationVersionProvider;
  readonly source: ReleaseSource;
  readonly now: () => Date;
  /** キャッシュ TTL。既定6時間。GitHub の未認証 API は IP あたり 60 req/h なので、
   *  これ以上の頻度で叩く理由が無い。 */
  readonly ttlMs?: number;
  /** false のとき一切ネットワークへ出ず、常に `unknown` を返す。 */
  readonly enabled?: boolean;
}

export interface UpdateCheckService {
  /** 例外は投げない。取得できなければ `{ kind: 'unknown' }`。 */
  getUpdateCheck(): Promise<UpdateCheck>;
}

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

export function createUpdateCheckService(deps: UpdateCheckServiceDeps): UpdateCheckService {
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const enabled = deps.enabled ?? true;

  let cached: { readonly state: UpdateCheck; readonly cachedAt: number } | null = null;
  // 同時に複数リクエストが来ても外部への問い合わせは1回にまとめる。
  let inFlight: Promise<UpdateCheck> | null = null;

  const isFresh = (): boolean =>
    cached !== null && deps.now().getTime() - cached.cachedAt < ttlMs;

  const fetchFresh = async (): Promise<UpdateCheck> => {
    const currentVersion = deps.applicationVersion.getVersion();
    let state: UpdateCheck;
    try {
      state = evaluateUpdateCheck(currentVersion, await deps.source.fetchLatest());
    } catch {
      // source 側が握り潰し損ねた例外もここで吸収する。起動やヘルプ表示が
      // 外部サービスの都合で壊れてはいけない (src/main.ts の bd バージョン
      // チェックと同じ思想)。
      state = { kind: 'unknown', currentVersion };
    }
    // 失敗も同じ TTL でキャッシュする。オフライン環境で毎リクエスト
    // タイムアウト分待たせないため。
    cached = { state, cachedAt: deps.now().getTime() };
    return state;
  };

  return {
    async getUpdateCheck(): Promise<UpdateCheck> {
      if (!enabled) {
        return { kind: 'unknown', currentVersion: deps.applicationVersion.getVersion() };
      }

      if (isFresh()) {
        return (cached as { readonly state: UpdateCheck }).state;
      }

      if (inFlight !== null) {
        return inFlight;
      }

      inFlight = fetchFresh().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}
