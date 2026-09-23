// bdboard-sso1.88: TicketDetailPanel.test.tsx (2764行) から move-only で分割した
// 「title-description-editing」関心のファイル。関数本体・アサーション・フィクスチャの値は
// 元ファイルから1文字も変えていない。


import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TicketDetailDto } from '../api';
import {
  fetchTicket,
  fetchTicketComments,
  fetchSimilarTickets,
  patchTicketTitle,
  patchTicketDescription,
  fetchPlatformSupport,
  fetchTicketRuns,
  fetchTicketInFlightOverlaps,
  fetchProjectHarnessStatus,
} from '../api';
import { resetPlatformSupportCache } from './PlatformLimitationNotice';
import { MaximizablePanel, harnessStatus, renderPanel, sampleTicket } from './TicketDetailPanel-test-support';
import { WatchedTicketsProvider } from './WatchedTicketsProvider';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    fetchTicket: vi.fn(),
    fetchTicketComments: vi.fn(),
    fetchSimilarTickets: vi.fn(),
    patchTicketTitle: vi.fn(),
    patchTicketDescription: vi.fn(),
    fetchPlatformSupport: vi.fn(),
    fetchTicketRuns: vi.fn(),
    fetchTicketInFlightOverlaps: vi.fn(),
    fetchProjectHarnessStatus: vi.fn(),
  };
});

const mockFetchTicket = vi.mocked(fetchTicket);
const mockFetchTicketComments = vi.mocked(fetchTicketComments);
const mockFetchSimilarTickets = vi.mocked(fetchSimilarTickets);
const mockPatchTicketTitle = vi.mocked(patchTicketTitle);
const mockPatchTicketDescription = vi.mocked(patchTicketDescription);
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

