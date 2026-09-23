// bdboard-sso1.88: TicketDetailPanel.test.tsx (2764行) から move-only で分割した
// 「resize」関心のファイル。関数本体・アサーション・フィクスチャの値は
// 元ファイルから1文字も変えていない。


import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchTicket,
  fetchTicketComments,
  fetchSimilarTickets,
  fetchPlatformSupport,
  fetchTicketRuns,
  fetchTicketInFlightOverlaps,
  fetchProjectHarnessStatus,
} from '../api';
import { resetPlatformSupportCache } from './PlatformLimitationNotice';
import { harnessStatus, renderPanel, sampleTicket } from './TicketDetailPanel-test-support';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    fetchTicket: vi.fn(),
    fetchTicketComments: vi.fn(),
    fetchSimilarTickets: vi.fn(),
    fetchPlatformSupport: vi.fn(),
    fetchTicketRuns: vi.fn(),
    fetchTicketInFlightOverlaps: vi.fn(),
    fetchProjectHarnessStatus: vi.fn(),
  };
});

const mockFetchTicket = vi.mocked(fetchTicket);
const mockFetchTicketComments = vi.mocked(fetchTicketComments);
const mockFetchSimilarTickets = vi.mocked(fetchSimilarTickets);
const mockFetchPlatformSupport = vi.mocked(fetchPlatformSupport);
const mockFetchTicketRuns = vi.mocked(fetchTicketRuns);
const mockFetchTicketInFlightOverlaps = vi.mocked(fetchTicketInFlightOverlaps);
const mockFetchProjectHarnessStatus = vi.mocked(fetchProjectHarnessStatus);

beforeEach(() => {
  mockFetchSimilarTickets.mockResolvedValue([]);
  mockFetchTicketRuns.mockResolvedValue({ runs: [] });
  mockFetchTicketInFlightOverlaps.mockResolvedValue([]);
  resetPlatformSupportCache();
  mockFetchPlatformSupport.mockResolvedValue({ platform: 'darwin', limitations: [] });
  mockFetchProjectHarnessStatus.mockResolvedValue(harnessStatus());
});

