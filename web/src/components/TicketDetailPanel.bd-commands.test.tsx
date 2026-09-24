// bdboard-sso1.88: TicketDetailPanel.test.tsx (2764行) から move-only で分割した
// 「bd-commands」関心のファイル。関数本体・アサーション・フィクスチャの値は
// 元ファイルから1文字も変えていない。

import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

describe('TicketDetailPanel bd commands', () => {
  let writeTextMock: ReturnType<typeof vi.fn>;
  let user: ReturnType<typeof userEvent.setup>;

  beforeEach(() => {
    mockFetchTicket.mockResolvedValue(sampleTicket);
    mockFetchTicketComments.mockResolvedValue([]);
    // userEvent.setup() installs its own navigator.clipboard stub, so it has to
    // run before we swap in our spy. Otherwise the spy is never called.
    user = userEvent.setup();
    writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: writeTextMock },
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('copies claim command with -C rootPath when the project is known', async () => {
    renderPanel(new Map([['proj-1', '/Users/me/projects/bdboard']]));

    await screen.findByRole('button', { name: /着手コマンドをコピー/ });
    await user.click(screen.getByRole('button', { name: /着手コマンドをコピー/ }));

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith(
        "bd -C '/Users/me/projects/bdboard' update 'bdboard-abc.1' --claim",
      );
    });
    expect(screen.getByText('コピーしました')).toBeInTheDocument();
  });

  it('copies claim command without -C when the project root is unknown', async () => {
    renderPanel(new Map());

    await screen.findByRole('button', { name: /着手コマンドをコピー/ });
    await user.click(screen.getByRole('button', { name: /着手コマンドをコピー/ }));

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith(
        "bd update 'bdboard-abc.1' --claim",
      );
    });
  });

  it('does not arm a copy-feedback timer when the clipboard settles after unmount', async () => {
    // bdboard-ty72: コピー表示は writeText の継続から出るので、アンマウント後に
    // 解決すると、クリーンアップ済みのコンポーネントが新しい setTimeout を
    // 仕掛けてしまう。残ったタイマーは破棄済み jsdom で `window is not defined`
    // を投げ、vitest はそれを「テスト環境破棄後の未捕捉エラー」として
    // プロセスごと exit 1 にする (bdboard-ifff)。
    const COPY_FEEDBACK_MS = 2000;
    let settleCopy: (() => void) | undefined;
    writeTextMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settleCopy = () => {
            resolve();
          };
        }),
    );

    const { unmount } = renderPanel(new Map());

    await screen.findByRole('button', { name: /着手コマンドをコピー/ });
    await user.click(screen.getByRole('button', { name: /着手コマンドをコピー/ }));
    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledTimes(1);
    });

    // React 自身も setTimeout を使うので、この表示の遅延だけを見る。
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout');
    unmount();
    settleCopy?.();
    await act(async () => {
      await Promise.resolve();
    });

    const feedbackTimers = setTimeoutSpy.mock.calls.filter(
      ([, delay]) => delay === COPY_FEEDBACK_MS,
    );
    expect(feedbackTimers).toHaveLength(0);
    setTimeoutSpy.mockRestore();
  });

  it('shows an error message when clipboard copy fails', async () => {
    writeTextMock.mockRejectedValue(new Error('denied'));
    const execCommandMock = vi.fn().mockReturnValue(false);
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommandMock,
    });

    renderPanel(new Map([['proj-1', '/Users/me/projects/bdboard']]));

    await screen.findByRole('button', { name: /着手コマンドをコピー/ });
    await user.click(screen.getByRole('button', { name: /着手コマンドをコピー/ }));

    // The message renders twice: the visible error paragraph and the aria-live region.
    const errorMessages = await screen.findAllByText('コピーできませんでした');
    expect(errorMessages.length).toBeGreaterThan(0);
    expect(execCommandMock).toHaveBeenCalledWith('copy');
  });
});