describe('TicketDetailPanel title and description editing', () => {
  let user: ReturnType<typeof userEvent.setup>;

  const ticketWithDescription: TicketDetailDto = {
    ...sampleTicket,
    description: 'Original description',
  };

  beforeEach(() => {
    mockFetchTicket.mockResolvedValue(ticketWithDescription);
    mockFetchTicketComments.mockResolvedValue([]);
    mockPatchTicketTitle.mockResolvedValue(undefined);
    mockPatchTicketDescription.mockResolvedValue(undefined);
    user = userEvent.setup();
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('edits the title and calls patchTicketTitle with CAS snapshot', async () => {
    renderPanel(new Map());

    await user.click(
      await screen.findByRole('button', { name: 'タイトルを編集' }),
    );

    const input = screen.getByLabelText('タイトル');
    await user.clear(input);
    await user.type(input, 'Updated title');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(mockPatchTicketTitle).toHaveBeenCalledWith(
        sampleTicket.id,
        'Updated title',
        sampleTicket.title,
      );
    });
  });

  it('invalidates ticket and board queries after title save', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderPanel(new Map(), undefined, undefined, queryClient);

    await user.click(
      await screen.findByRole('button', { name: 'タイトルを編集' }),
    );
    const input = screen.getByLabelText('タイトル');
    await user.clear(input);
    await user.type(input, 'Updated title');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['ticket', sampleTicket.id],
      });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['board'],
      });
    });
  });

  it('edits the description and calls patchTicketDescription with CAS snapshot', async () => {
    renderPanel(new Map());

    await user.click(
      await screen.findByRole('button', { name: 'Description を編集' }),
    );

    const textarea = screen.getByLabelText('Description');
    await user.clear(textarea);
    await user.type(textarea, 'New description body');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(mockPatchTicketDescription).toHaveBeenCalledWith(
        sampleTicket.id,
        'New description body',
        ticketWithDescription.description,
      );
    });
  });

  it('invalidates the ticket query after description save', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderPanel(new Map(), undefined, undefined, queryClient);

    await user.click(
      await screen.findByRole('button', { name: 'Description を編集' }),
    );
    const textarea = screen.getByLabelText('Description');
    await user.clear(textarea);
    await user.type(textarea, 'New description body');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['ticket', sampleTicket.id],
      });
    });
    expect(invalidateSpy).not.toHaveBeenCalledWith({
      queryKey: ['board'],
    });
  });

  it('starts description edit from empty when description is unset', async () => {
    mockFetchTicket.mockResolvedValue(sampleTicket);

    renderPanel(new Map());

    await user.click(
      await screen.findByRole('button', { name: 'Description を編集' }),
    );

    const textarea = screen.getByLabelText('Description');
    await user.type(textarea, 'First description');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(mockPatchTicketDescription).toHaveBeenCalledWith(
        sampleTicket.id,
        'First description',
        '',
      );
    });
  });

  it('shows an error message when title update fails', async () => {
    mockPatchTicketTitle.mockRejectedValue(new Error('network down'));

    renderPanel(new Map());

    await user.click(
      await screen.findByRole('button', { name: 'タイトルを編集' }),
    );
    const input = screen.getByLabelText('タイトル');
    await user.clear(input);
    await user.type(input, 'Updated title');
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText('network down')).toBeInTheDocument();
  });

  it('shows an error message when description update fails', async () => {
    mockPatchTicketDescription.mockRejectedValue(new Error('network down'));

    renderPanel(new Map());

    await user.click(
      await screen.findByRole('button', { name: 'Description を編集' }),
    );
    const textarea = screen.getByLabelText('Description');
    await user.clear(textarea);
    await user.type(textarea, 'New description body');
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText('network down')).toBeInTheDocument();
  });

  // bdboard-sso1.5: useTicketFormReset.ts へ抽出した resetFormState 横断リセットが、
  // パネル本体(TicketDetailPanel)側の ticketId prop 変化でも実際に発火することを
  // 確認する。useTicketFormReset.test.ts はフック単体でモック関数を渡して呼び出し
  // 順序・依存配列を検証しているが、UseTicketFormResetParams は全フィールドが
  // 同じ `() => void` 型なので、呼び出し側(TicketDetailPanel.tsx)で誤って
  // 別のセクションの reset を渡す(例: resetTitleEditing に resetDescriptionEditing
  // を渡す)配線ミスがあっても型チェックでは検出できない。このテストは実際の
  // TicketDetailPanel を2つの異なる ticketId でレンダーし、未保存のタイトル編集
  // 下書きが実際に消えることを確認することで、その配線ミスを検出する。
  it('clears an in-progress, unsaved title edit when the panel switches to a different ticket', async () => {
    const otherTicket: TicketDetailDto = {
      ...sampleTicket,
      id: 'bdboard-other.1',
      title: 'Other ticket title',
    };
    mockFetchTicket.mockImplementation((id: string) =>
      Promise.resolve(id === otherTicket.id ? otherTicket : ticketWithDescription),
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = render(
      <QueryClientProvider client={queryClient}>
        <WatchedTicketsProvider>
          <MaximizablePanel
            ticketId={sampleTicket.id}
            projectRootPaths={new Map()}
            pendingDecision={undefined}
            onClose={() => {}}
            onChatAboutTicket={() => {}}
            onOpenTicket={() => {}}
            isTicketOnBoard={() => true}
            onFilterByEpic={() => {}}
          />
        </WatchedTicketsProvider>
      </QueryClientProvider>,
    );

    await user.click(
      await screen.findByRole('button', { name: 'タイトルを編集' }),
    );
    const input = screen.getByLabelText('タイトル');
    await user.clear(input);
    await user.type(input, 'DRAFT not saved');
    expect(screen.getByLabelText('タイトル')).toHaveValue('DRAFT not saved');

    view.rerender(
      <QueryClientProvider client={queryClient}>
        <WatchedTicketsProvider>
          <MaximizablePanel
            ticketId={otherTicket.id}
            projectRootPaths={new Map()}
            pendingDecision={undefined}
            onClose={() => {}}
            onChatAboutTicket={() => {}}
            onOpenTicket={() => {}}
            isTicketOnBoard={() => true}
            onFilterByEpic={() => {}}
          />
        </WatchedTicketsProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText(otherTicket.title)).toBeInTheDocument();
    // 編集モードが解除されているので、タイトル入力欄(=編集中だけ出る)は無い。
    expect(screen.queryByLabelText('タイトル')).not.toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: 'タイトルを編集' }),
    ).toBeInTheDocument();
    // 下書きが漏れていないことの直接確認: 消えたタイトル入力欄ではなく、
    // 表示中のタイトルが otherTicket のものであって DRAFT 文字列ではないこと。
    expect(screen.queryByText('DRAFT not saved')).not.toBeInTheDocument();
  });
});

