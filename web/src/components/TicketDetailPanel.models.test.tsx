// bdboard-sso1.88: TicketDetailPanel.test.tsx (2764行) から move-only で分割した
// 「models」関心のファイル。関数本体・アサーション・フィクスチャの値は
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

describe('TicketDetailPanel models', () => {
  beforeEach(() => {
    mockFetchTicketComments.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows stage and model names in server-provided order', async () => {
    mockFetchTicket.mockResolvedValue({
      ...sampleTicket,
      models: [
        { stage: 'implement', model: 'composer-2.5' },
        { stage: 'test', model: 'opus' },
        { stage: 'review', model: 'fable' },
      ],
    });

    renderPanel(new Map());

    const heading = await screen.findByRole('heading', { name: '使用モデル' });
    const section = heading.closest('.detail-section');
    expect(section).not.toBeNull();

    const stages = [...section!.querySelectorAll('.ticket-model-stage')].map(
      (el) => el.textContent,
    );
    expect(stages).toEqual(['implement', 'test', 'review']);

    const models = [...section!.querySelectorAll('.ticket-model-name')].map(
      (el) => el.textContent,
    );
    expect(models).toEqual(['composer-2.5', 'opus', 'fable']);
  });

  it('does not show the models section when models is empty', async () => {
    mockFetchTicket.mockResolvedValue({
      ...sampleTicket,
      models: [],
    });

    renderPanel(new Map());

    await screen.findByRole('heading', { name: 'セッションリンク' });

    expect(screen.queryByRole('heading', { name: '使用モデル' })).not.toBeInTheDocument();
  });
});
