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

// 描画中に throw するコンポーネントの代表として詳細パネルを差し替える。
// bdboard-yfq のきっかけ (bdboard-ol9 の日付整形が不正入力で RangeError を
// 投げうる) が、まさにこのパネル内の描画だったため。
vi.mock('./components/TicketDetailPanel', () => ({
  TicketDetailPanel: () => {
    throw new Error('detail panel exploded');
  },
}));

import { primeAppApiMocks, renderApp } from './test/appHarness';

describe('App error boundaries (bdboard-yfq)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    primeAppApiMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps the board usable when the ticket detail panel throws', async () => {
    const user = userEvent.setup();
    renderApp();

    const card = await screen.findByTitle('Board card stays alive');
    await user.click(card);

    // 詳細パネルだけが fallback に置き換わる。
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'チケット詳細の表示に失敗しました',
    );
    // 境界が無い/掛け違えていると、ここで App ごとアンマウントされて
    // ボードもヘッダーも消える (= 画面が真っ白)。
    expect(screen.getByTitle('Board card stays alive')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '設定' })).toBeInTheDocument();
  });

  it('closes the crashed panel from the fallback', async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByTitle('Board card stays alive'));
    await screen.findByRole('alert');

    // 壊れたパネルの中にある閉じるボタンは押せないので、fallback 側が
    // 閉じる導線を持っている必要がある。
    await user.click(screen.getByRole('button', { name: '閉じる' }));

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTitle('Board card stays alive')).toBeInTheDocument();
  });

  it('shows the crashed panel fallback as an overlay, not at the end of the page', async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByTitle('Board card stays alive'));
    const alert = await screen.findByRole('alert');

    // パネルは自前で暗幕 (.overlay) を張っているので、throw するとそれごと消える。
    // fallback を通常フローに置くと、縦に長いボードでは画面外に落ちて
    // 「クリックしても何も起きない」ようにしか見えない (PR#129 レビュー)。
    expect(alert.parentElement).toHaveClass('overlay');
  });

  it('keeps the bulk selection when the view changes', async () => {
    const user = userEvent.setup();
    renderApp();

    await screen.findByTitle('Board card stays alive');
    const checkbox = screen.getByRole('checkbox', { name: 'bdboard-boom を選択' });
    await user.click(checkbox);
    expect(checkbox).toBeChecked();

    await user.click(screen.getByRole('button', { name: '分割' }));
    await user.click(screen.getByRole('button', { name: '統合' }));

    // ビュー境界は key={view} で作り直される。選択プロバイダーをその内側に
    // 置くと再マウントが伝わり、ビューを往復しただけで選択が消える
    // (PR#129 レビュー minor-1)。
    await screen.findByTitle('Board card stays alive');
    expect(
      screen.getByRole('checkbox', { name: 'bdboard-boom を選択' }),
    ).toBeChecked();
  });
});
