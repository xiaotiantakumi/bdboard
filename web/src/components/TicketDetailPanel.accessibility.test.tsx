// bdboard-sso1.88: TicketDetailPanel.test.tsx (2764行) から move-only で分割した
// 「accessibility」関心のファイル。関数本体・アサーション・フィクスチャの値は
// 元ファイルから1文字も変えていない。

import { screen } from '@testing-library/react';
import { beforeEach, describe, it, vi } from 'vitest';
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
import { expectNoA11yViolations } from '../test/axe';

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

describe('TicketDetailPanel accessibility', () => {
  beforeEach(() => {
    mockFetchTicket.mockResolvedValue(sampleTicket);
    mockFetchTicketComments.mockResolvedValue([]);
  });

  it('has no a11y violations in the default loaded state', async () => {
    const { container } = renderPanel(new Map());

    await screen.findByText(sampleTicket.title);
    await expectNoA11yViolations(container);
  });
});
