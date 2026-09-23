// bdboard-sso1.88: TicketDetailPanel.test.tsx (2764行) から move-only で分割した
// 「activity-timeline」関心のファイル。関数本体・アサーション・フィクスチャの値は
// 元ファイルから1文字も変えていない。


import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityEventDto } from '../api';
import {
  fetchTicket,
  fetchTicketComments,
  fetchTicketTimeline,
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
    fetchTicketTimeline: vi.fn(),
    fetchSimilarTickets: vi.fn(),
    fetchPlatformSupport: vi.fn(),
    fetchTicketRuns: vi.fn(),
    fetchTicketInFlightOverlaps: vi.fn(),
    fetchProjectHarnessStatus: vi.fn(),
  };
});

const mockFetchTicket = vi.mocked(fetchTicket);
const mockFetchTicketComments = vi.mocked(fetchTicketComments);
const mockFetchTicketTimeline = vi.mocked(fetchTicketTimeline);
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

describe('変更履歴タイムライン', () => {
  const user = userEvent.setup();

  beforeEach(() => {
    mockFetchTicket.mockResolvedValue(sampleTicket);
    mockFetchTicketComments.mockResolvedValue([]);
    mockFetchTicketTimeline.mockResolvedValue([
      {
        kind: 'status_changed',
        at: '2026-06-01T09:00:00.000Z',
        id: sampleTicket.id,
        projectId: sampleTicket.projectId,
        projectName: 'Example project',
        title: sampleTicket.title,
        status: sampleTicket.status,
        priority: sampleTicket.priority,
        issueType: sampleTicket.issueType,
        actor: 'example-actor',
        from: 'open',
        to: 'in_progress',
      } satisfies ActivityEventDto,
    ]);
  });

  it('loads timeline when expanded and shows enriched status change', async () => {
    renderPanel(new Map());

    await user.click(await screen.findByRole('button', { name: '表示' }));

    await waitFor(() => {
      expect(mockFetchTicketTimeline).toHaveBeenCalledWith(sampleTicket.id);
    });

    expect(await screen.findByText('状態変更')).toBeInTheDocument();
    expect(screen.getByText(/@example-actor/)).toBeInTheDocument();
    expect(screen.getByText(/open → in_progress/)).toBeInTheDocument();
  });

  it('loads and shows similar tickets in the detail panel', async () => {
    mockFetchSimilarTickets.mockResolvedValue([
      {
        id: 'bdboard-similar',
        projectId: sampleTicket.projectId,
        projectName: 'Example project',
        title: 'Similar ticket detection',
        status: 'open',
        priority: 2,
        issueType: 'task',
        score: 0.82,
      },
    ]);

    renderPanel(new Map());

    await waitFor(() => {
      expect(mockFetchSimilarTickets).toHaveBeenCalledWith(sampleTicket.id);
    });

    expect(await screen.findByText('似ているチケット')).toBeInTheDocument();
    expect(screen.getByText('Similar ticket detection')).toBeInTheDocument();
    expect(screen.getByText('82%')).toBeInTheDocument();
  });

  it('shows in-flight file overlaps with the conflicting ticket and files', async () => {
    mockFetchTicket.mockResolvedValue({ ...sampleTicket, status: 'in_progress' });
    mockFetchTicketInFlightOverlaps.mockResolvedValue([
      { ticketId: 'bdboard-peer', files: ['src/domain/hygiene.ts', 'web/src/api.ts'] },
    ]);

    renderPanel(new Map());

    await waitFor(() => {
      expect(mockFetchTicketInFlightOverlaps).toHaveBeenCalledWith(sampleTicket.id);
    });

    expect(await screen.findByText('衝突しうる着手中チケット')).toBeInTheDocument();
    expect(screen.getByText('bdboard-peer')).toBeInTheDocument();
    expect(screen.getByText('src/domain/hygiene.ts')).toBeInTheDocument();
    expect(screen.getByText('web/src/api.ts')).toBeInTheDocument();
    expect(screen.getByText('2 ファイル')).toBeInTheDocument();
  });

  it('hides the overlap section when there is nothing to warn about', async () => {
    mockFetchTicket.mockResolvedValue({ ...sampleTicket, status: 'in_progress' });
    mockFetchTicketInFlightOverlaps.mockResolvedValue([]);

    renderPanel(new Map());

    expect(await screen.findByText('似ているチケット')).toBeInTheDocument();
    expect(screen.queryByText('衝突しうる着手中チケット')).not.toBeInTheDocument();
  });

  it('caps the file list and counts the rest', async () => {
    const files = Array.from({ length: 23 }, (_, index) => `src/file-${index}.ts`);
    mockFetchTicket.mockResolvedValue({ ...sampleTicket, status: 'in_progress' });
    mockFetchTicketInFlightOverlaps.mockResolvedValue([
      { ticketId: 'bdboard-peer', files },
    ]);

    renderPanel(new Map());

    expect(await screen.findByText('衝突しうる着手中チケット')).toBeInTheDocument();
    // バッジは全件、一覧は 20 件 + 残りの件数
    expect(screen.getByText('23 ファイル')).toBeInTheDocument();
    expect(screen.getByText('src/file-19.ts')).toBeInTheDocument();
    expect(screen.queryByText('src/file-20.ts')).not.toBeInTheDocument();
    expect(screen.getByText('ほか 3 件')).toBeInTheDocument();
  });

  it('shows a single line when the overlap check fails', async () => {
    mockFetchTicket.mockResolvedValue({ ...sampleTicket, status: 'in_progress' });
    mockFetchTicketInFlightOverlaps.mockRejectedValue(new Error('git exploded'));

    renderPanel(new Map());

    expect(
      await screen.findByText('重複チェックを実行できませんでした。'),
    ).toBeInTheDocument();
  });

  it('does not query overlaps for a closed ticket', async () => {
    mockFetchTicket.mockResolvedValue({ ...sampleTicket, status: 'closed' });
    // 呼び出し履歴はファイル内で共有されるので、この test 内の呼び出しだけを見る
    mockFetchTicketInFlightOverlaps.mockClear();

    renderPanel(new Map());

    expect(await screen.findByText('似ているチケット')).toBeInTheDocument();
    expect(mockFetchTicketInFlightOverlaps).not.toHaveBeenCalled();
  });
});

