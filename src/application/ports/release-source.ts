import type { LatestRelease } from '../../domain/update-check.js';

/**
 * 公開されている最新リリースの取得元 (bdboard-70z.7)。
 * 実装は infrastructure 側 (GitHub Releases API)。
 */
export interface ReleaseSource {
  /**
   * 取得できなければ `null` を返す。ネットワーク障害・オフライン・レート制限・
   * リリースがまだ1本も無い、のいずれも `null` に潰す — 呼び出し側から見て
   * 「分からない」以上の意味は無いため。
   */
  fetchLatest(): Promise<LatestRelease | null>;
}
