// bdboard-sso1.88: TicketDetailPanel.test.tsx (2764行) から move-only で分割した
// 「quick-action-undo」関心のファイル。関数本体・アサーション・フィクスチャの値は
// 元ファイルから1文字も変えていない。


import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchTicket,
  fetchTicketComments,
  fetchSimilarTickets,
  postTicketQuickAction,
  postTicketQuickActionUndo,
  fetchPlatformSupport,
  fetchTicketRuns,
  fetchTicketInFlightOverlaps,
  fetchProjectHarnessStatus,
} from '../api';
import { resetPlatformSupportCache } from './PlatformLimitationNotice';
import { MaximizablePanel, harnessStatus, sampleTicket } from './TicketDetailPanel-test-support';
import { UndoSnackbarProvider } from './UndoSnackbar';
import { WatchedTicketsProvider } from './WatchedTicketsProvider';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    fetchTicket: vi.fn(),
    fetchTicketComments: vi.fn(),
    fetchSimilarTickets: vi.fn(),
    postTicketQuickAction: vi.fn(),
    postTicketQuickActionUndo: vi.fn(),
    fetchPlatformSupport: vi.fn(),
    fetchTicketRuns: vi.fn(),
    fetchTicketInFlightOverlaps: vi.fn(),
    fetchProjectHarnessStatus: vi.fn(),
  };
});

const mockFetchTicket = vi.mocked(fetchTicket);
const mockFetchTicketComments = vi.mocked(fetchTicketComments);
const mockFetchSimilarTickets = vi.mocked(fetchSimilarTickets);
const mockPostTicketQuickAction = vi.mocked(postTicketQuickAction);
const mockPostTicketQuickActionUndo = vi.mocked(postTicketQuickActionUndo);
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

function renderPanelWithUndoSnackbar(
  projectRootPaths: ReadonlyMap<string, string>,
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  }),
) {
  const view = render(
    <UndoSnackbarProvider>
      <QueryClientProvider client={queryClient}>
        <WatchedTicketsProvider>
          <MaximizablePanel
            ticketId={sampleTicket.id}
            projectRootPaths={projectRootPaths}
            pendingDecision={undefined}
            onClose={() => {}}
            onChatAboutTicket={() => {}}
            onOpenTicket={() => {}}
            isTicketOnBoard={() => true}
            onFilterByEpic={() => {}}
          />
        </WatchedTicketsProvider>
      </QueryClientProvider>
    </UndoSnackbarProvider>,
  );

  return { ...view, queryClient };
}

describe('TicketDetailPanel quick action undo snackbar', () => {
  let user: ReturnType<typeof userEvent.setup>;

  beforeEach(() => {
    mockFetchTicket.mockResolvedValue(sampleTicket);
    mockFetchTicketComments.mockResolvedValue([]);
    mockPostTicketQuickAction.mockResolvedValue(undefined);
    mockPostTicketQuickActionUndo.mockResolvedValue(undefined);
    user = userEvent.setup();
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows an undo snackbar after claim and posts unclaim-equivalent undo on click', async () => {
    renderPanelWithUndoSnackbar(new Map());

    const claimButtons = await screen.findAllByRole('button', { name: '着手' });
    await user.click(claimButtons[0]!);
    await user.click(screen.getByRole('button', { name: '実行する' }));

    await waitFor(() => {
      expect(mockPostTicketQuickAction).toHaveBeenCalledWith(sampleTicket.id, {
        action: 'claim',
      });
    });

    expect(await screen.findByText('着手しました')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '元に戻す' }));

    await waitFor(() => {
      expect(mockPostTicketQuickActionUndo).toHaveBeenCalledWith(
        sampleTicket.id,
        { action: 'claim' },
      );
    });
    expect(await screen.findByText('元に戻しました')).toBeInTheDocument();
  });

  it('carries the pre-change priority into the undo request', async () => {
    renderPanelWithUndoSnackbar(new Map());

    const raiseButtons = await screen.findAllByRole('button', {
      name: '優先度を上げる',
    });
    await user.click(raiseButtons[0]!);
    await user.click(screen.getByRole('button', { name: '実行する' }));

    await waitFor(() => {
      expect(mockPostTicketQuickAction).toHaveBeenCalledWith(sampleTicket.id, {
        action: 'priority',
        priority: sampleTicket.priority - 1,
      });
    });

    await user.click(
      await screen.findByRole('button', { name: '元に戻す' }),
    );

    await waitFor(() => {
      // sampleTicket.priority (=2) はアクション実行前の値。invalidate 後の
      // 新しい値(1)ではなく、実行前の値へ戻すリクエストになっていることを確認する。
      // expectedCurrentPriority はクイックアクションで実際にセットした値
      // (priority - 1)で、サーバー側の CAS チェック(bdboard-3tw.82)の期待値になる。
      expect(mockPostTicketQuickActionUndo).toHaveBeenCalledWith(
        sampleTicket.id,
        {
          action: 'priority',
          previousPriority: sampleTicket.priority,
          expectedCurrentPriority: sampleTicket.priority - 1,
        },
      );
    });
  });

  it('surfaces a visible failure instead of silently succeeding when undo fails', async () => {
    mockPostTicketQuickActionUndo.mockRejectedValue(
      new Error('issue is assigned to a different actor'),
    );

    renderPanelWithUndoSnackbar(new Map());

    const claimButtons = await screen.findAllByRole('button', { name: '着手' });
    await user.click(claimButtons[0]!);
    await user.click(screen.getByRole('button', { name: '実行する' }));

    await user.click(
      await screen.findByRole('button', { name: '元に戻す' }),
    );

    expect(
      await screen.findByText(
        '元に戻せませんでした: issue is assigned to a different actor',
      ),
    ).toBeInTheDocument();
  });
});

