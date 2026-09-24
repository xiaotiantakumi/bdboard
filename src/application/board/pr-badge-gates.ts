import { Semaphore } from '../concurrency.js';

/**
 * commentGate/statusGate — getPrBadges() のコメント取得 (bd 経由) とステータス取得
 * (gh 経由) それぞれの同時実行数を絞る Semaphore ペア。PrBadgeGates/createPrBadgeGates()
 * は bdboard-sgpa で新規追加したもの (main 上の既存コードの移動ではない)。
 * get-pr-badges.ts に直接書くと同ファイルの200行上限を超えるため、最初からこの
 * 独立ファイルとして実装した (opus レビュー指摘: 以前の「move only」というコメントは
 * main からの移動であるかのように読めて誤解を招くため訂正)。
 *
 * /api/pr-links のようにリクエストをまたいで呼び出される側は、createPrBadgeGates() を
 * ルート初期化時に一度だけ呼んで結果を GetPrBadgesOptions.gates として使い回すこと。
 * そうしないと、重なったリクエストそれぞれが独立した Semaphore を持ってしまい、意図した
 * 同時実行上限が「1リクエストあたり」にしか効かなくなる (重なったリクエストの数だけ
 * 実質的な gh/bd 起動数の上限が掛け算される — bdboard-sgpa)。
 */
export interface PrBadgeGates {
  readonly commentGate: Semaphore;
  readonly statusGate: Semaphore;
}

// Matches DEFAULT_CONCURRENCY in bd-cli-issue-repository.ts.
const COMMENT_FETCH_CONCURRENCY = 3;

// gh pr view (ステータス取得) 専用の既定並列数。GetPrBadgesOptions.statusFetchConcurrency
// の説明を参照 (bdboard-se3v)。
const DEFAULT_STATUS_FETCH_CONCURRENCY = 8;

/**
 * commentGate/statusGate を1組作る。/api/pr-links のようにリクエストをまたいで
 * 呼び出される側は、これをルート初期化時に一度だけ呼んで結果を GetPrBadgesOptions.gates
 * として使い回すこと (bdboard-sgpa)。
 */
export function createPrBadgeGates(options?: {
  readonly statusFetchConcurrency?: number;
}): PrBadgeGates {
  return {
    commentGate: new Semaphore(COMMENT_FETCH_CONCURRENCY),
    statusGate: new Semaphore(options?.statusFetchConcurrency ?? DEFAULT_STATUS_FETCH_CONCURRENCY),
  };
}
