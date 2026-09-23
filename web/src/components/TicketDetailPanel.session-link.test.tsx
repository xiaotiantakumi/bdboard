// bdboard-sso1.88: TicketDetailPanel.test.tsx (2764行) から move-only で分割した
// 「session-link」関心のファイル。関数本体・アサーション・フィクスチャの値は
// 元ファイルから1文字も変えていない。

import { QueryClient } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionDto } from '../api';
import {
  ApiError,
  fetchTicket,
  fetchTicketComments,
  fetchSimilarTickets,
  fetchSessions,
  fetchPlatformSupport,
  postTicketSessionLink,
  deleteTicketSessionLink,
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
    fetchSessions: vi.fn(),
    fetchPlatformSupport: vi.fn(),
    postTicketSessionLink: vi.fn(),
    deleteTicketSessionLink: vi.fn(),
    fetchTicketRuns: vi.fn(),
    fetchTicketInFlightOverlaps: vi.fn(),
    fetchProjectHarnessStatus: vi.fn(),
  };
});

const mockFetchTicket = vi.mocked(fetchTicket);
const mockFetchTicketComments = vi.mocked(fetchTicketComments);
const mockFetchSimilarTickets = vi.mocked(fetchSimilarTickets);
const mockFetchSessions = vi.mocked(fetchSessions);
const mockFetchPlatformSupport = vi.mocked(fetchPlatformSupport);
const mockPostTicketSessionLink = vi.mocked(postTicketSessionLink);
const mockDeleteTicketSessionLink = vi.mocked(deleteTicketSessionLink);
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

describe('TicketDetailPanel session link', () => {
  let user: ReturnType<typeof userEvent.setup>;

  const activeSessions: SessionDto[] = [
    {
      sessionId: 'session-active-1',
      pid: 111,
      cwd: '/Users/me/projects/bdboard',
      alive: true,
      startedAt: '2026-08-14T09:00:00.000Z',
      lastActivityAt: '2026-08-14T10:00:00.000Z',
      liveness: 'active',
      name: 'Active session one',
    },
    {
      sessionId: 'session-dead-1',
      pid: 222,
      cwd: '/Users/me/projects/bdboard',
      alive: false,
      startedAt: '2026-08-14T09:00:00.000Z',
      lastActivityAt: '2026-08-14T09:30:00.000Z',
      liveness: 'dormant',
    },
  ];

  beforeEach(() => {
    mockFetchTicket.mockResolvedValue(sampleTicket);
    mockFetchTicketComments.mockResolvedValue([]);
    mockFetchSessions.mockResolvedValue(activeSessions);
    mockPostTicketSessionLink.mockResolvedValue(undefined);
    mockDeleteTicketSessionLink.mockResolvedValue(undefined);
    user = userEvent.setup();
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows empty message when there are no session links', async () => {
    renderPanel(new Map());

    expect(
      await screen.findByText('リンクされたセッションはありません'),
    ).toBeInTheDocument();
  });

  it('shows manual and inferred badges and only offers unlink for manual links', async () => {
    mockFetchTicket.mockResolvedValue({
      ...sampleTicket,
      sessionLinks: [
        { sessionId: 'session-manual', source: 'metadata' },
        { sessionId: 'session-inferred', source: 'transcript' },
      ],
    });

    renderPanel(new Map());

    expect(await screen.findByText('session-manual')).toBeInTheDocument();
    expect(screen.getByText('session-inferred')).toBeInTheDocument();
    expect(screen.getByText('手動')).toBeInTheDocument();
    expect(screen.getByText('自動推定')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'session-manual のリンクを解除' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'session-inferred のリンクを解除' }),
    ).not.toBeInTheDocument();
  });

  it('calls deleteTicketSessionLink and invalidates the ticket query when unlink is clicked', async () => {
    mockFetchTicket.mockResolvedValue({
      ...sampleTicket,
      sessionLinks: [{ sessionId: 'session-manual', source: 'metadata' }],
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderPanel(new Map(), undefined, undefined, queryClient);

    await user.click(
      await screen.findByRole('button', {
        name: 'session-manual のリンクを解除',
      }),
    );

    await waitFor(() => {
      expect(mockDeleteTicketSessionLink).toHaveBeenCalledWith(sampleTicket.id);
    });
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['ticket', sampleTicket.id],
      });
    });
  });

  it('does not fetch sessions until the picker is opened', async () => {
    renderPanel(new Map());

    await screen.findByText('リンクされたセッションはありません');
    expect(mockFetchSessions).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole('button', { name: 'セッションをリンク' }),
    );

    await waitFor(() => {
      expect(mockFetchSessions).toHaveBeenCalledTimes(1);
    });
  });

  it('explains why the picker is empty on a platform without session discovery', async () => {
    // win32 ではセッション検出そのものが動かないため、ここは常に空になる。
    // 理由が出ないと「稼働中のセッションがありません」が壊れているようにしか
    // 読めない (bdboard-70z.9, PR#115 fable レビュー minor)。
    mockFetchPlatformSupport.mockResolvedValue({
      platform: 'win32',
      limitations: [
        {
          feature: 'session-discovery',
          reason: '稼働中のエージェントセッションの検出は Windows では利用できません。',
          detail: 'セッション検出は ps と lsof に依存している。',
        },
      ],
    });
    renderPanel(new Map());

    await user.click(
      await screen.findByRole('button', { name: 'セッションをリンク' }),
    );

    expect(
      await screen.findByText(
        '稼働中のエージェントセッションの検出は Windows では利用できません。',
      ),
    ).toBeInTheDocument();
  });

  it('lists only alive sessions as link candidates', async () => {
    renderPanel(new Map());

    await user.click(
      await screen.findByRole('button', { name: 'セッションをリンク' }),
    );

    expect(
      await screen.findByText('Active session one (/Users/me/projects/bdboard)'),
    ).toBeInTheDocument();
    expect(screen.queryByText('session-dead-1')).not.toBeInTheDocument();
  });

  it('calls postTicketSessionLink when a candidate session is selected and closes the picker', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderPanel(new Map(), undefined, undefined, queryClient);

    await user.click(
      await screen.findByRole('button', { name: 'セッションをリンク' }),
    );
    await user.click(
      await screen.findByText('Active session one (/Users/me/projects/bdboard)'),
    );

    await waitFor(() => {
      expect(mockPostTicketSessionLink).toHaveBeenCalledWith(
        sampleTicket.id,
        'session-active-1',
      );
    });
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['ticket', sampleTicket.id],
      });
    });
    // '閉じる' also labels the panel's own close button, so assert on
    // picker-specific content instead of that ambiguous button name.
    await waitFor(() => {
      expect(
        screen.queryByText('Active session one (/Users/me/projects/bdboard)'),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.getByRole('button', { name: 'セッションをリンク' }),
    ).toBeInTheDocument();
  });

  it('shows an error message when linking fails', async () => {
    mockPostTicketSessionLink.mockRejectedValue(
      new ApiError(502, 'failed to link session', {
        errorMessage: 'failed to link session',
        detail: 'bd exited with an error',
      }),
    );

    renderPanel(new Map());

    await user.click(
      await screen.findByRole('button', { name: 'セッションをリンク' }),
    );
    await user.click(
      await screen.findByText('Active session one (/Users/me/projects/bdboard)'),
    );

    expect(
      await screen.findByText('failed to link session'),
    ).toBeInTheDocument();
  });
});
