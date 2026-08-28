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
  // 負値や NaN (BDBOARD_UPDATE_CHECK_CACHE_MS の設定ミス) をそのまま使うと鮮度判定が
  // 常に false になり、リクエストのたびに GitHub を叩いて未認証の 60 req/h に当たる。
  // 0 に丸めても同じことになるので、意味を成さない値は「未指定」とみなして既定へ
  // 戻す。チェックを止めたいときは enabled:false が正規の手段
  // (PR#112 fable レビュー nit)。
  const requestedTtlMs = deps.ttlMs;
  const ttlMs =
    requestedTtlMs === undefined || !Number.isFinite(requestedTtlMs) || requestedTtlMs < 0
      ? DEFAULT_TTL_MS
      : requestedTtlMs;
  const enabled = deps.enabled ?? true;

  let cached: { readonly state: UpdateCheck; readonly cachedAt: number } | null = null;
  // 同時に複数リクエストが来ても外部への問い合わせは1回にまとめる。
  let inFlight: Promise<UpdateCheck> | null = null;

  const readFresh = (): UpdateCheck | null => {
    const snapshot = cached;
    if (snapshot === null) return null;
    return deps.now().getTime() - snapshot.cachedAt < ttlMs ? snapshot.state : null;
  };

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

      const fresh = readFresh();
      if (fresh !== null) {
        return fresh;
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
