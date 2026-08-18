import { useState } from 'react';
import { TIPS } from '../tipsContent';

export interface TipsBannerProps {
  onOpenHelp: () => void;
}

function randomTipIndex(excluding?: number): number {
  if (TIPS.length < 2 || excluding === undefined) {
    return Math.floor(Math.random() * TIPS.length);
  }

  const offset = Math.floor(Math.random() * (TIPS.length - 1)) + 1;
  return (excluding + offset) % TIPS.length;
}

export function TipsBanner({ onOpenHelp }: TipsBannerProps) {
  const [isVisible, setIsVisible] = useState(true);
  const [tipIndex, setTipIndex] = useState(() => randomTipIndex());

  if (!isVisible || TIPS.length === 0) {
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
          onClick={() => setIsVisible(false)}
        >
          閉じる
        </button>
      </div>
    </aside>
  );
}
