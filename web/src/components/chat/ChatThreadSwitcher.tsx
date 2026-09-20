interface ChatThreadSwitcherProps {
  threadDrawerOpen: boolean;
  onToggleDrawer: () => void;
  currentThreadTitle: string;
  openThreadsCount: number;
  onNewThread: () => void;
  hasNoDisplayedOpenThreads: boolean;
  hasClosedThreads: boolean;
}

/**
 * Chat Redesign 1b: タブ帯を「現在のスレッド名+件数」ボタン1つに圧縮し、
 * 押すと縦一覧ドロワーがかぶさる形に置き換えた。個別のリネーム/ピン留め/
 * タブから閉じる/削除は各行の「⋯」メニューへ集約し(旧: 選択中タブにだけ
 * 並んでいたボタン列)、ピン留め/開いている/閉じた/外部CLIセッションの
 * 3+1種類を見出しで言葉として示す。
 * チャット設定(details)の外に置く: details の body は閉じている間も
 * 常にレンダリングされる既存バグ(chat-panel-settings-body に
 * display:flex を無条件付与しており、UA既定の details:not([open])
 * > :not(summary){display:none} を上書きしてしまう)があり、この中に
 * 置くと chat-messages と座標が重なってクリックを奪われる
 * (bdboard-wkl で発見)。スレッド切替は常時表示すべき主導線でもあるため、
 * details の外側に出す。
 */
export function ChatThreadSwitcher({
  threadDrawerOpen,
  onToggleDrawer,
  currentThreadTitle,
  openThreadsCount,
  onNewThread,
  hasNoDisplayedOpenThreads,
  hasClosedThreads,
}: ChatThreadSwitcherProps) {
  return (
    <>
      <div className="chat-thread-switcher">
        <button
          type="button"
          className="chat-thread-switcher-toggle"
          aria-haspopup="dialog"
          aria-expanded={threadDrawerOpen}
          aria-controls="chat-thread-drawer"
          onClick={onToggleDrawer}
        >
          <span className="chat-thread-switcher-icon" aria-hidden="true">☰</span>
          <span className="chat-thread-switcher-title">{currentThreadTitle}</span>
          <span className="chat-thread-switcher-count">スレッド {openThreadsCount}</span>
        </button>
        <button
          type="button"
          className="btn chat-thread-new"
          aria-label="新しい空のスレッドを開始"
          title="新しい空のスレッドを開始します(今開いているスレッドはそのまま残ります)"
          onClick={onNewThread}
        >
          + 新規スレッド
        </button>
      </div>
      {hasNoDisplayedOpenThreads && (
        <p className="chat-thread-empty-hint" role="status">
          {hasClosedThreads
            ? '開いているスレッドはありません。「+ 新規スレッド」で新しく始めるか、スレッド一覧の「閉じたスレッド」から再開できます。'
            : '開いているスレッドはありません。「+ 新規スレッド」で新しく始めてください。'}
        </p>
      )}
    </>
  );
}
