// bdboard-sso1.38: SessionListPanel.tsx の3タブ切替トグルを、JSX/DOM を変えずに
// この表示部品へ移した。state は親のまま(tab は親の useState)、切替は
// onChangeTab 経由で親の setTab をそのまま呼ぶ。
import type { SessionListTab } from './sessionListHelpers';

interface SessionListTabBarProps {
  tab: SessionListTab;
  onChangeTab: (tab: SessionListTab) => void;
}

export function SessionListTabBar({ tab, onChangeTab }: SessionListTabBarProps) {
  return (
    <div className="session-list-tabs">
      <div className="toggle-group">
        <button
          type="button"
          className={`toggle-btn${tab === 'active' ? ' active' : ''}`}
          onClick={() => onChangeTab('active')}
        >
          稼働中
        </button>
        <button
          type="button"
          className={`toggle-btn${tab === 'ended' ? ' active' : ''}`}
          onClick={() => onChangeTab('ended')}
        >
          終了
        </button>
        <button
          type="button"
          className={`toggle-btn${tab === 'processes' ? ' active' : ''}`}
          onClick={() => onChangeTab('processes')}
        >
          プロセス
        </button>
      </div>
    </div>
  );
}
