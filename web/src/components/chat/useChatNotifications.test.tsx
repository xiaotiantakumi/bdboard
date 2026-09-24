import { act, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { describe, expect, it } from 'vitest';
import { useChatNotifications } from './useChatNotifications';

function Probe() {
  const notifications = useChatNotifications();
  // useThreadDrawerState.test.tsx と同じ理由: setter が ChatPanel 側の
  // useCallback 依存配列に安全に乗るかを確かめるため、参照が再レンダーを
  // またいで安定しているかを全レンダーにわたって記録する(途中レンダーの
  // 不一致が直後のレンダーで上書きされて見えなくなるのを防ぐ)。
  const seen = useRef<Record<string, unknown>>({});
  const stableKeys = ['setThreadError', 'setTicketProjectFallbackNotice'] as const;
  const allMismatchesRef = useRef<string[]>([]);
  for (const key of stableKeys) {
    const current = notifications[key];
    if (key in seen.current && seen.current[key] !== current) {
      allMismatchesRef.current.push(key);
    }
    seen.current[key] = current;
  }

  return (
    <div>
      <p data-testid="thread-error">{notifications.threadError ?? ''}</p>
      <p data-testid="fallback-notice">{notifications.ticketProjectFallbackNotice ?? ''}</p>
      <p data-testid="identity-mismatches">{allMismatchesRef.current.join(',')}</p>
      <button
        type="button"
        onClick={() => notifications.setThreadError('スレッド一覧の取得に失敗しました。')}
      >
        setThreadError
      </button>
      <button type="button" onClick={() => notifications.setThreadError(null)}>
        clearThreadError
      </button>
      <button
        type="button"
        onClick={() =>
          notifications.setTicketProjectFallbackNotice('チケットのプロジェクトが見つかりません。')
        }
      >
        setFallbackNotice
      </button>
      <button
        type="button"
        onClick={() => notifications.setTicketProjectFallbackNotice(null)}
      >
        clearFallbackNotice
      </button>
    </div>
  );
}

describe('useChatNotifications (bdboard-sso1.83 第3段)', () => {
  it('starts with both notifications empty', () => {
    render(<Probe />);
    expect(screen.getByTestId('thread-error')).toHaveTextContent('');
    expect(screen.getByTestId('fallback-notice')).toHaveTextContent('');
  });

  it('setThreadError sets and clears independently of the fallback notice', () => {
    render(<Probe />);
    act(() => {
      screen.getByText('setFallbackNotice').click();
    });
    act(() => {
      screen.getByText('setThreadError').click();
    });
    expect(screen.getByTestId('thread-error')).toHaveTextContent(
      'スレッド一覧の取得に失敗しました。',
    );
    expect(screen.getByTestId('fallback-notice')).toHaveTextContent(
      'チケットのプロジェクトが見つかりません。',
    );

    act(() => {
      screen.getByText('clearThreadError').click();
    });
    expect(screen.getByTestId('thread-error')).toHaveTextContent('');
    expect(screen.getByTestId('fallback-notice')).toHaveTextContent(
      'チケットのプロジェクトが見つかりません。',
    );
  });

  it('setTicketProjectFallbackNotice sets and clears independently of the thread error', () => {
    render(<Probe />);
    act(() => {
      screen.getByText('setThreadError').click();
    });
    act(() => {
      screen.getByText('setFallbackNotice').click();
    });
    act(() => {
      screen.getByText('clearFallbackNotice').click();
    });
    expect(screen.getByTestId('fallback-notice')).toHaveTextContent('');
    expect(screen.getByTestId('thread-error')).toHaveTextContent(
      'スレッド一覧の取得に失敗しました。',
    );
  });

  it('keeps setThreadError/setTicketProjectFallbackNotice reference-stable across every render (呼び出し側の useCallback 依存配列に安全)', () => {
    render(<Probe />);
    act(() => {
      screen.getByText('setThreadError').click();
    });
    act(() => {
      screen.getByText('setFallbackNotice').click();
    });
    act(() => {
      screen.getByText('clearThreadError').click();
    });
    act(() => {
      screen.getByText('clearFallbackNotice').click();
    });
    expect(screen.getByTestId('identity-mismatches')).toHaveTextContent('');
  });
});
