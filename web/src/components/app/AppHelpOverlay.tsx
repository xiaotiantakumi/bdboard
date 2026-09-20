import { ErrorBoundary } from '../ErrorBoundary';
import { HelpPanel } from '../HelpPanel';

/**
 * bdboard-sso1.13: App.tsx から状態を持たない表示部分だけを移動したもの。
 * 開閉状態は App 側が state で持ち続け、ここには props としてのみ渡す。
 */
export interface AppHelpOverlayProps {
  open: boolean;
  onClose: () => void;
}

export function AppHelpOverlay({ open, onClose }: AppHelpOverlayProps) {
  if (!open) {
    return null;
  }

  return (
    <ErrorBoundary label="ヘルプ" resetLabel="閉じる" onReset={onClose} overlay>
      <HelpPanel onClose={onClose} />
    </ErrorBoundary>
  );
}
