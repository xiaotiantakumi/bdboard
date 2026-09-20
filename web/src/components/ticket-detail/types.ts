// bdboard-sso1.5: TicketDetailPanel.tsx から純粋な型・定数を移動しただけのファイル。
// 挙動は一切変えていない。
import type { BdCommandKind } from '../../bdCommands';
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
   * このコンポーネントで useState すると、App の ErrorBoundary が
   * key={selectedTicketId} を持つ (App.tsx) ためチケットを1つたどるたびに
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

/**
 * 「次に実行」のコピーは現在の run と履歴の run で別々に出るので、コピー完了
 * バッジもその 2 箇所を区別する (bdboard-pkr6.11)。
 */
export type NextStepCopyTarget = 'next-step-current' | 'next-step-history';

type CopyFeedback =
  | { kind: 'success'; command: BdCommandKind | NextStepCopyTarget }
  | { kind: 'error' };

/**
 * コピー結果の表示。ボタン脇のバッジ (feedback) と読み上げ (aria) は必ず一緒に
 * 出て一緒に消えるので、1つの値として useAutoClearedValue に持たせる
 * (bdboard-ty72)。別々の state にすると自動消去タイマーも2本になる。
 */
export interface CopyDisplay {
  readonly feedback: CopyFeedback | null;
  readonly aria: string;
}

export const EMPTY_COPY_DISPLAY: CopyDisplay = { feedback: null, aria: '' };

export type ConfirmingQuickAction =
  | { kind: 'claim' }
  | { kind: 'close' }
  | { kind: 'defer'; untilDate: string }
  | { kind: 'priority'; priority: number };

export type SubmittedDecision = {
  decisionId: string;
  choiceLabel?: string;
  freeform?: string;
  outcome: TicketDecisionOutcome;
};
