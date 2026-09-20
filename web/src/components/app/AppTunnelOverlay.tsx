import { ErrorBoundary } from '../ErrorBoundary';
import { TunnelControl } from '../TunnelControl';

/**
 * bdboard-sso1.13: App.tsx から状態を持たない表示部分だけを移動したもの。
 * TunnelControl は閉じていても常時マウントされている (中で null を返す)。
 * 閉じている間の throw まで overlay で覆うと、何も開いていないのに暗幕が
 * 残って操作不能になるので、overlay は開いているときだけ。開閉状態は App 側が
 * state で持ち続け、ここには props としてのみ渡す(挙動は一切変えていない)。
 */
export interface AppTunnelOverlayProps {
  open: boolean;
  onClose: () => void;
}

export function AppTunnelOverlay({ open, onClose }: AppTunnelOverlayProps) {
  return (
    <ErrorBoundary label="トンネル" resetLabel="閉じる" onReset={onClose} overlay={open}>
      <TunnelControl open={open} onClose={onClose} />
    </ErrorBoundary>
  );
}
