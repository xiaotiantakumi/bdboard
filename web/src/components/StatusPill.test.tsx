import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StatusPill } from './StatusPill';

// 「今日」だと vi.setSystemTime が効いていなくても通ってしまう。任意の日付にする
// (PR#116 fable レビュー nit)。
const NOW = new Date('2026-01-01T12:00:00Z');

function renderPill(overrides?: Partial<React.ComponentProps<typeof StatusPill>>) {
  const props: React.ComponentProps<typeof StatusPill> = {
    streamState: 'open',
    lastContactAtMs: NOW.getTime(),
    generatedAt: NOW.toISOString(),
    lastRefreshAt: NOW.toISOString(),
    totalSessionCount: 0,
    activeSessionCount: 0,
    onOpenSessionList: vi.fn(),
    open: true,
    onOpenChange: vi.fn(),
    ...overrides,
  };
  return render(<StatusPill {...props} />);
}

afterEach(() => {
  // 本文末尾で戻すとアサーション失敗時にモック時刻が後続へ漏れる
  // (PR#116 fable レビュー nit)。
  vi.useRealTimers();
});

describe('StatusPill popover freshness (bdboard-d55)', () => {
  it('labels the generatedAt age as board content, not as a fetch', () => {
    vi.setSystemTime(NOW);
    renderPill({
      generatedAt: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
    });

    expect(screen.getByText(/盤面内容の最終変化: 10分前/)).toBeInTheDocument();
    // 「取得」は通信の話に読めるので、この語で出してはいけない。
    expect(screen.queryByText(/盤面取得/)).not.toBeInTheDocument();
  });

  it('shows the quiet case unambiguously: stale content, live connection', () => {
    // ETag 304 が続くと generatedAt は凍るが通信は生きている (bdboard-9qa)。
    // このとき「正常」ピルの中身が「10分前」だけだと、通信が止まっている
    // ようにしか読めない。両方を並べて初めて読み分けられる。
    vi.setSystemTime(NOW);
    renderPill({
      generatedAt: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
      lastContactAtMs: NOW.getTime(),
    });

    expect(screen.getByText(/盤面内容の最終変化: 10分前/)).toBeInTheDocument();
    expect(screen.getByText(/最終通信: たった今/)).toBeInTheDocument();
  });

  it('omits the contact line when the server has never been reached', () => {
    vi.setSystemTime(NOW);
    renderPill({ lastContactAtMs: null });

    expect(screen.queryByText(/最終通信/)).not.toBeInTheDocument();
    expect(screen.getByText(/盤面内容の最終変化/)).toBeInTheDocument();
  });

  it('omits the content line when the board has never been generated', () => {
    vi.setSystemTime(NOW);
    renderPill({ generatedAt: null });

    expect(screen.queryByText(/盤面内容の最終変化/)).not.toBeInTheDocument();
    expect(screen.getByText(/最終通信/)).toBeInTheDocument();
  });

  it('shows nothing from the popover while it is closed', () => {
    renderPill({ open: false });

    expect(screen.queryByText(/盤面内容の最終変化/)).not.toBeInTheDocument();
    expect(screen.queryByText(/最終通信/)).not.toBeInTheDocument();
  });

  it('still opens the session list from the popover', async () => {
    const onOpenSessionList = vi.fn();
    renderPill({ onOpenSessionList, totalSessionCount: 3, activeSessionCount: 1 });

    await userEvent.click(screen.getByRole('button', { name: /セッション: 3/ }));
    expect(onOpenSessionList).toHaveBeenCalledTimes(1);
  });
});
