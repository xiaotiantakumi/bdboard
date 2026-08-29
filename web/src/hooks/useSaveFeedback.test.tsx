import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SAVE_FEEDBACK_MS, useSaveFeedback } from './useSaveFeedback';

function Probe() {
  const feedback = useSaveFeedback();
  return (
    <div>
      <button type="button" onClick={() => feedback.showSuccess('保存しました')}>
        成功
      </button>
      <button type="button" onClick={() => feedback.showError('失敗しました')}>
        失敗
      </button>
      <p data-testid="message">{feedback.message}</p>
      <p data-testid="is-error">{String(feedback.isError)}</p>
    </div>
  );
}

describe('useSaveFeedback (bdboard-ifff)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function click(name: string) {
    act(() => {
      screen.getByRole('button', { name }).click();
    });
  }

  it('clears a success message after the delay', () => {
    render(<Probe />);
    click('成功');
    expect(screen.getByTestId('message')).toHaveTextContent('保存しました');
    expect(screen.getByTestId('is-error')).toHaveTextContent('false');

    act(() => {
      vi.advanceTimersByTime(SAVE_FEEDBACK_MS);
    });
    expect(screen.getByTestId('message')).toBeEmptyDOMElement();
  });

  it('keeps an error message on screen', () => {
    render(<Probe />);
    click('失敗');
    expect(screen.getByTestId('is-error')).toHaveTextContent('true');

    act(() => {
      vi.advanceTimersByTime(SAVE_FEEDBACK_MS * 5);
    });
    // エラーはユーザーが読んで対処するものなので、勝手に消えてはいけない。
    expect(screen.getByTestId('message')).toHaveTextContent('失敗しました');
  });

  /*
   * これがこのフックを作った理由 (bdboard-ifff)。
   *
   * 素の window.setTimeout ではタイマーIDが誰にも保持されず、アンマウント後に
   * 発火したコールバックが setState を呼ぶ。テストでは環境破棄後の jsdom で
   * `window is not defined` になり、vitest が「テスト環境破棄後の未捕捉エラー」
   * としてプロセスごと exit 1 にする — 個々のテストは全て pass したままで。
   *
   * ここでは「アンマウント後にタイマーが1つも残っていない」を直接見る。React の
   * 警告や setState の呼び出しを数える形だと、実装の内部に依存して壊れやすい。
   */
  it('leaves no pending timer behind after unmount', () => {
    const { unmount } = render(<Probe />);
    click('成功');
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    expect(vi.getTimerCount()).toBe(0);

    // 念のため、時間を進めても何も起きない (残っていれば例外か警告になる)。
    act(() => {
      vi.advanceTimersByTime(SAVE_FEEDBACK_MS * 2);
    });
  });

  it('does not let a pending auto-clear wipe a later error', () => {
    render(<Probe />);
    click('成功');
    // 自動消去が走り切る前にエラーが来る。
    act(() => {
      vi.advanceTimersByTime(SAVE_FEEDBACK_MS - 1);
    });
    click('失敗');

    act(() => {
      vi.advanceTimersByTime(SAVE_FEEDBACK_MS * 2);
    });
    expect(screen.getByTestId('message')).toHaveTextContent('失敗しました');
  });

  it('restarts the delay when a second success arrives', () => {
    render(<Probe />);
    click('成功');
    act(() => {
      vi.advanceTimersByTime(SAVE_FEEDBACK_MS - 1);
    });
    click('成功');

    // 1回目の残り 1ms が経っても、2回目の表示は消えていない。
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByTestId('message')).toHaveTextContent('保存しました');
    expect(vi.getTimerCount()).toBe(1);

    act(() => {
      vi.advanceTimersByTime(SAVE_FEEDBACK_MS);
    });
    expect(screen.getByTestId('message')).toBeEmptyDOMElement();
  });
});

/*
 * アンマウント後に show* が呼ばれる経路を直接叩く。
 *
 * SettingsPanel の onSuccess は invalidateQueries / postRefresh を await してから
 * 表示を出すので、その継続がアンマウント後に解決しうる。タイマーのクリアだけでは
 * この経路を塞げない — show* の中の `window.setTimeout` が新しいタイマーを
 * 仕掛けてしまい、クリーンアップはもう走り終わっている。
 */
describe('useSaveFeedback after unmount (bdboard-ifff)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function renderCaptured() {
    const captured: { current: ReturnType<typeof useSaveFeedback> | null } = {
      current: null,
    };
    function Capture() {
      captured.current = useSaveFeedback();
      return null;
    }
    const view = render(<Capture />);
    return { captured, ...view };
  }

  it('ignores a late showSuccess instead of arming an orphan timer', () => {
    const { captured, unmount } = renderCaptured();
    unmount();

    act(() => {
      captured.current?.showSuccess('遅れて届いた保存完了');
    });

    expect(vi.getTimerCount()).toBe(0);
  });

  // これは煙テストであって、showError 側の mounted ガードを固定するものではない。
  // 実際に showError からだけガードを外しても、このテストは通る (fable レビュー指摘)。
  // showError はもともとタイマーを仕掛けないので getTimerCount は両方 0 だし、
  // 生きている jsdom でのアンマウント後 setState は React が黙って捨てるので
  // 例外にもならない。本番の壊れ方は「破棄済み jsdom で window に触る」ことで、
  // それはテストの内側からは再現できない (再現できたらそのテスト自身が落ちる)。
  //
  // それでもガードは残す。showSuccess と非対称にすると、後から
  // 「showError にも自動消去を足す」変更が入った瞬間に穴が開く。
  it('ignores a late showError too', () => {
    const { captured, unmount } = renderCaptured();
    unmount();

    // 例外を投げずに黙って捨てる。呼び出し側は onError の非同期継続から
    // これを呼びうるので、投げると別の未捕捉エラーになるだけ。
    expect(() => {
      act(() => {
        captured.current?.showError('遅れて届いた失敗');
      });
    }).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts with isError false so an empty message never renders as an alert', () => {
    // 呼び出し側は role={isError ? 'alert' : undefined} を組み立てる。初期値が
    // true だと、まだ何も保存していない空の要素に alert が付く。
    // これを固定しないと useState(false) -> useState(true) の変異が生き残る。
    const { captured } = renderCaptured();

    expect(captured.current?.isError).toBe(false);
    expect(captured.current?.message).toBe('');
  });
});
