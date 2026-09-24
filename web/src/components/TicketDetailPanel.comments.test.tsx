// bdboard-sso1.88: TicketDetailPanel.test.tsx (2764行) から move-only で分割した
// 「comments」関心のファイル。関数本体・アサーション・フィクスチャの値は
// 元ファイルから1文字も変えていない。

import { QueryClient } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommentDto } from '../api';
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

describe('TicketDetailPanel comments', () => {
  beforeEach(() => {
    mockFetchTicket.mockReset();
    mockFetchTicketComments.mockReset();
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows empty message without calling comments API when commentCount is 0', async () => {
    mockFetchTicket.mockResolvedValue({ ...sampleTicket, commentCount: 0 });

    renderPanel(new Map());

    expect(await screen.findByText('コメントはありません')).toBeInTheDocument();
    expect(mockFetchTicketComments).not.toHaveBeenCalled();
  });

  it('shows comments when commentCount is greater than 0', async () => {
    const comments: CommentDto[] = [
      {
        id: 'comment-1',
        issueId: sampleTicket.id,
        author: 'Alice',
        text: 'First comment',
        createdAt: '2026-08-14T10:00:00.000Z',
      },
      {
        id: 'comment-2',
        issueId: sampleTicket.id,
        author: 'Bob',
        text: 'Second comment',
        createdAt: '2026-08-14T11:00:00.000Z',
      },
    ];

    mockFetchTicket.mockResolvedValue({ ...sampleTicket, commentCount: 2 });
    mockFetchTicketComments.mockResolvedValue(comments);

    renderPanel(new Map());

    expect(await screen.findByText('First comment')).toBeInTheDocument();
    expect(screen.getByText('Second comment')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(mockFetchTicketComments).toHaveBeenCalledWith(sampleTicket.id);
  });

  it('shows loading state while comments are loading', async () => {
    let resolveComments: (value: CommentDto[]) => void = () => {};
    const commentsPromise = new Promise<CommentDto[]>((resolve) => {
      resolveComments = resolve;
    });

    mockFetchTicket.mockResolvedValue({ ...sampleTicket, commentCount: 1 });
    mockFetchTicketComments.mockReturnValue(commentsPromise);

    renderPanel(new Map());

    expect(await screen.findByText('読み込み中…')).toBeInTheDocument();

    resolveComments([
      {
        id: 'comment-1',
        issueId: sampleTicket.id,
        author: 'Alice',
        text: 'Loaded comment',
        createdAt: '2026-08-14T10:00:00.000Z',
      },
    ]);

    expect(await screen.findByText('Loaded comment')).toBeInTheDocument();
  });

  it('shows error message when comments API fails', async () => {
    mockFetchTicket.mockResolvedValue({ ...sampleTicket, commentCount: 1 });
    mockFetchTicketComments.mockRejectedValue(new Error('comments failed'));

    renderPanel(new Map());

    expect(await screen.findByText('comments failed')).toBeInTheDocument();
  });

  it('does not double-fetch comments on initial mount', async () => {
    const comments: CommentDto[] = [
      {
        id: 'comment-1',
        issueId: sampleTicket.id,
        author: 'Alice',
        text: 'First comment',
        createdAt: '2026-08-14T10:00:00.000Z',
      },
    ];

    mockFetchTicket.mockResolvedValue({ ...sampleTicket, commentCount: 1 });
    mockFetchTicketComments.mockResolvedValue(comments);

    renderPanel(new Map());

    expect(await screen.findByText('First comment')).toBeInTheDocument();
    expect(mockFetchTicketComments).toHaveBeenCalledTimes(1);
  });

  it('refetches comments when commentCount changes from 1 to 2', async () => {
    const comments: CommentDto[] = [
      {
        id: 'comment-1',
        issueId: sampleTicket.id,
        author: 'Alice',
        text: 'First comment',
        createdAt: '2026-08-14T10:00:00.000Z',
      },
    ];

    mockFetchTicket
      .mockResolvedValueOnce({ ...sampleTicket, commentCount: 1 })
      .mockResolvedValueOnce({ ...sampleTicket, commentCount: 2 });
    mockFetchTicketComments.mockResolvedValue(comments);

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    renderPanel(new Map(), undefined, undefined, queryClient);

    await waitFor(() => {
      expect(mockFetchTicketComments).toHaveBeenCalledTimes(1);
    });

    await queryClient.invalidateQueries({ queryKey: ['ticket', sampleTicket.id] });

    await waitFor(() => {
      expect(mockFetchTicketComments).toHaveBeenCalledTimes(2);
    });
  });
});
