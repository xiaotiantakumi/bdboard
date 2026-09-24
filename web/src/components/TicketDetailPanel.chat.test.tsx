// bdboard-sso1.88: TicketDetailPanel.test.tsx (2764行) から move-only で分割した
// 「chat」関心のファイル。関数本体・アサーション・フィクスチャの値は
// 元ファイルから1文字も変えていない。

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchTicket,
  fetchSimilarTickets,
  fetchPlatformSupport,
  fetchTicketRuns,
  fetchTicketInFlightOverlaps,
  fetchProjectHarnessStatus,
} from '../api';
import { resetPlatformSupportCache } from './PlatformLimitationNotice';
import { MaximizablePanel, harnessStatus, sampleTicket } from './TicketDetailPanel-test-support';
import { WatchedTicketsProvider } from './WatchedTicketsProvider';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    fetchTicket: vi.fn(),
    fetchSimilarTickets: vi.fn(),
    fetchPlatformSupport: vi.fn(),
    fetchTicketRuns: vi.fn(),
    fetchTicketInFlightOverlaps: vi.fn(),
    fetchProjectHarnessStatus: vi.fn(),
  };
});

const mockFetchTicket = vi.mocked(fetchTicket);
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

describe('TicketDetailPanel chat', () => {
  it('calls onChatAboutTicket with the loaded ticket context', async () => {
    const user = userEvent.setup();
    const onChatAboutTicket = vi.fn();
    mockFetchTicket.mockResolvedValue(sampleTicket);

    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <WatchedTicketsProvider>
          <MaximizablePanel
            ticketId={sampleTicket.id}
            projectRootPaths={new Map()}
            pendingDecision={undefined}
            onClose={() => {}}
            onChatAboutTicket={onChatAboutTicket}
            onFilterByEpic={() => {}}
            onOpenTicket={() => {}}
            isTicketOnBoard={() => true}
          />
        </WatchedTicketsProvider>
      </QueryClientProvider>,
    );

    await user.click(
      await screen.findByRole('button', { name: 'このチケットについてチャット' }),
    );

    expect(onChatAboutTicket).toHaveBeenCalledWith({
      projectId: sampleTicket.projectId,
      ticketId: sampleTicket.id,
    });
  });

  it('does not render the chat button when onChatAboutTicket is not provided (chat unavailable)', async () => {
    mockFetchTicket.mockResolvedValue(sampleTicket);

    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <WatchedTicketsProvider>
          <MaximizablePanel
            ticketId={sampleTicket.id}
            projectRootPaths={new Map()}
            pendingDecision={undefined}
            onClose={() => {}}
            onFilterByEpic={() => {}}
            onOpenTicket={() => {}}
            isTicketOnBoard={() => true}
          />
        </WatchedTicketsProvider>
      </QueryClientProvider>,
    );

    await screen.findByText(sampleTicket.title);

    expect(
      screen.queryByRole('button', { name: 'このチケットについてチャット' }),
    ).not.toBeInTheDocument();
  });
});
