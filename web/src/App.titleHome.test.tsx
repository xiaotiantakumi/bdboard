// bdboard-sb45: ヘッダー左上の「bdboard」はボード (チケット画面) に戻るボタン。
// 設定画面からの戻り道が「⋯ → ボードに戻る」にしか無く気づけなかったための入口。

import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return {
    ...actual,
    fetchProjects: vi.fn(),
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

import { primeAppApiMocks, renderApp, selectOverflowItem } from './test/appHarness';

const TITLE_BUTTON = { name: 'bdboard ボードに戻る' } as const;

describe('header title returns to the board (bdboard-sb45)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    primeAppApiMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('exposes the title as a named button inside the h1', async () => {
    renderApp();
    await screen.findByTitle('Board card stays alive');

    const button = screen.getByRole('button', TITLE_BUTTON);
    expect(button.closest('h1')).not.toBeNull();
    expect(button).toHaveTextContent('bdboard');
  });

  it('returns from the settings view to the board when clicked', async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByTitle('Board card stays alive');

    await selectOverflowItem(user, '設定');
    expect(screen.queryByTitle('Board card stays alive')).toBeNull();

    await user.click(screen.getByRole('button', TITLE_BUTTON));

    expect(await screen.findByTitle('Board card stays alive')).toBeInTheDocument();
  });

  it('returns to the board with the keyboard (Enter) and keeps working on the board', async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByTitle('Board card stays alive');

    await selectOverflowItem(user, '設定');
    expect(screen.queryByTitle('Board card stays alive')).toBeNull();

    screen.getByRole('button', TITLE_BUTTON).focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByTitle('Board card stays alive')).toBeInTheDocument();

    // すでにボードのときに押しても何も壊さない。
    await user.click(screen.getByRole('button', TITLE_BUTTON));
    expect(screen.getByTitle('Board card stays alive')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^その他のメニュー/ })).toBeInTheDocument();
  });
});
