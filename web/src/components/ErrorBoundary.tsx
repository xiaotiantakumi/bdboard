import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  /**
   * 「〜の表示に失敗しました」に入る名前。どこが壊れたのかが利用者に伝わるよう、
   * パネル/ビュー名をそのまま渡す。
   */
  readonly label: string;
  /**
   * 復帰導線のラベルと動作。パネルなら「閉じる」(onClose) を渡すのが自然。
   * 省略すると「再試行」として境界の状態だけを初期化する。
   */
  readonly resetLabel?: string;
  readonly onReset?: () => void;
  /**
   * 中身がモーダル (自前で `.overlay` を描画するパネル) のときに立てる。
   *
   * その手のパネルが throw すると暗幕ごと消えるので、既定の fallback は
   * `.app` 末尾の通常フローに出てしまう。縦に長いボードだと画面外に落ちて
   * 「クリックしても何も起きない」ようにしか見えない。ここを立てると
   * fallback 自身が overlay を張り、元のパネルと同じ位置に出る (PR#129 レビュー)。
   */
  readonly overlay?: boolean;
  readonly children: ReactNode;
}

interface ErrorBoundaryState {
  readonly error: Error | null;
}

/**
 * 描画中の throw を受け止めて、その部分だけを差し替える。
 *
 * これが無いと React はツリー全体をアンマウントするので、どこか1つの
 * コンポーネントが throw した時点で画面が真っ白になる (bdboard-yfq)。
 * 表示箇所ごとにガードを撒く方針は取らない — 契約違反が「壊れた文字列の表示」に
 * 化けて発見が遅れるだけで、落ちたこと自体は伝わらなくなる。
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // 本番でも痕跡を残す。ここを握り潰すと「白くはならないが原因も分からない」に
    // なるだけで、元の問題を別の形で作り直すことになる。
    console.error(
      `[ErrorBoundary] ${this.props.label}の描画に失敗しました`,
      error,
      info.componentStack,
    );
  }

  private readonly handleReset = (): void => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) {
      return this.props.children;
    }
    const fallback = (
      <div className="error-boundary" role="alert">
        <strong className="error-boundary-title">
          {this.props.label}の表示に失敗しました
        </strong>
        <div className="error-boundary-body">
          <p className="error-boundary-detail">{error.message}</p>
          <p className="error-boundary-hint">
            この部分だけが停止しています。他の表示は続けて操作できます。
          </p>
        </div>
        <div className="error-boundary-actions">
          <button type="button" className="btn btn-small" onClick={this.handleReset}>
            {this.props.resetLabel ?? '再試行'}
          </button>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => window.location.reload()}
          >
            ページを再読み込み
          </button>
        </div>
      </div>
    );
    if (this.props.overlay !== true) {
      return fallback;
    }
    return <div className="overlay error-boundary-overlay">{fallback}</div>;
  }
}
