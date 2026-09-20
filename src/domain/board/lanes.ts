import type { Lane } from '../readiness.js';
import type { Board, BoardCard } from './types.js';

export function buildLanes(cards: readonly BoardCard[]): Board['lanes'] {
  const lanes: Record<Lane, BoardCard[]> = {
    ready: [],
    in_progress: [],
    awaiting_human: [],
    blocked: [],
    done: [],
  };

  for (const card of cards) {
    lanes[card.lane].push(card);
  }

  // bdboard-662: 保留(deferred)はブロックへ表示統合された。統合後の blocked レーンは
  // 依存関係でブロックされているチケットと保留チケットが混在するため、他のレーンと同様
  // compareCards(優先度ベース)の順序をそのまま使う。保留固有の「締切が近い順」ソートは
  // 廃止した(deferDays/deferUrgency のカード表示自体は buildBoard 側で維持している)。

  return lanes;
}
