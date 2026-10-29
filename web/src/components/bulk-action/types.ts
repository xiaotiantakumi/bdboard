import type { BoardCardDto } from '../../api';

export interface BulkActionBarProps {
  cardsById: ReadonlyMap<string, BoardCardDto>;
  /** 確認待ち(質問あり)のチケット ID。ここに含まれるチケットには回答として送る */
  pendingDecisionIds: ReadonlySet<string>;
}
