import type { BoardCardDto, Lane, PrBadgeDto } from '../../api';
import type { CardNavProps } from '../BoardKeyboardNavProvider';

export interface CardItemProps {
  card: BoardCardDto;
  lane: Lane;
  showProjectName: boolean;
  projectName: string;
  activeSessionCount: number;
  hasPendingDecision: boolean;
  prLink?: PrBadgeDto;
  onClick: (ticketId: string) => void;
  enableDrag?: boolean;
  nav?: CardNavProps;
}

export interface LaneColumnProps {
  lane: Lane;
  cards: BoardCardDto[];
  /** stalledOnly 適用後・board filter 適用前の件数(filtered/total 表示用) */
  unfilteredCount?: number;
  showProjectName: boolean;
  projectNames: Map<string, string>;
  projectActiveSessions: Map<string, number>;
  pendingDecisionIds: ReadonlySet<string>;
  prLinksById: ReadonlyMap<string, PrBadgeDto>;
  onCardClick: (ticketId: string) => void;
  /**
   * サーバー側のclosedLimitで切り捨てられ、このレーンに一切届いていないカード数
   * (doneレーンのみ意味を持つ; bdboard-3tw.86)。0またはundefinedなら非表示。
   */
  hiddenCount?: number;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  /** in_progress レーンの WIP 状態。exceeded 時にヘッダー警告を表示する。 */
  wipStatus?: { limit: number; count: number; exceeded: boolean };
}
