import { ErrorBoundary } from '../ErrorBoundary';
import { KeyboardShortcutsPanel } from '../KeyboardShortcutsPanel';

/**
 * bdboard-sso1.13: App.tsx から状態を持たない表示部分だけを移動したもの。
 * 開閉状態は App 側が state で持ち続け、ここには props としてのみ渡す。
 */
export interface AppShortcutsOverlayProps {
  open: boolean;
  onClose: () => void;
}

export function AppShortcutsOverlay({ open, onClose }: AppShortcutsOverlayProps) {
  if (!open) {
    return null;
  }

  return (
    <ErrorBoundary label="ショートカット一覧" resetLabel="閉じる" onReset={onClose} overlay>
      <KeyboardShortcutsPanel onClose={onClose} />
    </ErrorBoundary>
  );
}
