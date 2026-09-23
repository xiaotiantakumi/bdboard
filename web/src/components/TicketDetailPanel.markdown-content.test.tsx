// bdboard-sso1.88: TicketDetailPanel.test.tsx (2764行) から move-only で分割した
// 「markdown-content」関心のファイル。関数本体・アサーション・フィクスチャの値は
// 元ファイルから1文字も変えていない。


import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('TicketDetailPanel markdown content', () => {
  beforeEach(() => {
    mockFetchTicket.mockReset();
    mockFetchTicketComments.mockReset();
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders description and notes as markdown', async () => {
    mockFetchTicket.mockResolvedValue({
      ...sampleTicket,
      description: '**Bold** description with `code`',
      notes: '- note one\n- note two',
    });

    renderPanel(new Map());

    expect(await screen.findByText('Bold')).toBeInTheDocument();
    expect(screen.getByText('description with')).toBeInTheDocument();
    expect(screen.getByText('code')).toBeInTheDocument();
    expect(screen.getByText('note one')).toBeInTheDocument();
    expect(screen.getByText('note two')).toBeInTheDocument();
  });

  it('renders comment text as markdown', async () => {
    mockFetchTicket.mockResolvedValue({ ...sampleTicket, commentCount: 1 });
    mockFetchTicketComments.mockResolvedValue([
      {
        id: 'comment-md',
        issueId: sampleTicket.id,
        author: 'Alice',
        text: 'See [docs](https://example.com) and `patch`',
        createdAt: '2026-08-14T10:00:00.000Z',
      },
    ]);

    renderPanel(new Map());

    expect(await screen.findByRole('link', { name: 'docs' })).toHaveAttribute(
      'href',
      'https://example.com',
    );
    expect(screen.getByText('patch')).toBeInTheDocument();
  });
});

