// bdboard-sso1.88: TicketDetailPanel.test.tsx (2764行) から move-only で分割した
// 「mobile-header」関心のファイル。関数本体・アサーション・フィクスチャの値は
// 元ファイルから1文字も変えていない。


import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
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

describe('モバイル向けヘッダー配置 (bdboard-h4xs.2)', () => {
  function renderTicketDetailHeader(
    onClose: () => void = vi.fn(),
    onBackTicket?: () => void,
  ) {
    return render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <WatchedTicketsProvider>
          <MaximizablePanel
            ticketId={sampleTicket.id}
            projectRootPaths={new Map()}
            pendingDecision={undefined}
            onClose={onClose}
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

  it('ヘッダーが detail-header と ticket-detail-header の両方を持つ', async () => {
    // CSS の @media ルールは jsdom では効かない。修飾クラスが DOM に付いている
    // ことだけを契約として固定し、ticket-detail-header を落とす変異を殺す。
    renderTicketDetailHeader();

    const header = (await screen.findByRole('heading', { level: 2 })).closest('.detail-header');
    expect(header).not.toBeNull();
    expect(header?.classList.contains('detail-header')).toBe(true);
    expect(header?.classList.contains('ticket-detail-header')).toBe(true);
  });

  it('戻る・最大化・閉じるが同一の detail-header-actions 内にある', async () => {
    // アクション群がヘッダー行から独立したコンテナにまとまっている DOM 契約。
    // ボタンがパネル内の別所へ散らばる変異を within() で殺す。
    renderTicketDetailHeader(() => {}, vi.fn());

    await screen.findByText(sampleTicket.title);

    const header = document.querySelector('.ticket-detail-header');
    expect(header).not.toBeNull();
    const actions = header!.querySelector('.detail-header-actions');
    expect(actions).not.toBeNull();

    const actionScope = within(actions as HTMLElement);
    expect(actionScope.getByRole('button', { name: '前のチケットへ戻る' })).toBeInTheDocument();
    expect(actionScope.getByRole('button', { name: '最大化' })).toBeInTheDocument();
    expect(actionScope.getByRole('button', { name: '閉じる' })).toBeInTheDocument();
  });

  it('閉じるボタンを押すと onClose が呼ばれる', async () => {
    const onClose = vi.fn();
    renderTicketDetailHeader(onClose);

    fireEvent.click(await screen.findByRole('button', { name: '閉じる' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

