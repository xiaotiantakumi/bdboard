// bdboard-sso1.88: TicketDetailPanel.test.tsx (2764行) から move-only で分割した
// 「comment-form」関心のファイル。関数本体・アサーション・フィクスチャの値は
// 元ファイルから1文字も変えていない。

import { QueryClient } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchTicket,
  fetchTicketComments,
  fetchSimilarTickets,
  postTicketComment,
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
    postTicketComment: vi.fn(),
    fetchPlatformSupport: vi.fn(),
    fetchTicketRuns: vi.fn(),
    fetchTicketInFlightOverlaps: vi.fn(),
    fetchProjectHarnessStatus: vi.fn(),
  };
});

const mockFetchTicket = vi.mocked(fetchTicket);
const mockFetchTicketComments = vi.mocked(fetchTicketComments);
const mockFetchSimilarTickets = vi.mocked(fetchSimilarTickets);
const mockPostTicketComment = vi.mocked(postTicketComment);
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

describe('TicketDetailPanel comment form', () => {
  let user: ReturnType<typeof userEvent.setup>;

  beforeEach(() => {
    mockFetchTicket.mockResolvedValue(sampleTicket);
    mockFetchTicketComments.mockResolvedValue([]);
    mockPostTicketComment.mockResolvedValue(undefined);
    user = userEvent.setup();
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('disables submit when comment text is empty', async () => {
    renderPanel(new Map());

    const submitButton = await screen.findByRole('button', {
      name: 'コメントを投稿',
    });
    expect(submitButton).toBeDisabled();
  });

  it('posts comment and invalidates ticket and comment queries', async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderPanel(new Map(), undefined, undefined, queryClient);

    await user.type(
      await screen.findByLabelText('コメントを追加'),
      'quick note',
    );
    await user.click(screen.getByRole('button', { name: 'コメントを投稿' }));

    await waitFor(() => {
      expect(mockPostTicketComment).toHaveBeenCalledWith(
        sampleTicket.id,
        'quick note',
      );
    });

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['ticket', sampleTicket.id],
      });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['ticket-comments', sampleTicket.id],
      });
    });
  });

  it('shows error message when comment post fails', async () => {
    mockPostTicketComment.mockRejectedValue(new Error('comment failed'));

    renderPanel(new Map());

    await user.type(
      await screen.findByLabelText('コメントを追加'),
      'quick note',
    );
    await user.click(screen.getByRole('button', { name: 'コメントを投稿' }));

    expect(await screen.findByText('comment failed')).toBeInTheDocument();
  });
});
