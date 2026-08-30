import { act, renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTicketDeepLink } from './useTicketDeepLink';

function renderDeepLink(
  initialView: 'merged' | 'stats' = 'merged',
  onViewChange = vi.fn(),
) {
  return renderHook(
    ({ view }) => useTicketDeepLink({ view, onViewChange }),
    { initialProps: { view: initialView } },
  );
}

function renderDeepLinkStrict() {
  return renderHook(({ view }) => useTicketDeepLink({ view, onViewChange: vi.fn() }), {
    initialProps: { view: 'merged' as const },
    wrapper: StrictMode,
  });
}

describe('useTicketDeepLink', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens detail from initial hash (AC1)', () => {
    window.history.replaceState(null, '', '/#ticket=bdboard-1');

    const { result } = renderDeepLink();

    expect(result.current.selectedTicketId).toBe('bdboard-1');
  });

  it('applies view from initial hash without overwriting it (AC3)', async () => {
    window.history.replaceState(null, '', '/#view=stats');
    const onViewChange = vi.fn();

    renderDeepLink('merged', onViewChange);

    await waitFor(() => {
      expect(onViewChange).toHaveBeenCalledWith('stats');
    });
    expect(window.location.hash).toBe('#view=stats');
  });

  it('pushState on first selectTicket and sets hash', () => {
    const pushSpy = vi.spyOn(window.history, 'pushState');
    const { result } = renderDeepLink();

    act(() => {
      result.current.selectTicket('a');
    });

    expect(pushSpy).toHaveBeenCalled();
    expect(window.location.hash).toBe('#ticket=a');
  });

  it('replaceState when switching tickets without pushing again', () => {
    const pushSpy = vi.spyOn(window.history, 'pushState');
    const replaceSpy = vi.spyOn(window.history, 'replaceState');
    const { result } = renderDeepLink();

    act(() => {
      result.current.selectTicket('a');
    });

    const pushCountAfterFirst = pushSpy.mock.calls.length;

    act(() => {
      result.current.selectTicket('b');
    });

    expect(pushSpy.mock.calls.length).toBe(pushCountAfterFirst);
    expect(replaceSpy).toHaveBeenCalled();
    expect(window.location.hash).toBe('#ticket=b');
  });

  it('closeDetail calls history.back when detail was pushed (AC2)', () => {
    const backSpy = vi.spyOn(window.history, 'back');
    const { result } = renderDeepLink();

    act(() => {
      result.current.selectTicket('a');
    });

    act(() => {
      result.current.closeDetail();
    });

    expect(backSpy).toHaveBeenCalled();

    act(() => {
      window.history.replaceState(window.history.state, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(result.current.selectedTicketId).toBeNull();
  });

  it('closeDetail from direct hash load clears ticket and hash (AC2)', async () => {
    window.history.replaceState(null, '', '/#ticket=a');
    const { result } = renderDeepLink();

    act(() => {
      result.current.closeDetail();
    });

    expect(result.current.selectedTicketId).toBeNull();

    await waitFor(() => {
      expect(window.location.hash).toBe('');
    });
  });

  it('keeps detail open when popstate leaves ticket in hash', () => {
    const { result } = renderDeepLink();

    act(() => {
      result.current.selectTicket('a');
    });

    expect(result.current.selectedTicketId).toBe('a');

    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(result.current.selectedTicketId).toBe('a');
  });

  it('updates hash with view via replaceState when view changes (AC3)', () => {
    const pushSpy = vi.spyOn(window.history, 'pushState');
    const replaceSpy = vi.spyOn(window.history, 'replaceState');
    const { result, rerender } = renderDeepLink();

    act(() => {
      result.current.selectTicket('a');
    });

    pushSpy.mockClear();
    replaceSpy.mockClear();

    rerender({ view: 'stats' });

    expect(pushSpy).not.toHaveBeenCalled();
    expect(replaceSpy).toHaveBeenCalled();
    expect(window.location.hash).toBe('#ticket=a&view=stats');
  });

  // useHistoryBackClose keeps its panel token in history.state; a hash sync that
  // replaces the state object would break the back gesture of ChatPanel /
  // SessionListPanel / SessionTailViewer. The sync has to actually run here
  // (closing the detail rewrites the URL), otherwise this asserts nothing.
  it('preserves existing history.state during hash sync', async () => {
    window.history.replaceState({ bdboardPanelToken: 'tok' }, '', '/#ticket=a');

    const { result } = renderDeepLink();

    act(() => {
      result.current.closeDetail();
    });

    await waitFor(() => {
      expect(window.location.hash).toBe('');
    });
    expect(
      (window.history.state as { bdboardPanelToken?: string } | null)
        ?.bdboardPanelToken,
    ).toBe('tok');
  });

  describe('パネル内の戻る (bdboard-4ql7)', () => {
    it('最初は戻れない', () => {
      const { result } = renderDeepLink();

      expect(result.current.canGoBackTicket).toBe(false);

      act(() => {
        result.current.selectTicket('a');
      });

      // 盤面から最初の1枚を開いただけでは、パネル内の戻り先はまだ無い。
      expect(result.current.canGoBackTicket).toBe(false);
    });

    it('チケット→チケット遷移のあと1つ前のチケットへ戻る', () => {
      const { result } = renderDeepLink();

      act(() => {
        result.current.selectTicket('a');
      });
      act(() => {
        result.current.selectTicket('b');
      });

      expect(result.current.selectedTicketId).toBe('b');
      expect(result.current.canGoBackTicket).toBe(true);

      act(() => {
        result.current.goBackTicket();
      });

      expect(result.current.selectedTicketId).toBe('a');
      expect(window.location.hash).toBe('#ticket=a');
      expect(result.current.canGoBackTicket).toBe(false);
    });

    it('多段に辿ってから1段ずつ戻れる', () => {
      const { result } = renderDeepLink();

      for (const id of ['a', 'b', 'c']) {
        act(() => {
          result.current.selectTicket(id);
        });
      }

      act(() => {
        result.current.goBackTicket();
      });
      expect(result.current.selectedTicketId).toBe('b');

      act(() => {
        result.current.goBackTicket();
      });
      expect(result.current.selectedTicketId).toBe('a');
      expect(result.current.canGoBackTicket).toBe(false);
    });

    it('同じチケットを選び直しても戻り先は増えない', () => {
      const { result } = renderDeepLink();

      act(() => {
        result.current.selectTicket('a');
      });
      act(() => {
        result.current.selectTicket('a');
      });

      expect(result.current.canGoBackTicket).toBe(false);
    });

    it('ブラウザ履歴の深さは変えない (戻る=閉じる の挙動を壊さない)', () => {
      /*
       * この設計の肝。チケット→チケットを pushState にすると closeDetail の
       * history.back() が1つ前のチケットへ戻ってしまい「閉じる」が壊れる。
       * パネル内スタックはアプリ内に持ち、ブラウザ履歴には触らない。
       */
      const pushSpy = vi.spyOn(window.history, 'pushState');
      const { result } = renderDeepLink();

      act(() => {
        result.current.selectTicket('a');
      });
      expect(pushSpy).toHaveBeenCalledTimes(1);

      act(() => {
        result.current.selectTicket('b');
      });
      act(() => {
        result.current.goBackTicket();
      });

      expect(pushSpy).toHaveBeenCalledTimes(1);
    });

    it('詳細を閉じると戻り先は破棄される', () => {
      const { result } = renderDeepLink();

      act(() => {
        result.current.selectTicket('a');
      });
      act(() => {
        result.current.selectTicket('b');
      });
      expect(result.current.canGoBackTicket).toBe(true);

      act(() => {
        result.current.closeDetail();
      });

      expect(result.current.canGoBackTicket).toBe(false);
    });

    it('子パネルが自前の履歴エントリを閉じただけでは戻り先を捨てない', () => {
      /*
       * PR#241 レビュー major-1 の回帰ガード。useHistoryBackClose を使う子パネル
       * (ChatPanel 等) は自前の履歴エントリを push し、閉じるときに
       * history.back() で pop する。このとき hash は #ticket=… のままで表示
       * チケットも変わらないのに popstate は発火するので、無条件クリアだと
       * 「チケットBについてチャット → 閉じる」で戻り先が消えていた。
       */
      const { result } = renderDeepLink();

      act(() => {
        result.current.selectTicket('a');
      });
      act(() => {
        result.current.selectTicket('b');
      });
      expect(result.current.canGoBackTicket).toBe(true);

      // hash は据え置き = 表示チケットは変わらない popstate。
      act(() => {
        window.dispatchEvent(new PopStateEvent('popstate'));
      });

      expect(result.current.selectedTicketId).toBe('b');
      expect(result.current.canGoBackTicket).toBe(true);

      act(() => {
        result.current.goBackTicket();
      });
      expect(result.current.selectedTicketId).toBe('a');
    });

    it('1イベント内で2回押すと2段戻る', () => {
      /*
       * goBackTicket がハンドラ本体で backStackRef を即座に進める理由。state は
       * 次のレンダーまで更新されないので、ref を進めないと同一イベント内の
       * 2回目が同じ戻り先を読んでしまい、1段しか戻らない。
       */
      const { result } = renderDeepLink();

      for (const id of ['a', 'b', 'c']) {
        act(() => {
          result.current.selectTicket(id);
        });
      }

      act(() => {
        result.current.goBackTicket();
        result.current.goBackTicket();
      });

      expect(result.current.selectedTicketId).toBe('a');
      expect(result.current.canGoBackTicket).toBe(false);
    });

    it('同一イベント内で selectTicket してから goBackTicket しても1段だけ戻る', () => {
      /*
       * backStack の push は state 経由、pop は ref 経由 —— という非対称があると、
       * goBackTicket が「まだ積まれていないスタック」を読んで黙って1段飛ばす
       * (PR#241 opus レビュー minor)。selectTicket 側でも ref を即時更新する
       * ことの回帰ガード。
       */
      const { result } = renderDeepLink();

      act(() => {
        result.current.selectTicket('a');
      });
      act(() => {
        result.current.selectTicket('b');
      });
      act(() => {
        result.current.selectTicket('c');
        result.current.goBackTicket();
      });

      expect(result.current.selectedTicketId).toBe('b');
    });

    it('StrictMode 下でも goBackTicket は replaceState を1回しか呼ばない', () => {
      /*
       * updater は StrictMode の development 二重実行で再実行される。副作用を
       * setBackStack の updater 内に置くと replaceState が2回叩かれる —— 状態は
       * 冪等なので結果の state に差は出ないが、「updater は複数回走りうる」と
       * いう React の純粋性契約そのものは、この呼び出し回数で直接縛れる。
       * bdboard-ge1 が「development の二重実行 × history API」で刺さった前例。
       */
      const { result } = renderDeepLinkStrict();

      for (const id of ['a', 'b', 'c']) {
        act(() => {
          result.current.selectTicket(id);
        });
      }

      // selectTicket 自身の replaceState を数えないよう、ここで張る。
      const replaceSpy = vi.spyOn(window.history, 'replaceState');
      act(() => {
        result.current.goBackTicket();
      });

      expect(result.current.selectedTicketId).toBe('b');
      expect(window.location.hash).toBe('#ticket=b');
      expect(result.current.canGoBackTicket).toBe(true);
      expect(replaceSpy).toHaveBeenCalledTimes(1);
    });

    it('ブラウザ操作で表示チケットが変わったら戻り先は破棄される', () => {
      const { result } = renderDeepLink();

      act(() => {
        result.current.selectTicket('a');
      });
      act(() => {
        result.current.selectTicket('b');
      });
      expect(result.current.canGoBackTicket).toBe(true);

      // ブラウザの戻る/直リンク相当。パネル内スタックはブラウザ履歴と対応が
      // 取れなくなるので捨てる。
      act(() => {
        window.history.replaceState(null, '', '/#ticket=z');
        window.dispatchEvent(new PopStateEvent('popstate'));
      });

      expect(result.current.selectedTicketId).toBe('z');
      expect(result.current.canGoBackTicket).toBe(false);
    });
  });
});