describe('TicketDetailPanel resize', () => {
  beforeEach(() => {
    mockFetchTicket.mockResolvedValue(sampleTicket);
    mockFetchTicketComments.mockResolvedValue([]);
  });

  it('resizes on desktop and remembers its width', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
    const first = renderPanel(new Map());
    await screen.findByText(sampleTicket.title);
    const panel = first.container.querySelector('.detail-panel');
    const handle = screen.getByRole('separator', { name: 'チケット詳細パネルの幅を変更' });

    expect(panel).toHaveStyle({ width: '480px' });
    // pointerdown はカーソル位置から幅を再計算しない(bdboard-p2ew): ハンドルと
    // カーソル位置がずれていても、ドラッグ開始直後に幅が瞬間的に跳ばない。
    fireEvent(handle, new MouseEvent('pointerdown', { bubbles: true, clientX: 0 }));
    expect(panel).toHaveStyle({ width: '480px' });
    expect(localStorage.getItem('bdboard.ui.ticketDetailPanelWidth')).toBeNull();

    // pointerdown からの移動量(差分)で幅を更新する。開始位置から 900px 左に
    // 移動しており、480 + 900 は viewportMaximum(1000-320=680) でクランプされる。
    fireEvent(handle, new MouseEvent('pointermove', { bubbles: true, clientX: -900 }));
    expect(panel).toHaveStyle({ width: '680px' });
    // ドラッグ中はまだ localStorage へ書き込まない。確定は pointerup 時のみ。
    expect(localStorage.getItem('bdboard.ui.ticketDetailPanelWidth')).toBeNull();

    fireEvent(handle, new MouseEvent('pointerup', { bubbles: true }));
    expect(localStorage.getItem('bdboard.ui.ticketDetailPanelWidth')).toBe('680');
  });

  it('ハンドルにフォーカスがある状態で最大化してもフォーカスがパネル外へ落ちない', async () => {
    /*
     * 最大化するとリサイズハンドルが DOM から外れる。フォーカスがそこに残ったまま
     * だと activeElement が body に落ち、useFocusTrap がパネル要素に張った keydown
     * を受け取れなくなって Escape で閉じられなくなる (opus レビュー minor-1)。
     *
     * fireEvent.click を使うのが肝。userEvent.click は自前でフォーカスをボタンへ
     * 移すので、実装が何もしなくても通ってしまう (実測で確認: userEvent 版だと
     * focus() を削る変異が生存した)。fireEvent.click はフォーカスを動かさないので、
     * button クリックでフォーカスを与えない Safari/macOS と等価な経路になる。
     */
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
    const { container } = renderPanel(new Map());
    await screen.findByText(sampleTicket.title);

    const handle = screen.getByRole('separator', { name: 'チケット詳細パネルの幅を変更' });
    handle.focus();
    expect(document.activeElement).toBe(handle);

    fireEvent.click(screen.getByRole('button', { name: '最大化' }));

    expect(document.activeElement).not.toBe(document.body);
    expect(container.querySelector('.detail-panel')?.contains(document.activeElement)).toBe(true);

    // フォーカストラップが生きている = Escape でちゃんと閉じられる。
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  });

  it('最大化で全幅にし、解除すると直前の幅へ戻る (bdboard-0hcx)', async () => {
    // ドラッグ/キーボードのリサイズは MAX_WIDTH (720px) で頭打ちになる。最大化は
    // その上限を意図的に越える表示モードで、解除したら直前の幅へ戻ること。
    // 上限 720px が視野幅由来のクランプ (innerWidth - 320) より小さくなる幅に
    // 固定する。既定の 1024 のままだと 704px で頭打ちになり本題がぼやける。
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
    const user = userEvent.setup();
    const first = renderPanel(new Map());
    await screen.findByText(sampleTicket.title);
    const panel = first.container.querySelector('.detail-panel');
    const handleName = 'チケット詳細パネルの幅を変更';

    fireEvent.keyDown(screen.getByRole('separator', { name: handleName }), { key: 'End' });
    expect(panel).toHaveStyle({ width: '720px' });
    expect(localStorage.getItem('bdboard.ui.ticketDetailPanelWidth')).toBe('720');

    const maximize = screen.getByRole('button', { name: '最大化' });
    // 見出しの操作は .detail-header-actions にまとめる (ChatPanel と同じ)。
    expect(maximize.parentElement?.className).toContain('detail-header-actions');
    // aria-pressed は付けない。状態はラベル自体が伝える。
    expect(maximize).not.toHaveAttribute('aria-pressed');
    await user.click(maximize);

    expect(panel).toHaveStyle({ width: '100%' });
    expect(panel?.className).toContain('is-maximized');
    expect(screen.queryByRole('separator', { name: handleName })).not.toBeInTheDocument();
    // 100% は一時的な表示状態であり、通常幅の保存値を書き換えない。
    expect(localStorage.getItem('bdboard.ui.ticketDetailPanelWidth')).toBe('720');

    const shrink = screen.getByRole('button', { name: '縮小' });
    expect(shrink).not.toHaveAttribute('aria-pressed');
    await user.click(shrink);

    expect(panel).toHaveStyle({ width: '720px' });
    expect(panel?.className).not.toContain('is-maximized');
    expect(screen.getByRole('separator', { name: handleName })).toBeInTheDocument();

    // 最大化はこの表示中だけの状態。次に開いたときは保存済みの通常幅から。
    first.unmount();
    const second = renderPanel(new Map());
    await screen.findByText(sampleTicket.title);
    expect(second.container.querySelector('.detail-panel')).toHaveStyle({ width: '720px' });
    expect(screen.getByRole('button', { name: '最大化' })).toBeInTheDocument();
  });
});

