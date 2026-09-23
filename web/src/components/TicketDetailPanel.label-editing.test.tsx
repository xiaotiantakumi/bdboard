// bdboard-sso1.88: TicketDetailPanel.test.tsx (2764行) から move-only で分割した
// 「label-editing」関心のファイル。関数本体・アサーション・フィクスチャの値は
// 元ファイルから1文字も変えていない。

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TicketDetailDto } from '../api';
import {
  fetchTicket,
  fetchTicketComments,
  fetchSimilarTickets,
  postTicketAddLabel,
  deleteTicketLabel,
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
    postTicketAddLabel: vi.fn(),
    deleteTicketLabel: vi.fn(),
    fetchPlatformSupport: vi.fn(),
    fetchTicketRuns: vi.fn(),
    fetchTicketInFlightOverlaps: vi.fn(),
    fetchProjectHarnessStatus: vi.fn(),
  };
});

const mockFetchTicket = vi.mocked(fetchTicket);
const mockFetchTicketComments = vi.mocked(fetchTicketComments);
const mockFetchSimilarTickets = vi.mocked(fetchSimilarTickets);
const mockPostTicketAddLabel = vi.mocked(postTicketAddLabel);
const mockDeleteTicketLabel = vi.mocked(deleteTicketLabel);
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

describe('TicketDetailPanel label editing', () => {
  let user: ReturnType<typeof userEvent.setup>;

  const ticketWithLabels: TicketDetailDto = {
    ...sampleTicket,
    labels: ['human'],
  };

  beforeEach(() => {
    mockFetchTicket.mockResolvedValue(ticketWithLabels);
    mockFetchTicketComments.mockResolvedValue([]);
    mockPostTicketAddLabel.mockResolvedValue(undefined);
    mockDeleteTicketLabel.mockResolvedValue(undefined);
    user = userEvent.setup();
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('adds a label from the input', async () => {
    renderPanel(new Map(), undefined, undefined, undefined, [
      'human',
      'needs-review',
    ]);

    const input = await screen.findByLabelText('ラベルを追加');
    await user.type(input, 'needs-review');
    await user.click(screen.getByRole('button', { name: '追加' }));

    await waitFor(() => {
      expect(mockPostTicketAddLabel).toHaveBeenCalledWith(
        sampleTicket.id,
        'needs-review',
      );
    });
  });

  it('removes an existing label', async () => {
    renderPanel(new Map());

    await user.click(
      await screen.findByRole('button', { name: 'ラベル human を削除' }),
    );

    await waitFor(() => {
      expect(mockDeleteTicketLabel).toHaveBeenCalledWith(
        sampleTicket.id,
        'human',
      );
    });
  });

  it('shows label suggestions from availableLabels', async () => {
    renderPanel(new Map(), undefined, undefined, undefined, [
      'human',
      'needs-review',
    ]);

    const input = await screen.findByLabelText('ラベルを追加');
    await user.type(input, 'need');

    const suggestionList = document.querySelector('.label-suggestions');
    expect(suggestionList).not.toBeNull();
    expect(
      within(suggestionList as HTMLElement).getByText('needs-review'),
    ).toBeInTheDocument();
    expect(
      within(suggestionList as HTMLElement).queryByText('human'),
    ).not.toBeInTheDocument();
  });
});
