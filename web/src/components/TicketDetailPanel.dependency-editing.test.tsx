// bdboard-sso1.88: TicketDetailPanel.test.tsx (2764行) から move-only で分割した
// 「dependency-editing」関心のファイル。関数本体・アサーション・フィクスチャの値は
// 元ファイルから1文字も変えていない。

import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  TicketDetailDto,
  TicketSearchResultDto,
} from '../api';
import {
  ApiError,
  fetchTicket,
  fetchTicketComments,
  fetchSimilarTickets,
  postTicketDependency,
  deleteTicketDependency,
  searchTickets,
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
    postTicketDependency: vi.fn(),
    deleteTicketDependency: vi.fn(),
    searchTickets: vi.fn(),
    fetchPlatformSupport: vi.fn(),
    fetchTicketRuns: vi.fn(),
    fetchTicketInFlightOverlaps: vi.fn(),
    fetchProjectHarnessStatus: vi.fn(),
  };
});

const mockFetchTicket = vi.mocked(fetchTicket);
const mockFetchTicketComments = vi.mocked(fetchTicketComments);
const mockFetchSimilarTickets = vi.mocked(fetchSimilarTickets);
const mockPostTicketDependency = vi.mocked(postTicketDependency);
const mockDeleteTicketDependency = vi.mocked(deleteTicketDependency);
const mockSearchTickets = vi.mocked(searchTickets);
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

describe('TicketDetailPanel dependency editing', () => {
  let user: ReturnType<typeof userEvent.setup>;

  const ticketWithDependencies: TicketDetailDto = {
    ...sampleTicket,
    dependencies: [
      {
        issueId: sampleTicket.id,
        dependsOnId: 'bdboard-blocker',
        kind: 'blocks',
      },
      {
        issueId: sampleTicket.id,
        dependsOnId: 'bdboard-parent',
        kind: 'parent-child',
      },
    ],
  };

  const searchResults: TicketSearchResultDto[] = [
    {
      id: 'bdboard-same.1',
      projectId: 'proj-1',
      projectName: 'Project One',
      title: 'Same project candidate',
      status: 'open',
      priority: 2,
      issueType: 'task',
    },
    {
      id: 'bdboard-other.1',
      projectId: 'proj-2',
      projectName: 'Project Two',
      title: 'Other project candidate',
      status: 'open',
      priority: 2,
      issueType: 'task',
    },
  ];

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockFetchTicket.mockResolvedValue(ticketWithDependencies);
    mockFetchTicketComments.mockResolvedValue([]);
    mockPostTicketDependency.mockResolvedValue(undefined);
    mockDeleteTicketDependency.mockResolvedValue(undefined);
    mockSearchTickets.mockResolvedValue(searchResults);
    user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows remove button only for blocks dependencies', async () => {
    renderPanel(new Map());

    expect(
      await screen.findByRole('button', {
        name: 'bdboard-blocker への依存を削除',
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', {
        name: 'bdboard-parent への依存を削除',
      }),
    ).not.toBeInTheDocument();
  });

  it('calls deleteTicketDependency when remove button is clicked', async () => {
    renderPanel(new Map());

    await user.click(
      await screen.findByRole('button', {
        name: 'bdboard-blocker への依存を削除',
      }),
    );

    await waitFor(() => {
      expect(mockDeleteTicketDependency).toHaveBeenCalledWith(
        sampleTicket.id,
        'bdboard-blocker',
      );
    });
  });

  it('searches and shows same-project candidates after debounce', async () => {
    renderPanel(new Map());

    await user.type(
      await screen.findByLabelText('依存を追加(このチケットが待つ相手)'),
      'candidate',
    );

    expect(mockSearchTickets).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);

    await waitFor(() => {
      expect(mockSearchTickets).toHaveBeenCalledWith('candidate', 20);
    });

    expect(await screen.findByText('Same project candidate')).toBeInTheDocument();
    expect(screen.queryByText('Other project candidate')).not.toBeInTheDocument();
  });

  it('ignores stale dependency search responses when an older request resolves after a newer one', async () => {
    const oldResults: TicketSearchResultDto[] = [
      {
        id: 'bdboard-old',
        projectId: 'proj-1',
        projectName: 'Project One',
        title: 'Old stale result',
        status: 'open',
        priority: 3,
        issueType: 'task',
      },
    ];
    const newResults: TicketSearchResultDto[] = [
      {
        id: 'bdboard-new',
        projectId: 'proj-1',
        projectName: 'Project One',
        title: 'New correct result',
        status: 'open',
        priority: 1,
        issueType: 'task',
      },
    ];

    let resolveOld: (value: TicketSearchResultDto[]) => void;
    let resolveNew: (value: TicketSearchResultDto[]) => void;
    const oldPromise = new Promise<TicketSearchResultDto[]>((resolve) => {
      resolveOld = resolve;
    });
    const newPromise = new Promise<TicketSearchResultDto[]>((resolve) => {
      resolveNew = resolve;
    });

    mockSearchTickets
      .mockReset()
      .mockImplementationOnce(() => oldPromise)
      .mockImplementationOnce(() => newPromise);

    renderPanel(new Map());

    const input = await screen.findByLabelText(
      '依存を追加(このチケットが待つ相手)',
    );

    fireEvent.change(input, { target: { value: 'abc' } });
    await vi.advanceTimersByTimeAsync(200);
    await waitFor(() => {
      expect(mockSearchTickets).toHaveBeenCalledWith('abc', 20);
    });

    fireEvent.change(input, { target: { value: 'abcd' } });
    await vi.advanceTimersByTimeAsync(200);
    await waitFor(() => {
      expect(mockSearchTickets).toHaveBeenCalledWith('abcd', 20);
    });

    resolveNew!(newResults);
    expect(await screen.findByText('New correct result')).toBeInTheDocument();

    resolveOld!(oldResults);
    await waitFor(() => {
      expect(screen.getByText('New correct result')).toBeInTheDocument();
      expect(screen.queryByText('Old stale result')).not.toBeInTheDocument();
    });
  });

  it('calls postTicketDependency when a candidate is selected', async () => {
    renderPanel(new Map());

    await user.type(
      await screen.findByLabelText('依存を追加(このチケットが待つ相手)'),
      'candidate',
    );
    await vi.advanceTimersByTimeAsync(200);

    await user.click(await screen.findByText('Same project candidate'));

    await waitFor(() => {
      expect(mockPostTicketDependency).toHaveBeenCalledWith(
        sampleTicket.id,
        'bdboard-same.1',
      );
    });
  });

  it('shows bd circular dependency detail when add fails with 502', async () => {
    mockPostTicketDependency.mockRejectedValue(
      new ApiError(502, 'failed to add dependency', {
        errorMessage: 'failed to add dependency',
        detail: 'would create circular dependency: bdboard-abc.1 -> bdboard-same.1',
      }),
    );

    renderPanel(new Map());

    await user.type(
      await screen.findByLabelText('依存を追加(このチケットが待つ相手)'),
      'candidate',
    );
    await vi.advanceTimersByTimeAsync(200);
    await user.click(await screen.findByText('Same project candidate'));

    expect(
      await screen.findByText(
        'would create circular dependency: bdboard-abc.1 -> bdboard-same.1',
      ),
    ).toBeInTheDocument();
  });
});
