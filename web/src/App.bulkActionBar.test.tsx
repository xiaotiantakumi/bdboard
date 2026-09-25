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

import { primeAppApiMocks, renderApp } from './test/appHarness';

/*
  bdboard-ml0k: カードのチェックボックスは出て選択も入るのに、一括操作バー
  だけがビューのガードで消えていた (選べるのに何もできない)。「チェック
  ボックスが出るビューでは操作バーも出る」を固定する。
  bdboard-mkm1.3: Next Up ビュー削除により、カードを並べる(=一括操作バーが
  出る)ボード系ビューは 'split' の1つだけになった。以前は 'split'/'next'
  の2ビューを it.each で個別に固定していたが、'next' 自体が無くなったため
  'split' 単独のテストに単純化した。
*/
describe('App bulk action bar visibility (bdboard-ml0k)', () => {
  beforeEach(() => {
    primeAppApiMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows the bar in the split view (the only board view)', async () => {
    const user = userEvent.setup();
    renderApp();

    // 選択前はどのビューでも出ない (selectedCount === 0 の早期 return)。
    expect(screen.queryByText('1件選択中')).toBeNull();

    const checkbox = await screen.findByRole('checkbox', {
      name: 'bdboard-boom を選択',
    });
    await user.click(checkbox);
    await user.click(screen.getByRole('button', { name: '分割' }));

    expect(await screen.findByText('1件選択中')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '全解除' })).toBeInTheDocument();
  });

  // 逆向きも1ビューだけだと `view !== 'stats'` のような変異が生き残る。
  it.each(['統計', '設定', '依存グラフ'])(
    'keeps the bar out of the %s view, which renders no cards',
    async (viewLabel) => {
      const user = userEvent.setup();
      renderApp();

      const checkbox = await screen.findByRole('checkbox', {
        name: 'bdboard-boom を選択',
      });
      await user.click(checkbox);
      expect(await screen.findByText('1件選択中')).toBeInTheDocument();

      // 選択はビューを跨いで残る (PR#129) が、カードを並べないビューでは
      // 操作バーは出ない。
      await user.click(screen.getByRole('button', { name: viewLabel }));
      expect(screen.queryByText('1件選択中')).toBeNull();
    },
  );
});
