import { ErrorBoundary } from '../ErrorBoundary';
import { SessionListPanel } from '../SessionListPanel';

/**
 * bdboard-sso1.13: App.tsx から状態を持たない表示部分だけを移動したもの。
 * 開閉状態は App 側が state で持ち続け、ここには props としてのみ渡す。
 */
export interface AppSessionListOverlayProps {
  open: boolean;
  projectId: string | undefined;
  onClose: () => void;
}

export function AppSessionListOverlay({
  open,
  projectId,
  onClose,
}: AppSessionListOverlayProps) {
  if (!open) {
    return null;
  }

  return (
    <ErrorBoundary label="セッション一覧" resetLabel="閉じる" onReset={onClose} overlay>
      <SessionListPanel projectId={projectId} onClose={onClose} />
    </ErrorBoundary>
  );
}
