// bdboard-sso1.12: dto.ts のモジュール分割。PR バッジの DTO。
// pr-links-routes.ts が参照する (barrel 経由)。stale lease・回収スケジューラ・merge-slot
// の DTO は /api/lease-health・/api/merge-slot-status とともに bdboard-i9g4.7 で撤去した。
import type { PrBadge } from '../../../domain/pr-link.js';

export interface PrBadgeDto {
  ticketId: string;
  projectId: string;
  /** null は「時間予算内にコメント走査が完了しなかった」ことを表す (bdboard-3znc)。 */
  url: string | null;
  state: string | null;
  checkStatus: string | null;
}

export function toPrBadgeDto(badge: PrBadge): PrBadgeDto {
  return {
    ticketId: badge.ticketId,
    projectId: badge.projectId,
    url: badge.url,
    state: badge.status?.state ?? null,
    checkStatus: badge.status?.checkStatus ?? null,
  };
}
