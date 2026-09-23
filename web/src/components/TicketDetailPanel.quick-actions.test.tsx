// bdboard-sso1.88: TicketDetailPanel.test.tsx (2764行) から move-only で分割した
// 「quick-actions」関心のファイル。関数本体・アサーション・フィクスチャの値は
// 元ファイルから1文字も変えていない。

import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchTicket,
  fetchTicketComments,
  fetchSimilarTickets,
  postTicketQuickAction,
  fetchPlatformSupport,
  fetchTicketRuns,
  fetchTicketInFlightOverlaps,
  fetchProjectHarnessStatus,
} from '../api';
import { resetPlatformSupportCache } from './PlatformLimitationNotice';
import { harnessStatus, renderPanel, sampleTicket } from './TicketDetailPanel-test-support';
import { computeDeferUntilDate } from '../deferPeriods';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    fetchTicket: vi.fn(),
    fetchTicketComments: vi.fn(),
    fetchSimilarTickets: vi.fn(),
    postTicketQuickAction: vi.fn(),
    fetchPlatformSupport: vi.fn(),
    fetchTicketRuns: vi.fn(),
    fetchTicketInFlightOverlaps: vi.fn(),
    fetchProjectHarnessStatus: vi.fn(),
  };
});

const mockFetchTicket = vi.mocked(fetchTicket);
const mockFetchTicketComments = vi.mocked(fetchTicketComments);
const mockFetchSimilarTickets = vi.mocked(fetchSimilarTickets);
const mockPostTicketQuickAction = vi.mocked(postTicketQuickAction);
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

describe('TicketDetailPanel quick actions', () => {
  let user: ReturnType<typeof userEvent.setup>;
  const fixedNow = new Date(2026, 7, 17, 12, 0, 0);

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(fixedNow);
    mockFetchTicket.mockResolvedValue(sampleTicket);
    mockFetchTicketComments.mockResolvedValue([]);
    mockPostTicketQuickAction.mockResolvedValue(undefined);
    user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows confirmation and posts claim quick action', async () => {
    renderPanel(new Map());

    const claimButtons = await screen.findAllByRole('button', { name: '着手' });
    await user.click(claimButtons[0]!);
    await user.click(screen.getByRole('button', { name: '実行する' }));

    await waitFor(() => {
      expect(mockPostTicketQuickAction).toHaveBeenCalledWith(sampleTicket.id, {
        action: 'claim',
      });
    });
  });

  it('posts close quick action with optional reason', async () => {
    renderPanel(new Map());

    const completeButtons = await screen.findAllByRole('button', {
      name: '完了',
    });
    await user.click(completeButtons[0]!);
    await user.type(screen.getByLabelText('理由(任意)'), 'done for now');
    await user.click(screen.getByRole('button', { name: '実行する' }));

    await waitFor(() => {
      expect(mockPostTicketQuickAction).toHaveBeenCalledWith(sampleTicket.id, {
        action: 'close',
        reason: 'done for now',
      });
    });
  });

  it('posts defer quick action with the default one-week period', async () => {
    renderPanel(new Map());

    const deferButtons = await screen.findAllByRole('button', { name: '延期' });
    await user.click(deferButtons[0]!);
    await user.click(screen.getByRole('button', { name: '実行する' }));

    await waitFor(() => {
      expect(mockPostTicketQuickAction).toHaveBeenCalledWith(sampleTicket.id, {
        action: 'defer',
        untilDate: computeDeferUntilDate('1week', fixedNow),
      });
    });
  });

  it('posts defer quick action for the selected tomorrow period', async () => {
    renderPanel(new Map());

    const periodSelects = await screen.findAllByLabelText('延期期間');
    await user.selectOptions(periodSelects[0]!, 'tomorrow');
    const deferButtons = await screen.findAllByRole('button', { name: '延期' });
    await user.click(deferButtons[0]!);
    await user.click(screen.getByRole('button', { name: '実行する' }));

    await waitFor(() => {
      expect(mockPostTicketQuickAction).toHaveBeenCalledWith(sampleTicket.id, {
        action: 'defer',
        untilDate: computeDeferUntilDate('tomorrow', fixedNow),
      });
    });
  });

  it('posts defer quick action with a custom future date', async () => {
    renderPanel(new Map());

    const periodSelects = await screen.findAllByLabelText('延期期間');
    await user.selectOptions(periodSelects[0]!, 'custom');
    const dateInput = document.querySelector(
      'input[type="date"]',
    ) as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: '2026-09-01' } });

    const deferButtons = await screen.findAllByRole('button', { name: '延期' });
    await user.click(deferButtons[0]!);
    await user.click(screen.getByRole('button', { name: '実行する' }));

    await waitFor(() => {
      expect(mockPostTicketQuickAction).toHaveBeenCalledWith(sampleTicket.id, {
        action: 'defer',
        untilDate: '2026-09-01',
      });
    });
  });

  it('disables defer submit when custom date is not a future local date', async () => {
    renderPanel(new Map());

    const periodSelects = await screen.findAllByLabelText('延期期間');
    await user.selectOptions(periodSelects[0]!, 'custom');

    const deferButtons = await screen.findAllByRole('button', { name: '延期' });
    expect(deferButtons[0]).toBeDisabled();
  });
});
