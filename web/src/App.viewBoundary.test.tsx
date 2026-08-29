import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return {
    ...actual,
    fetchProjects: vi.fn(),
    fetchSessions: vi.fn(),
    fetchStatus: vi.fn(),
    fetchBoard: vi.fn(),
    fetchPendingDecisions: vi.fn(),
    fetchChatAvailability: vi.fn(),
    fetchTicket: vi.fn(),
    fetchTicketComments: vi.fn(),
    fetchTunnel: vi.fn(),
    fetchAiQuota: vi.fn(),
    fetchBoardThresholdsConfig: vi.fn(),
  };
});

// 統合ビューの本体だけを throw させる。画面のほとんどを占める領域なので、
// ここが落ちても他が生き残ることと、ビューを切り替えれば復帰することの
// 2点が、ビュー境界と key={view} の存在意義そのものになる。
vi.mock('./components/BoardView', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./components/BoardView')>();
  return {
    ...actual,
    BoardLanes: () => {
      throw new Error('board lanes exploded');
    },
  };
});

import { primeAppApiMocks, renderApp } from './test/appHarness';

describe('App view boundary (bdboard-yfq)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    primeAppApiMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('names the crashed view and keeps the rest of the chrome usable', async () => {
    renderApp();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '統合の表示に失敗しました',
    );
    // ビュー領域の外 (ヘッダー) は生きている。境界が無ければ App ごと落ちて
    // ここも消える。
    expect(screen.getByRole('button', { name: '設定' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '分割' })).toBeInTheDocument();
  });

  it('recovers by switching to another view', async () => {
    const user = userEvent.setup();
    renderApp();

    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: '分割' }));

    // 境界から key={view} を外すと、壊れた状態を持ち越して別ビューでも
    // fallback が出たままになる。
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
