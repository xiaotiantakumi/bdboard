// bdboard-sso1.5: TicketDetailPanel.tsx の「detail-header」ブロック(タイトル
// 表示/編集 + 戻る/ウォッチ/最大化/閉じるの各ボタン)を移動しただけの
// コンポーネント。state・mutation は親側の各フック(useTicketTitleEditing 等)に
// 残し、値とハンドラを props で受け取る表示専用コンポーネント。JSX・
// className・aria属性・文言・DOM構造・コメントは移動前から変えていない。
import type { RefObject } from 'react';
import { WatchToggle } from '../WatchToggle';
import {
  TicketTitleSection,
  type TicketTitleSectionProps,
} from './TicketTitleSection';

export interface TicketDetailHeaderSectionProps extends TicketTitleSectionProps {
  ticketId: string;
  onBackTicket: (() => void) | undefined;
  isMaximized: boolean;
  onToggleMaximized: () => void;
  onClose: () => void;
  closeButtonRef: RefObject<HTMLButtonElement | null>;
}

export function TicketDetailHeaderSection({
  ticketId,
  onBackTicket,
  isMaximized,
  onToggleMaximized,
  onClose,
  closeButtonRef,
  ...titleSectionProps
}: TicketDetailHeaderSectionProps) {
  return (
    // .detail-header は7パネル共有のため、モバイル向け縦積みは ticket-detail-header
    // 修飾クラスで詳細パネルだけに限定する (bdboard-h4xs.2)。
    <div className="detail-header ticket-detail-header">
      <TicketTitleSection {...titleSectionProps} />
      <div className="detail-header-actions">
        {onBackTicket !== undefined && (
          <button
            type="button"
            className="btn btn-small detail-back"
            /* 「←」をアクセシブルネームに含めると読み上げが「左向き矢印、
               戻る」になるので、同ヘッダーの「タイトルを編集」と同じく
               aria-label でラベルを与える (PR#241 レビュー minor-4)。 */
            aria-label="前のチケットへ戻る"
            onClick={onBackTicket}
          >
            ← 戻る
          </button>
        )}
        <WatchToggle ticketId={ticketId} className="detail-watch-toggle" />
        <button
          type="button"
          className="btn btn-small detail-maximize"
          onClick={(event) => {
            /*
             * 最大化するとリサイズハンドルが DOM から外れる。ハンドルに
             * フォーカスがあるままだと activeElement が body に落ち、
             * useFocusTrap がパネル要素に張った keydown を受け取れなくなって
             * Escape で閉じられなくなる (PR#242 opus レビュー minor-1)。
             * Chrome/Firefox は button クリックでフォーカスがボタンへ移るので
             * 踏まないが、Safari/macOS は button にフォーカスを与えない。
             */
            if (!isMaximized) {
              event.currentTarget.focus();
            }
            onToggleMaximized();
          }}
          title={isMaximized ? '元の幅に戻す' : '画面幅いっぱいに広げる'}
        >
          {/* aria-pressed は付けない。ラベル自体が「最大化」/「縮小」と
              入れ替わるので、押下状態も併せて伝えると「縮小、押されています」
              = 縮小が有効、と逆に読める (ChatPanel と同じ判断)。 */}
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
