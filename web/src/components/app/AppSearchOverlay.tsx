import { ErrorBoundary } from '../ErrorBoundary';
import { SearchPalette } from '../SearchPalette';
import type { PaletteAction } from '../../paletteActions';
import type { RecentTicketEntry } from '../../uiPersistedState';

/**
 * bdboard-sso1.13: App.tsx から状態を持たない表示部分だけを移動したもの。
 * 開閉状態は App 側が state で持ち続け、ここには props としてのみ渡す。
 */
export interface AppSearchOverlayProps {
  open: boolean;
  onClose: () => void;
  onSelect: (ticketId: string) => void;
  actions: PaletteAction[];
  recentTickets?: RecentTicketEntry[];
}

export function AppSearchOverlay({
  open,
  onClose,
  onSelect,
  actions,
  recentTickets,
}: AppSearchOverlayProps) {
  if (!open) {
    return null;
  }

  return (
    <ErrorBoundary label="検索" resetLabel="閉じる" onReset={onClose} overlay>
      <SearchPalette
        onClose={onClose}
        onSelect={onSelect}
        actions={actions}
        recentTickets={recentTickets}
      />
    </ErrorBoundary>
  );
}
