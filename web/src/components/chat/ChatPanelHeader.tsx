import type { RefObject } from 'react';

/**
 * チャットパネルの見出し(タイトル + 最大化/縮小ボタン + 閉じるボタン)。
 *
 * bdboard-sso1.83 第7段: ChatPanel.tsx の `.detail-header` ブロックを
 * move-only で抽出した。状態(isChatPanelMaximized)とハンドラ(トグル・
 * requestClose)は ChatPanel 側に残り、このコンポーネントは props 経由で
 * 受け取って配線するだけ。closeButtonRef は ChatPanel の useRef と同一の
 * ものをそのまま渡す(新しい ref を作らない — panelRef に対する
 * useFocusTrap の initialFocusRef としてパネル表示時の初期フォーカス先に
 * 使われている同一性を崩さない。壊れた場合の回帰テストは
 * ChatPanel.panel-chrome.test.tsx の「focuses the header close button when
 * the panel opens」)。
 */
export interface ChatPanelHeaderProps {
  isMaximized: boolean;
  onToggleMaximize: () => void;
  closeButtonRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}

export function ChatPanelHeader({
  isMaximized,
  onToggleMaximize,
  closeButtonRef,
  onClose,
}: ChatPanelHeaderProps) {
  return (
    <div className="detail-header">
      <h2 id="chat-panel-title" className="detail-title">
        チャット
      </h2>
      {/* 見出しの操作は他パネル(チケット詳細/ヘルプ)と同じく
          .detail-header-actions にまとめる。.detail-header は
          justify-content: space-between なので、直下に3つ並べると
          「最大化」が見出しと「閉じる」の中間に浮いてしまう
          (PR#139 レビュー major-2)。 */}
      <div className="detail-header-actions">
        <button
          type="button"
          className="btn chat-panel-maximize"
          onClick={onToggleMaximize}
          title={isMaximized ? '元の幅に戻す' : '画面幅いっぱいに広げる'}
        >
          {/* aria-pressed は付けない (PR#139 レビュー minor-3)。ラベル自体が
              「最大化」/「縮小」と入れ替わるので、押下状態も併せて伝えると
              「縮小、押されています」= 縮小が有効、と逆に読める。ラベルが
              次にどうなるかを示す通常のボタンとして扱う。 */}
          {isMaximized ? '縮小' : '最大化'}
        </button>
        <button
          ref={closeButtonRef}
          type="button"
          className="btn detail-close"
          onClick={onClose}
        >
          閉じる
        </button>
      </div>
    </div>
  );
}
