import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  gutterForViewport,
  stubBoundingRect,
  stubClientWidth,
} from '../test/popoverViewportClampTestHelpers';
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

  it('names the refresh line by its subject and shows it as a relative age', () => {
    // 「最終更新」は「最終変化」とほぼ同義に読め、主語 (サーバー) も伝わらなかった
    // (bdboard-3dr)。表記も上2行と揃えないと3行を並べて比較できない。
    vi.setSystemTime(NOW);
    renderPill({ lastRefreshAt: new Date(NOW.getTime() - 3 * 60_000).toISOString() });

    expect(screen.getByText(/サーバーのbd取込: 3分前/)).toBeInTheDocument();
    expect(screen.queryByText(/最終更新/)).not.toBeInTheDocument();
  });

  it('keeps the exact refresh timestamp reachable as a tooltip', () => {
    // 相対表示にした分、絶対値はツールチップで残す (上2行と同じ扱い)。
    vi.setSystemTime(NOW);
    const lastRefreshAt = new Date(NOW.getTime() - 3 * 60_000).toISOString();
    renderPill({ lastRefreshAt });

    expect(screen.getByText(/サーバーのbd取込: 3分前/)).toHaveAttribute(
      'title',
      new Date(lastRefreshAt).toLocaleString(),
    );
  });

  it('omits the refresh line when the server has never refreshed', () => {
    vi.setSystemTime(NOW);
    renderPill({ lastRefreshAt: null });

    expect(screen.queryByText(/サーバーのbd取込/)).not.toBeInTheDocument();
  });

  it('keeps the three freshness lines distinguishable from one another', () => {
    // 3行が別々の時刻を指していることが読み取れなければ改名の意味が無い。
    vi.setSystemTime(NOW);
    renderPill({
      generatedAt: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
      lastContactAtMs: NOW.getTime(),
      lastRefreshAt: new Date(NOW.getTime() - 3 * 60_000).toISOString(),
    });

    expect(screen.getByText(/盤面内容の最終変化: 10分前/)).toBeInTheDocument();
    expect(screen.getByText(/最終通信: たった今/)).toBeInTheDocument();
    expect(screen.getByText(/サーバーのbd取込: 3分前/)).toBeInTheDocument();
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

describe('StatusPill popover viewport clamp (bdboard-h4xs.13)', () => {
  let clientWidthSpy: ReturnType<typeof stubClientWidth> | undefined;
  let rectSpy: ReturnType<typeof stubBoundingRect> | undefined;

  afterEach(() => {
    clientWidthSpy?.mockRestore();
    rectSpy?.mockRestore();
    clientWidthSpy = undefined;
    rectSpy = undefined;
  });

  it('shifts left when the popover overflows the right edge at 320px', () => {
    const viewportWidth = 320;
    clientWidthSpy = stubClientWidth(viewportWidth);
    rectSpy = stubBoundingRect({ left: 149.84, right: 369.84 });

    const { container } = renderPill();
    const popover = container.querySelector('.status-pill-popover');
    expect(popover).not.toBeNull();

    const shiftPx = Number.parseFloat(
      (popover as HTMLElement).style.getPropertyValue('--popover-shift-x'),
    );
    const gutter = gutterForViewport(viewportWidth);

    expect(shiftPx).toBeLessThan(0);
    expect(369.84 + shiftPx).toBeLessThanOrEqual(viewportWidth - gutter);
  });

  it('keeps --popover-shift-x at 0px when the popover already fits', () => {
    clientWidthSpy = stubClientWidth(1280);
    rectSpy = stubBoundingRect({ left: 100, right: 320 });

    const { container } = renderPill();
    const popover = container.querySelector('.status-pill-popover');
    expect(popover).not.toBeNull();
    expect((popover as HTMLElement).style.getPropertyValue('--popover-shift-x')).toBe('0px');
  });
});

describe('StatusPill connect stall (bdboard-n66)', () => {
  it('shows 接続待ち instead of 正常 when connectStalled is true', () => {
    vi.setSystemTime(NOW);
    renderPill({
      streamState: 'connecting',
      connectStalled: true,
      lastContactAtMs: null,
      open: false,
    });

    expect(screen.getByRole('button', { name: '接続状態: 接続待ち' })).toHaveTextContent('接続待ち');
    expect(screen.queryByRole('button', { name: '接続状態: 正常' })).not.toBeInTheDocument();
  });
});
