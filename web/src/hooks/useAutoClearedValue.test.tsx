import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAutoClearedValue } from './useAutoClearedValue';

const DELAY_MS = 1500;
const EMPTY = '';

function Probe() {
  const feedback = useAutoClearedValue(EMPTY, DELAY_MS);
  return (
    <div>
      <button type="button" onClick={() => feedback.show('自動で消える')}>
        show
      </button>
      <button type="button" onClick={() => feedback.hold('残る')}>
        hold
      </button>
      <button type="button" onClick={() => feedback.clear()}>
        clear
      </button>
      <p data-testid="value">{feedback.value}</p>
    </div>
  );
}

function click(name: string) {
  act(() => {
    screen.getByRole('button', { name }).click();
  });
}

describe('useAutoClearedValue (bdboard-ty72)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears a shown value after the delay', () => {
    render(<Probe />);
    click('show');
    expect(screen.getByTestId('value')).toHaveTextContent('自動で消える');

    act(() => {
      vi.advanceTimersByTime(DELAY_MS - 1);
    });
    // 期限ちょうどまでは消えない。ここを見ないと delay の指定が効いていなくても通る。
    expect(screen.getByTestId('value')).toHaveTextContent('自動で消える');

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByTestId('value')).toBeEmptyDOMElement();
  });

  it('keeps a held value on screen', () => {
    render(<Probe />);
    click('hold');

    act(() => {
      vi.advanceTimersByTime(DELAY_MS * 5);
    });
    expect(screen.getByTestId('value')).toHaveTextContent('残る');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not let a pending auto-clear wipe a later held value', () => {
    render(<Probe />);
    click('show');
    act(() => {
      vi.advanceTimersByTime(DELAY_MS - 1);
    });
    click('hold');

    act(() => {
      vi.advanceTimersByTime(DELAY_MS * 2);
    });
    expect(screen.getByTestId('value')).toHaveTextContent('残る');
  });

  it('restarts the delay when a second show arrives', () => {
    render(<Probe />);
    click('show');
    act(() => {
      vi.advanceTimersByTime(DELAY_MS - 1);
    });
    click('show');

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByTestId('value')).toHaveTextContent('自動で消える');
    expect(vi.getTimerCount()).toBe(1);
  });

  it('clear() empties the value and drops the pending auto-clear', () => {
    render(<Probe />);
    click('show');
    expect(vi.getTimerCount()).toBe(1);

    click('clear');
    expect(screen.getByTestId('value')).toBeEmptyDOMElement();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no pending timer behind after unmount', () => {
    const { unmount } = render(<Probe />);
    click('show');
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

/*
 * これがこのフックの本題 (bdboard-ifff -> bdboard-ty72)。
 *
 * 呼び出し側は `await copyTextToClipboard(...)` や `await invalidateQueries(...)`
 * の**継続**から表示を出す。その継続はアンマウントの後に解決しうるので、
 * 「タイマーIDを ref に持ってアンマウント時にクリアする」だけでは足りない —
 * クリーンアップが走り終わった後に、新しいタイマーが仕掛けられてしまう。
 * 残ったタイマーは破棄済みの jsdom で `window is not defined` を投げ、vitest は
 * それを「テスト環境破棄後の未捕捉エラー」としてプロセスごと exit 1 にする。
 * 個々のテストは全て pass したままなので、原因の分かりにくい壊れ方をする。
 */
describe('useAutoClearedValue after unmount (bdboard-ty72)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function renderCaptured() {
    const captured: {
      current: ReturnType<typeof useAutoClearedValue<string>> | null;
    } = { current: null };
    function Capture() {
      captured.current = useAutoClearedValue(EMPTY, DELAY_MS);
      return null;
    }
    const view = render(<Capture />);
    return { captured, ...view };
  }

  it('ignores a late show instead of arming an orphan timer', () => {
    const { captured, unmount } = renderCaptured();
    unmount();

    act(() => {
      captured.current?.show('遅れて届いた表示');
    });

    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not throw when hold or clear arrive late', () => {
    const { captured, unmount } = renderCaptured();
    unmount();

    // 呼び出し側は onError の非同期継続からこれらを呼びうる。投げると
    // 未捕捉エラーが1つ増えるだけなので、黙って捨てる。
    expect(() => {
      act(() => {
        captured.current?.hold('遅れて届いた失敗');
        captured.current?.clear();
      });
    }).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });
});
