import { useState, type ReactElement } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

function Boom({ message = 'boom' }: { message?: string }): ReactElement {
  throw new Error(message);
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    // React は捕捉した例外を自前でも console.error に出す。テスト出力を
    // 読めなくするだけなので黙らせる (呼ばれたこと自体は個別に検証する)。
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a scoped fallback instead of unmounting the whole tree', () => {
    render(
      <div>
        <ErrorBoundary label="チケット詳細">
          <Boom message="render exploded" />
        </ErrorBoundary>
        <p>隣のパネル</p>
      </div>,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('チケット詳細の表示に失敗しました');
    expect(screen.getByRole('alert')).toHaveTextContent('render exploded');
    // これが本題: 1つ落ちても他は生きている。境界が無いと React はツリー全体を
    // アンマウントするので、この行が消えて画面が真っ白になる (bdboard-yfq)。
    expect(screen.getByText('隣のパネル')).toBeInTheDocument();
  });

  it('renders children untouched when nothing throws', () => {
    render(
      <ErrorBoundary label="ボード">
        <p>中身</p>
      </ErrorBoundary>,
    );

    expect(screen.getByText('中身')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('logs the failure so it is not silently swallowed', () => {
    render(
      <ErrorBoundary label="チャット">
        <Boom message="logged failure" />
      </ErrorBoundary>,
    );

    const logged = vi.mocked(console.error).mock.calls.map((args) => String(args[0]));
    expect(logged.some((first) => first.includes('[ErrorBoundary] チャットの描画に失敗しました'))).toBe(
      true,
    );
  });

  it('recovers when the reset action fixes the cause', async () => {
    const user = userEvent.setup();

    function Host(): ReactElement {
      const [broken, setBroken] = useState(true);
      return (
        <ErrorBoundary
          label="チケット詳細"
          resetLabel="閉じる"
          onReset={() => setBroken(false)}
        >
          {broken ? <Boom /> : <p>直った中身</p>}
        </ErrorBoundary>
      );
    }

    render(<Host />);
    expect(screen.getByRole('alert')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '閉じる' }));

    // onReset で原因が解消され、境界の状態も初期化されるので再描画できる。
    expect(screen.getByText('直った中身')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps showing the fallback when the cause is still there', async () => {
    const user = userEvent.setup();
    render(
      <ErrorBoundary label="ボード">
        <Boom />
      </ErrorBoundary>,
    );

    await user.click(screen.getByRole('button', { name: '再試行' }));

    // 再試行しても原因が残っていれば、そのまま fallback に戻る。
    // 「押したら白画面」にならないことの確認でもある。
    expect(screen.getByRole('alert')).toHaveTextContent('ボードの表示に失敗しました');
  });
});
