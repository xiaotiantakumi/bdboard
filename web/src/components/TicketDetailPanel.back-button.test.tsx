// bdboard-sso1.88: TicketDetailPanel.test.tsx (2764行) から move-only で分割した
// 「back-button」関心のファイル。関数本体・アサーション・フィクスチャの値は
// 元ファイルから1文字も変えていない。


import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
import { MaximizablePanel, harnessStatus, sampleTicket } from './TicketDetailPanel-test-support';
import { WatchedTicketsProvider } from './WatchedTicketsProvider';

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

describe('パネル内の戻るボタン (bdboard-4ql7)', () => {
  function renderWithBack(onBackTicket?: () => void) {
    return render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <WatchedTicketsProvider>
          <MaximizablePanel
            ticketId={sampleTicket.id}
            projectRootPaths={new Map()}
            pendingDecision={undefined}
            onClose={() => {}}
            onChatAboutTicket={() => {}}
            onOpenTicket={() => {}}
            onBackTicket={onBackTicket}
            isTicketOnBoard={() => true}
            onFilterByEpic={() => {}}
          />
        </WatchedTicketsProvider>
      </QueryClientProvider>,
    );
  }

  beforeEach(() => {
    mockFetchTicket.mockResolvedValue(sampleTicket);
    mockFetchTicketComments.mockResolvedValue([]);
  });

  it('戻り先が無いときはボタンを出さない', async () => {
    renderWithBack(undefined);

    expect(await screen.findByRole('button', { name: '閉じる' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '前のチケットへ戻る' })).not.toBeInTheDocument();
  });

  it('戻り先があるときはボタンを出し、押すとコールバックを呼ぶ', async () => {
    const onBackTicket = vi.fn();
    renderWithBack(onBackTicket);

    const back = await screen.findByRole('button', { name: '前のチケットへ戻る' });
    fireEvent.click(back);

    expect(onBackTicket).toHaveBeenCalledTimes(1);
  });
});
