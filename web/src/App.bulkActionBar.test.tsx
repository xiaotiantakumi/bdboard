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
  bdboard-ml0k: Next Up でもカードのチェックボックスは出て選択も入るのに、
  一括操作バーだけがビューのガードで消えていた (選べるのに何もできない)。
  「チェックボックスが出るビューでは操作バーも出る」を固定する。
*/
describe('App bulk action bar visibility (bdboard-ml0k)', () => {
  beforeEach(() => {
    primeAppApiMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows the bulk action bar in Next Up once a card is selected', async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole('button', { name: 'Next Up' }));

    // 選択前はどのビューでも出ない (selectedCount === 0 の早期 return)。
    expect(screen.queryByText('1件選択中')).toBeNull();

    // Next Up のカードにチェックボックスが出ていること自体が前提。
    // これが無ければバグの形が変わるので、ここで一緒に固定する。
    const checkbox = await screen.findByRole('checkbox', {
      name: 'bdboard-boom を選択',
    });
    await user.click(checkbox);

    expect(await screen.findByText('1件選択中')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '全解除' })).toBeInTheDocument();
  });

  it('keeps the bar out of views that do not render cards', async () => {
    const user = userEvent.setup();
    renderApp();

    const checkbox = await screen.findByRole('checkbox', {
      name: 'bdboard-boom を選択',
    });
    await user.click(checkbox);
    expect(await screen.findByText('1件選択中')).toBeInTheDocument();

    // 選択はビューを跨いで残る (PR#129) が、カードを並べないビューでは
    // 操作バーは出ない。ガードを「常に出す」に緩めるとここが落ちる。
    await user.click(screen.getByRole('button', { name: '統計' }));
    expect(screen.queryByText('1件選択中')).toBeNull();
  });
});
