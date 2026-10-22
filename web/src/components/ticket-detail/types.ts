// bdboard-sso1.5: TicketDetailPanel.tsx から純粋な型・定数を移動しただけのファイル。
// 挙動は一切変えていない。
import type {
  PendingDecisionDto,
  PrBadgeDto,
  TicketDecisionOutcome,
} from '../../api';

export interface TicketDetailPanelProps {
  ticketId: string;
  /**
   * projectId -> project root path. The panel resolves the path from the loaded
   * ticket's own projectId rather than from the board, so the generated
   * commands keep their `-C` even for tickets that are not on the board
   * (a parent or blocker outside the current filter, for instance).
   */
  projectRootPaths: ReadonlyMap<string, string>;
  pendingDecision: PendingDecisionDto | undefined;
  prLink?: PrBadgeDto;
  onClose: () => void;
  onChatAboutTicket?: (ctx: { projectId: string; ticketId: string }) => void;
  onOpenTicket: (ticketId: string) => void;
  /**
   * 最大化中か (bdboard-0hcx)。state は App 側が持つ。
   *
   * このコンポーネントで useState すると、AppTicketDetailOverlay
   * (web/src/components/app/AppTicketDetailOverlay.tsx、旧: App.tsx) 内の
   * ErrorBoundary が key={selectedTicketId} を持つためチケットを1つたどるたびに
   * unmount/remount され、最大化が毎回解除される。ChatPanel 側の
   * ErrorBoundary には key が無いので同じ書き方で問題にならないが、詳細パネルは
   * 「盤面のカードを次々開く」使い方をするので寿命がまったく違う
   * (PR#242 opus レビュー major-1)。
   */
  isMaximized: boolean;
  onToggleMaximized: () => void;
  /**
   * 詳細パネル内で1つ前のチケットへ戻る (bdboard-4ql7)。
   * 戻り先が無いときは undefined — ボタン自体を出さない。
   */
  onBackTicket?: (() => void) | undefined;
  isTicketOnBoard: (ticketId: string) => boolean;
  onFilterByEpic: (ticketId: string) => void;
  onTicketViewed?: (entry: { id: string; title: string; projectId: string }) => void;
  availableLabels?: readonly string[];
}

export type SubmittedDecision = {
  decisionId: string;
  choiceLabel?: string;
  freeform?: string;
  outcome: TicketDecisionOutcome;
};
