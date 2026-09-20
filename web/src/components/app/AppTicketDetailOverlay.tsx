import { ErrorBoundary } from '../ErrorBoundary';
import { TicketDetailPanel } from '../TicketDetailPanel';
import type { TicketDetailPanelProps } from '../ticket-detail/types';

/**
 * bdboard-sso1.13: App.tsx から状態を持たない表示部分だけを移動したもの。
 * `selectedTicketId` は App 側が state (useTicketDeepLink) で持ち続け、ここには
 * props としてのみ渡す。ErrorBoundary の `key={selectedTicketId}` は App.tsx で
 * 元々この位置にあったものをそのまま維持している — チケットを1つたどるたびに
 * remount させ、詳細パネル内部 state をリセットするための意図的な仕組み
 * (bdboard-0hcx, PR#242 opus レビュー major-1)。挙動は一切変えていない。
 */
export interface AppTicketDetailOverlayProps
  extends Omit<TicketDetailPanelProps, 'ticketId'> {
  selectedTicketId: string | null;
}

export function AppTicketDetailOverlay({
  selectedTicketId,
  ...panelProps
}: AppTicketDetailOverlayProps) {
  if (selectedTicketId === null) {
    return null;
  }

  return (
    <ErrorBoundary
      key={selectedTicketId}
      label="チケット詳細"
      resetLabel="閉じる"
      onReset={panelProps.onClose}
      overlay
    >
      <TicketDetailPanel ticketId={selectedTicketId} {...panelProps} />
    </ErrorBoundary>
  );
}
