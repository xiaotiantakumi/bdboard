import { useState } from 'react';
import { TIPS } from '../tipsContent';

export interface TipsBannerProps {
  onOpenHelp: () => void;
  /**
   * 閉じるボタンが押されたときに呼ばれる。表示可否そのもの(永続化された
   * dismissed フラグ)は呼び出し側の App.tsx が持つ(bdboard-h4xs.17) —
   * 保存先・キー名・復帰手段は web/src/uiPersistedState.ts の
   * UI_STORAGE_KEYS.tipsBannerDismissed のコメントを参照。
   */
  onDismiss: () => void;
}

function randomTipIndex(excluding?: number): number {
  if (TIPS.length < 2 || excluding === undefined) {
    return Math.floor(Math.random() * TIPS.length);
  }

  const offset = Math.floor(Math.random() * (TIPS.length - 1)) + 1;
  return (excluding + offset) % TIPS.length;
}

export function TipsBanner({ onOpenHelp, onDismiss }: TipsBannerProps) {
  const [tipIndex, setTipIndex] = useState(() => randomTipIndex());

  if (TIPS.length === 0) {
    return null;
  }

  const tip = TIPS[tipIndex];

  return (
    <aside className="tips-banner" aria-label="使い方のヒント">
      <div className="tips-banner-content">
        <p className="tips-banner-label">TIP</p>
        <p className="tips-banner-text" aria-live="polite">
          <strong>{tip.title}</strong>
          <span>{tip.text}</span>
        </p>
      </div>
      <div className="tips-banner-actions">
        <button type="button" className="btn" onClick={onOpenHelp}>
          詳しく
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => setTipIndex((index) => randomTipIndex(index))}
        >
          次のTipsを見る
        </button>
        <button
          type="button"
          className="btn"
          aria-label="Tipsを閉じる"
          onClick={onDismiss}
        >
          閉じる
        </button>
      </div>
    </aside>
  );
}
