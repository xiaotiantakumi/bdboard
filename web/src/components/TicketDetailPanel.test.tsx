import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ActivityEventDto,
  CommentDto,
  PendingDecisionDto,
  PrBadgeDto,
  SessionDto,
  TicketDetailDto,
  TicketSearchResultDto,
} from '../api';
import {
  ApiError,
  cancelAgentRun,
  deleteTicketDependency,
  deleteTicketLabel,
  deleteTicketSessionLink,
  fetchAgentRun,
  fetchPlatformSupport,
  fetchSessions,
  fetchTicket,
  fetchTicketComments,
  fetchTicketRuns,
  fetchTicketTimeline,
  fetchSimilarTickets,
  patchTicketDescription,
  patchTicketTitle,
  postTicketComment,
  postTicketDecision,
  postTicketAddLabel,
  postTicketDependency,
  postTicketQuickAction,
  postTicketQuickActionUndo,
  postTicketSessionLink,
  searchTickets,
  startTicketRun,
  type AgentRunDetailDto,
} from '../api';
import { resetPlatformSupportCache } from './PlatformLimitationNotice';
import { TicketDetailPanel, type TicketDetailPanelProps } from './TicketDetailPanel';
import { UndoSnackbarProvider } from './UndoSnackbar';
import { WatchedTicketsProvider } from './WatchedTicketsProvider';
import { computeDeferUntilDate } from '../deferPeriods';
import { expectNoA11yViolations } from '../test/axe';
import {
  CONFLICT_WRITE_HELP,
  NETWORK_FETCH_HELP,
  REMOTE_AGENT_RUNS_DISABLED_HELP,
  TUNNEL_WRITE_HELP,
} from '../writeAccessMessage';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    fetchTicket: vi.fn(),
    fetchTicketComments: vi.fn(),
    fetchTicketTimeline: vi.fn(),
    fetchSimilarTickets: vi.fn(),
    postTicketDecision: vi.fn(),
    postTicketQuickAction: vi.fn(),
    postTicketQuickActionUndo: vi.fn(),
    postTicketComment: vi.fn(),
    postTicketAddLabel: vi.fn(),
    patchTicketTitle: vi.fn(),
    patchTicketDescription: vi.fn(),
    postTicketDependency: vi.fn(),
    deleteTicketDependency: vi.fn(),
    deleteTicketLabel: vi.fn(),
    searchTickets: vi.fn(),
    fetchSessions: vi.fn(),
    fetchPlatformSupport: vi.fn(),
    postTicketSessionLink: vi.fn(),
    deleteTicketSessionLink: vi.fn(),
    startTicketRun: vi.fn(),
    fetchTicketRuns: vi.fn(),
    fetchAgentRun: vi.fn(),
    cancelAgentRun: vi.fn(),
  };
});

const mockFetchTicket = vi.mocked(fetchTicket);
const mockFetchTicketComments = vi.mocked(fetchTicketComments);
const mockFetchTicketTimeline = vi.mocked(fetchTicketTimeline);
const mockFetchSimilarTickets = vi.mocked(fetchSimilarTickets);
const mockPostTicketDecision = vi.mocked(postTicketDecision);
const mockPostTicketQuickAction = vi.mocked(postTicketQuickAction);
const mockPostTicketQuickActionUndo = vi.mocked(postTicketQuickActionUndo);
const mockPostTicketComment = vi.mocked(postTicketComment);
const mockPostTicketAddLabel = vi.mocked(postTicketAddLabel);
const mockPatchTicketTitle = vi.mocked(patchTicketTitle);
const mockPatchTicketDescription = vi.mocked(patchTicketDescription);
const mockPostTicketDependency = vi.mocked(postTicketDependency);
const mockDeleteTicketDependency = vi.mocked(deleteTicketDependency);
const mockDeleteTicketLabel = vi.mocked(deleteTicketLabel);
const mockSearchTickets = vi.mocked(searchTickets);
const mockFetchSessions = vi.mocked(fetchSessions);
const mockFetchPlatformSupport = vi.mocked(fetchPlatformSupport);
const mockPostTicketSessionLink = vi.mocked(postTicketSessionLink);
const mockDeleteTicketSessionLink = vi.mocked(deleteTicketSessionLink);
const mockStartTicketRun = vi.mocked(startTicketRun);
const mockFetchTicketRuns = vi.mocked(fetchTicketRuns);
const mockFetchAgentRun = vi.mocked(fetchAgentRun);
const mockCancelAgentRun = vi.mocked(cancelAgentRun);

beforeEach(() => {
  mockFetchSimilarTickets.mockResolvedValue([]);
  mockFetchTicketRuns.mockResolvedValue({ runs: [] });
  resetPlatformSupportCache();
  mockFetchPlatformSupport.mockResolvedValue({ platform: 'darwin', limitations: [] });
});

const sampleTicket: TicketDetailDto = {
  id: 'bdboard-abc.1',
  projectId: 'proj-1',
  title: 'Sample ticket',
  status: 'open',
  priority: 2,
  issueType: 'task',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  dependencies: [],
  blockedBy: [],
  blocks: [],
  commentCount: 0,
  sessionLinks: [],
  models: [],
  children: [],
};

const defaultTicketDecisionOutcome = {
  kind: 'ticket',
  closed: false,
} as const;

/*
 * 最大化 state は App 側が持つ (bdboard-0hcx / PR#242 opus レビュー major-1)。
 * パネル単体テストでは、その App の役割をこの薄いラッパで代行する。
 */
function MaximizablePanel(
  props: Omit<TicketDetailPanelProps, 'isMaximized' | 'onToggleMaximized'>,
) {
  const [maximized, setMaximized] = useState(false);
  return (
    <TicketDetailPanel
      {...props}
      isMaximized={maximized}
      onToggleMaximized={() => setMaximized((value) => !value)}
    />
  );
}

function renderPanel(
  projectRootPaths: ReadonlyMap<string, string>,
  pendingDecision?: PendingDecisionDto,
  prLink?: PrBadgeDto,
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  }),
  availableLabels: string[] = [],
) {
  const view = render(
    <QueryClientProvider client={queryClient}>
      <WatchedTicketsProvider>
        <MaximizablePanel
          ticketId={sampleTicket.id}
          projectRootPaths={projectRootPaths}
          pendingDecision={pendingDecision}
          prLink={prLink}
          onClose={() => {}}
          onChatAboutTicket={() => {}}
          onOpenTicket={() => {}}
          isTicketOnBoard={() => true}
          onFilterByEpic={() => {}}
          availableLabels={availableLabels}
        />
      </WatchedTicketsProvider>
    </QueryClientProvider>,
  );

  return { ...view, queryClient };
}

function rerenderPanel(
  rerender: ReturnType<typeof render>['rerender'],
  queryClient: QueryClient,
  projectRootPaths: ReadonlyMap<string, string>,
  pendingDecision?: PendingDecisionDto,
  prLink?: PrBadgeDto,
) {
  rerender(
    <QueryClientProvider client={queryClient}>
      <WatchedTicketsProvider>
        <MaximizablePanel
          ticketId={sampleTicket.id}
          projectRootPaths={projectRootPaths}
          pendingDecision={pendingDecision}
          prLink={prLink}
          onClose={() => {}}
        onChatAboutTicket={() => {}}
        onOpenTicket={() => {}}
        isTicketOnBoard={() => true}
        onFilterByEpic={() => {}}
        />
      </WatchedTicketsProvider>
    </QueryClientProvider>,
  );
}

function renderPanelWithUndoSnackbar(
  projectRootPaths: ReadonlyMap<string, string>,
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  }),
) {
  const view = render(
    <UndoSnackbarProvider>
      <QueryClientProvider client={queryClient}>
        <WatchedTicketsProvider>
          <MaximizablePanel
            ticketId={sampleTicket.id}
            projectRootPaths={projectRootPaths}
            pendingDecision={undefined}
            onClose={() => {}}
            onChatAboutTicket={() => {}}
            onOpenTicket={() => {}}
            isTicketOnBoard={() => true}
            onFilterByEpic={() => {}}
          />
        </WatchedTicketsProvider>
      </QueryClientProvider>
    </UndoSnackbarProvider>,
  );

  return { ...view, queryClient };
}

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

describe('TicketDetailPanel markdown content', () => {
  beforeEach(() => {
    mockFetchTicket.mockReset();
    mockFetchTicketComments.mockReset();
  });

  afterEach(() => {
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

describe('TicketDetailPanel comments', () => {
  beforeEach(() => {
    mockFetchTicket.mockReset();
    mockFetchTicketComments.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows empty message without calling comments API when commentCount is 0', async () => {
    mockFetchTicket.mockResolvedValue({ ...sampleTicket, commentCount: 0 });

    renderPanel(new Map());

    expect(await screen.findByText('コメントはありません')).toBeInTheDocument();
    expect(mockFetchTicketComments).not.toHaveBeenCalled();
  });

  it('shows comments when commentCount is greater than 0', async () => {
    const comments: CommentDto[] = [
      {
        id: 'comment-1',
        issueId: sampleTicket.id,
        author: 'Alice',
        text: 'First comment',
        createdAt: '2026-08-14T10:00:00.000Z',
      },
      {
        id: 'comment-2',
        issueId: sampleTicket.id,
        author: 'Bob',
        text: 'Second comment',
        createdAt: '2026-08-14T11:00:00.000Z',
      },
    ];

    mockFetchTicket.mockResolvedValue({ ...sampleTicket, commentCount: 2 });
    mockFetchTicketComments.mockResolvedValue(comments);

    renderPanel(new Map());

    expect(await screen.findByText('First comment')).toBeInTheDocument();
    expect(screen.getByText('Second comment')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(mockFetchTicketComments).toHaveBeenCalledWith(sampleTicket.id);
  });

  it('shows loading state while comments are loading', async () => {
    let resolveComments: (value: CommentDto[]) => void = () => {};
    const commentsPromise = new Promise<CommentDto[]>((resolve) => {
      resolveComments = resolve;
    });

    mockFetchTicket.mockResolvedValue({ ...sampleTicket, commentCount: 1 });
    mockFetchTicketComments.mockReturnValue(commentsPromise);

    renderPanel(new Map());

    expect(await screen.findByText('読み込み中…')).toBeInTheDocument();

    resolveComments([
      {
        id: 'comment-1',
        issueId: sampleTicket.id,
        author: 'Alice',
        text: 'Loaded comment',
        createdAt: '2026-08-14T10:00:00.000Z',
      },
    ]);

    expect(await screen.findByText('Loaded comment')).toBeInTheDocument();
  });

  it('shows error message when comments API fails', async () => {
    mockFetchTicket.mockResolvedValue({ ...sampleTicket, commentCount: 1 });
    mockFetchTicketComments.mockRejectedValue(new Error('comments failed'));

    renderPanel(new Map());

    expect(await screen.findByText('comments failed')).toBeInTheDocument();
  });

  it('does not double-fetch comments on initial mount', async () => {
    const comments: CommentDto[] = [
      {
        id: 'comment-1',
        issueId: sampleTicket.id,
        author: 'Alice',
        text: 'First comment',
        createdAt: '2026-08-14T10:00:00.000Z',
      },
    ];

    mockFetchTicket.mockResolvedValue({ ...sampleTicket, commentCount: 1 });
    mockFetchTicketComments.mockResolvedValue(comments);

    renderPanel(new Map());

    expect(await screen.findByText('First comment')).toBeInTheDocument();
    expect(mockFetchTicketComments).toHaveBeenCalledTimes(1);
  });

  it('refetches comments when commentCount changes from 1 to 2', async () => {
    const comments: CommentDto[] = [
      {
        id: 'comment-1',
        issueId: sampleTicket.id,
        author: 'Alice',
        text: 'First comment',
        createdAt: '2026-08-14T10:00:00.000Z',
      },
    ];

    mockFetchTicket
      .mockResolvedValueOnce({ ...sampleTicket, commentCount: 1 })
      .mockResolvedValueOnce({ ...sampleTicket, commentCount: 2 });
    mockFetchTicketComments.mockResolvedValue(comments);

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    renderPanel(new Map(), undefined, undefined, queryClient);

    await waitFor(() => {
      expect(mockFetchTicketComments).toHaveBeenCalledTimes(1);
    });

    await queryClient.invalidateQueries({ queryKey: ['ticket', sampleTicket.id] });

    await waitFor(() => {
      expect(mockFetchTicketComments).toHaveBeenCalledTimes(2);
    });
  });
});

describe('TicketDetailPanel comment form', () => {
  let user: ReturnType<typeof userEvent.setup>;

  beforeEach(() => {
    mockFetchTicket.mockResolvedValue(sampleTicket);
    mockFetchTicketComments.mockResolvedValue([]);
    mockPostTicketComment.mockResolvedValue(undefined);
    user = userEvent.setup();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('disables submit when comment text is empty', async () => {
    renderPanel(new Map());

    const submitButton = await screen.findByRole('button', {
      name: 'コメントを投稿',
    });
    expect(submitButton).toBeDisabled();
  });

  it('posts comment and invalidates ticket and comment queries', async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderPanel(new Map(), undefined, undefined, queryClient);

    await user.type(
      await screen.findByLabelText('コメントを追加'),
      'quick note',
    );
    await user.click(screen.getByRole('button', { name: 'コメントを投稿' }));

    await waitFor(() => {
      expect(mockPostTicketComment).toHaveBeenCalledWith(
        sampleTicket.id,
        'quick note',
      );
    });

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['ticket', sampleTicket.id],
      });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['ticket-comments', sampleTicket.id],
      });
    });
  });

  it('shows error message when comment post fails', async () => {
    mockPostTicketComment.mockRejectedValue(new Error('comment failed'));

    renderPanel(new Map());

    await user.type(
      await screen.findByLabelText('コメントを追加'),
      'quick note',
    );
    await user.click(screen.getByRole('button', { name: 'コメントを投稿' }));

    expect(await screen.findByText('comment failed')).toBeInTheDocument();
  });
});

describe('TicketDetailPanel token usage', () => {
  beforeEach(() => {
    mockFetchTicket.mockReset();
  });

  it('shows AI usage when usage is present', async () => {
    mockFetchTicket.mockResolvedValue({
      ...sampleTicket,
      usage: {
        totalInputTokens: 1234,
        totalOutputTokens: 567,
        totalCacheCreationInputTokens: 0,
        totalCacheReadInputTokens: 0,
        byModel: [
          {
            model: 'claude-opus-5',
            inputTokens: 1234,
            outputTokens: 567,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
          },
        ],
      },
    });

    renderPanel(new Map());

    expect(await screen.findByText('AI使用量')).toBeInTheDocument();
    expect(screen.getByText('1,234')).toBeInTheDocument();
    expect(screen.getByText(/claude-opus-5: 入力 1,234/)).toBeInTheDocument();
  });
});

describe('TicketDetailPanel PR link', () => {
  beforeEach(() => {
    mockFetchTicket.mockResolvedValue(sampleTicket);
    mockFetchTicketComments.mockResolvedValue([]);
  });

  it('shows the PR detail field when prLink is provided', async () => {
    renderPanel(new Map(), undefined, {
      ticketId: sampleTicket.id,
      projectId: sampleTicket.projectId,
      url: 'https://github.com/example-org/example-repo/pull/7',
      state: 'open',
      checkStatus: null,
    });

    expect(await screen.findByText('PR')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'PR open' })).toHaveAttribute(
      'href',
      'https://github.com/example-org/example-repo/pull/7',
    );
  });
});

describe('TicketDetailPanel pending decisions', () => {
  let user: ReturnType<typeof userEvent.setup>;

  beforeEach(() => {
    mockFetchTicket.mockResolvedValue(sampleTicket);
    mockFetchTicketComments.mockResolvedValue([]);
    mockPostTicketDecision.mockResolvedValue(defaultTicketDecisionOutcome);
    user = userEvent.setup();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // bdboard-9hl: pendingDecision はポーリング由来で、利用者の操作と無関係に
  // 出現/消滅する。それを合図にフォーム全体をリセットしていたため、書きかけの
  // コメント等が警告なく消えていた。リセットしてよいのは decision の回答欄だけ。
  it('keeps an in-progress comment draft when a pending decision appears', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const panel = (pendingDecision?: PendingDecisionDto) => (
      <QueryClientProvider client={queryClient}>
        <WatchedTicketsProvider>
          <MaximizablePanel
            ticketId={sampleTicket.id}
            projectRootPaths={new Map()}
            pendingDecision={pendingDecision}
            prLink={undefined}
            onClose={() => {}}
            onChatAboutTicket={() => {}}
            onOpenTicket={() => {}}
            isTicketOnBoard={() => true}
            onFilterByEpic={() => {}}
            availableLabels={[]}
          />
        </WatchedTicketsProvider>
      </QueryClientProvider>
    );

    const { rerender } = render(panel(undefined));

    await screen.findByText('Sample ticket');
    const textarea = screen.getByLabelText('コメントを追加');
    await user.type(textarea, '書きかけのコメント');
    expect(textarea).toHaveValue('書きかけのコメント');

    // エージェントがこのチケットに bd human の質問を投稿した = 次のポーリングで
    // pendingDecision が undefined から現れる。利用者は何も操作していない。
    rerender(
      panel({
        id: sampleTicket.id,
        kind: 'ticket',
        projectId: sampleTicket.projectId,
        question: 'どちらにしますか?',
        allowFreeform: true,
      }),
    );

    expect(await screen.findByText('どちらにしますか?')).toBeInTheDocument();
    expect(screen.getByLabelText('コメントを追加')).toHaveValue('書きかけのコメント');
  });

  it('still clears the decision answer when the pending decision is replaced', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const panel = (pendingDecision: PendingDecisionDto) => (
      <QueryClientProvider client={queryClient}>
        <WatchedTicketsProvider>
          <MaximizablePanel
            ticketId={sampleTicket.id}
            projectRootPaths={new Map()}
            pendingDecision={pendingDecision}
            prLink={undefined}
            onClose={() => {}}
            onChatAboutTicket={() => {}}
            onOpenTicket={() => {}}
            isTicketOnBoard={() => true}
            onFilterByEpic={() => {}}
            availableLabels={[]}
          />
        </WatchedTicketsProvider>
      </QueryClientProvider>
    );

    const first: PendingDecisionDto = {
      id: 'decision-1',
      kind: 'ticket',
      projectId: sampleTicket.projectId,
      question: '最初の質問',
      allowFreeform: true,
    };
    const { rerender } = render(panel(first));

    const freeform = await screen.findByLabelText('自由記入');
    await user.type(freeform, '最初の回答');
    expect(freeform).toHaveValue('最初の回答');

    // 別の質問に差し替わったら、前の質問への回答は持ち越してはいけない。
    rerender(
      panel({
        id: 'decision-2',
        kind: 'ticket',
        projectId: sampleTicket.projectId,
        question: '次の質問',
        allowFreeform: true,
      }),
    );

    expect(await screen.findByText('次の質問')).toBeInTheDocument();
    expect(screen.getByLabelText('自由記入')).toHaveValue('');
  });

  it('still clears a selected choice when the pending decision is replaced', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const options = [
      { label: 'A案', value: 'a' },
      { label: 'B案', value: 'b' },
    ];
    const panel = (pendingDecision: PendingDecisionDto) => (
      <QueryClientProvider client={queryClient}>
        <WatchedTicketsProvider>
          <MaximizablePanel
            ticketId={sampleTicket.id}
            projectRootPaths={new Map()}
            pendingDecision={pendingDecision}
            prLink={undefined}
            onClose={() => {}}
            onChatAboutTicket={() => {}}
            onOpenTicket={() => {}}
            isTicketOnBoard={() => true}
            onFilterByEpic={() => {}}
            availableLabels={[]}
          />
        </WatchedTicketsProvider>
      </QueryClientProvider>
    );

    const { rerender } = render(
      panel({
        id: 'decision-1',
        kind: 'ticket',
        projectId: sampleTicket.projectId,
        question: '最初の質問',
        options,
        allowFreeform: true,
      }),
    );

    await user.click(await screen.findByRole('button', { name: 'A案' }));
    expect(screen.getByRole('button', { name: 'A案' })).toHaveClass('active');
    // 選択があるので送信できる状態。
    expect(screen.getByRole('button', { name: '回答を送信' })).toBeEnabled();

    rerender(
      panel({
        id: 'decision-2',
        kind: 'ticket',
        projectId: sampleTicket.projectId,
        question: '次の質問',
        options,
        allowFreeform: true,
      }),
    );

    // 前の質問で選んだ選択肢を持ち越さない。持ち越すと、別の質問に対して
    // 身に覚えのない回答をワンクリックで送信できてしまう。
    expect(await screen.findByText('次の質問')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'A案' })).not.toHaveClass('active');
    expect(screen.getByRole('button', { name: '回答を送信' })).toBeDisabled();
  });

  it('hides the pending decision section when pendingDecision is undefined', async () => {
    renderPanel(new Map());

    await screen.findByText('Sample ticket');
    expect(screen.queryByText('ユーザー確認待ち')).not.toBeInTheDocument();
  });

  it('shows only freeform when question exists without options', async () => {
    renderPanel(new Map(), {
      id: sampleTicket.id,
      kind: 'ticket',
      projectId: sampleTicket.projectId,
      question: 'どちらにしますか?',
      allowFreeform: true,
    });

    expect(await screen.findByText('どちらにしますか?')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'A案' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('自由記入')).toBeInTheDocument();
  });

  it('submits selected choice via postTicketDecision', async () => {
    renderPanel(new Map(), {
      id: sampleTicket.id,
      kind: 'ticket',
      projectId: sampleTicket.projectId,
      options: [
        { label: 'A案', value: 'a' },
        { label: 'B案', value: 'b' },
      ],
      allowFreeform: true,
    });

    await user.click(await screen.findByRole('button', { name: 'A案' }));
    await user.click(screen.getByRole('button', { name: '回答を送信' }));

    await waitFor(() => {
      expect(mockPostTicketDecision).toHaveBeenCalledWith(sampleTicket.id, {
        choice: 'a',
      });
    });
    expect(await screen.findByText('送信した回答')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '送信した回答' }).parentElement).toHaveTextContent('A案');
    expect(screen.getByText('回答を送信しました')).toBeInTheDocument();
    expect(
      screen.getByText(
        'このチケットはクローズしていません。確認待ちから外れ、次の更新で通常のレーンに戻ります。',
      ),
    ).toBeInTheDocument();
  });

  it('shows gate outcome message when the decision closes a gate', async () => {
    mockPostTicketDecision.mockResolvedValue({ kind: 'gate', closed: true });

    renderPanel(new Map(), {
      id: sampleTicket.id,
      kind: 'gate',
      projectId: sampleTicket.projectId,
      allowFreeform: true,
    });

    await user.type(await screen.findByLabelText('自由記入'), 'ゲート回答');
    await user.click(screen.getByRole('button', { name: '回答を送信' }));

    expect(
      await screen.findByText(
        '確認用のゲートを解決しました。ブロックされていたチケットが次の更新で着手可能になります。',
      ),
    ).toBeInTheDocument();
  });

  it('shows gate pre-submit notice when pendingDecision.kind is gate', async () => {
    renderPanel(new Map(), {
      id: sampleTicket.id,
      kind: 'gate',
      projectId: sampleTicket.projectId,
      allowFreeform: true,
    });

    expect(await screen.findByText('Sample ticket')).toBeInTheDocument();
    expect(
      screen.getByText(
        'これは質問専用のゲートです。回答するとゲートはクローズされ、ブロックされていたチケットが着手可能になります。',
      ),
    ).toBeInTheDocument();
  });

  it('hides gate pre-submit notice when pendingDecision.kind is ticket', async () => {
    renderPanel(new Map(), {
      id: sampleTicket.id,
      kind: 'ticket',
      projectId: sampleTicket.projectId,
      allowFreeform: true,
    });

    expect(await screen.findByText('Sample ticket')).toBeInTheDocument();
    expect(
      screen.queryByText(
        'これは質問専用のゲートです。回答するとゲートはクローズされ、ブロックされていたチケットが着手可能になります。',
      ),
    ).not.toBeInTheDocument();
  });

  it('shows unknown outcome message when the server could not resolve decision kind', async () => {
    mockPostTicketDecision.mockResolvedValue({ kind: 'unknown', closed: false });

    renderPanel(new Map(), {
      id: sampleTicket.id,
      kind: 'ticket',
      projectId: sampleTicket.projectId,
      allowFreeform: true,
    });

    await user.type(await screen.findByLabelText('自由記入'), '再試行前の回答');
    await user.click(screen.getByRole('button', { name: '回答を送信' }));

    expect(
      await screen.findByText(
        '種別(ゲート/作業チケット)を判定できませんでした。回答はコメントとして記録しましたが、確認待ちのまま残っています。しばらくしてからもう一度送信してください。',
      ),
    ).toBeInTheDocument();
  });

  it('submits freeform text only', async () => {
    renderPanel(new Map(), {
      id: sampleTicket.id,
      kind: 'ticket',
      projectId: sampleTicket.projectId,
      allowFreeform: true,
    });

    await user.type(await screen.findByLabelText('自由記入'), '自由回答です');
    await user.click(screen.getByRole('button', { name: '回答を送信' }));

    await waitFor(() => {
      expect(mockPostTicketDecision).toHaveBeenCalledWith(sampleTicket.id, {
        freeform: '自由回答です',
      });
    });
  });

  it('keeps submitted freeform visible after pendingDecision disappears', async () => {
    const pendingDecision: PendingDecisionDto = {
      id: sampleTicket.id,
      kind: 'ticket',
      projectId: sampleTicket.projectId,
      allowFreeform: true,
    };
    const { rerender, queryClient } = renderPanel(new Map(), pendingDecision);

    await user.type(await screen.findByLabelText('自由記入'), '自由回答です');
    await user.click(screen.getByRole('button', { name: '回答を送信' }));

    await waitFor(() => {
      expect(mockPostTicketDecision).toHaveBeenCalledWith(sampleTicket.id, {
        freeform: '自由回答です',
      });
    });

    rerenderPanel(rerender, queryClient, new Map(), undefined);

    expect(await screen.findByText('送信した回答')).toBeInTheDocument();
    expect(screen.getByText('自由回答です')).toBeInTheDocument();
    expect(screen.queryByText('ユーザー確認待ち')).not.toBeInTheDocument();
  });

  it('fetches comments after submit even when commentCount is 0', async () => {
    mockFetchTicket.mockResolvedValue({ ...sampleTicket, commentCount: 0 });

    renderPanel(new Map(), {
      id: sampleTicket.id,
      kind: 'ticket',
      projectId: sampleTicket.projectId,
      allowFreeform: true,
    });

    await user.type(await screen.findByLabelText('自由記入'), '自由回答です');
    await user.click(screen.getByRole('button', { name: '回答を送信' }));

    await waitFor(() => {
      expect(mockPostTicketDecision).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(mockFetchTicketComments).toHaveBeenCalledWith(sampleTicket.id);
    });
  });

  it('keeps freeform input and shows Japanese message on network failure', async () => {
    mockPostTicketDecision.mockRejectedValue(new TypeError('Failed to fetch'));

    renderPanel(new Map(), {
      id: sampleTicket.id,
      kind: 'ticket',
      projectId: sampleTicket.projectId,
      allowFreeform: true,
    });

    const textarea = await screen.findByLabelText('自由記入');
    await user.type(textarea, '長い自由回答');
    await user.click(screen.getByRole('button', { name: '回答を送信' }));

    expect(await screen.findByText(NETWORK_FETCH_HELP)).toBeInTheDocument();
    expect(textarea).toHaveValue('長い自由回答');
    expect(screen.queryByText('送信した回答')).not.toBeInTheDocument();
  });

  it('keeps freeform input and shows tunnel help on 403 local access only', async () => {
    mockPostTicketDecision.mockRejectedValue(
      new ApiError(403, 'local access only', {
        errorMessage: 'local access only',
      }),
    );

    renderPanel(new Map(), {
      id: sampleTicket.id,
      kind: 'ticket',
      projectId: sampleTicket.projectId,
      allowFreeform: true,
    });

    const textarea = await screen.findByLabelText('自由記入');
    await user.type(textarea, 'トンネル経由の回答');
    await user.click(screen.getByRole('button', { name: '回答を送信' }));

    expect(await screen.findByText(TUNNEL_WRITE_HELP)).toBeInTheDocument();
    expect(textarea).toHaveValue('トンネル経由の回答');
  });

  it('clears the send failure message when the pending decision is replaced', async () => {
    mockPostTicketDecision.mockRejectedValue(new TypeError('Failed to fetch'));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const panel = (pendingDecision: PendingDecisionDto) => (
      <QueryClientProvider client={queryClient}>
        <WatchedTicketsProvider>
          <MaximizablePanel
            ticketId={sampleTicket.id}
            projectRootPaths={new Map()}
            pendingDecision={pendingDecision}
            prLink={undefined}
            onClose={() => {}}
            onChatAboutTicket={() => {}}
            onOpenTicket={() => {}}
            isTicketOnBoard={() => true}
            onFilterByEpic={() => {}}
            availableLabels={[]}
          />
        </WatchedTicketsProvider>
      </QueryClientProvider>
    );

    const { rerender } = render(
      panel({
        id: 'decision-1',
        kind: 'ticket',
        projectId: sampleTicket.projectId,
        question: '最初の質問',
        allowFreeform: true,
      }),
    );

    await user.type(await screen.findByLabelText('自由記入'), '最初の回答');
    await user.click(screen.getByRole('button', { name: '回答を送信' }));
    expect(await screen.findByText(NETWORK_FETCH_HELP)).toBeInTheDocument();

    // エージェントが質問1を取り下げて質問2を出した状況。ミューテーションの
    // エラーを捨てないと、質問2の送信ボタンの下に質問1の失敗メッセージが
    // 残り続ける (bdboard-uez)。
    //
    // 質問文はわざと同じにしてある。エージェントが同じ質問を取り下げて出し直す
    // ことは実際にあり、そのとき別物と見分ける手掛かりは id しかない。文言まで
    // 変えると、判定を id ではなく question に取り違える実装を通してしまう
    // (PR#130 fable レビュー M4)。
    rerender(
      panel({
        id: 'decision-2',
        kind: 'ticket',
        projectId: sampleTicket.projectId,
        question: '最初の質問',
        allowFreeform: true,
      }),
    );

    await waitFor(() => {
      expect(screen.queryByText(NETWORK_FETCH_HELP)).not.toBeInTheDocument();
    });
  });

  it('keeps the send failure message while the same question is still pending', async () => {
    mockPostTicketDecision.mockRejectedValue(new TypeError('Failed to fetch'));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const panel = (pendingDecision: PendingDecisionDto) => (
      <QueryClientProvider client={queryClient}>
        <WatchedTicketsProvider>
          <MaximizablePanel
            ticketId={sampleTicket.id}
            projectRootPaths={new Map()}
            pendingDecision={pendingDecision}
            prLink={undefined}
            onClose={() => {}}
            onChatAboutTicket={() => {}}
            onOpenTicket={() => {}}
            isTicketOnBoard={() => true}
            onFilterByEpic={() => {}}
            availableLabels={[]}
          />
        </WatchedTicketsProvider>
      </QueryClientProvider>
    );

    const { rerender } = render(
      panel({
        id: 'decision-1',
        kind: 'ticket',
        projectId: sampleTicket.projectId,
        question: '最初の質問',
        allowFreeform: true,
      }),
    );

    await user.type(await screen.findByLabelText('自由記入'), '最初の回答');
    await user.click(screen.getByRole('button', { name: '回答を送信' }));
    expect(await screen.findByText(NETWORK_FETCH_HELP)).toBeInTheDocument();

    // ポーリングは同じ質問を新しいオブジェクトとして返し続ける。id が同じ
    // うちは失敗メッセージを消してはいけない — 消すと、送信が失敗したことに
    // 気づけないまま画面が元通りになる。
    rerender(
      panel({
        id: 'decision-1',
        kind: 'ticket',
        projectId: sampleTicket.projectId,
        question: '最初の質問',
        allowFreeform: true,
      }),
    );

    expect(screen.getByText(NETWORK_FETCH_HELP)).toBeInTheDocument();
  });
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

describe('TicketDetailPanel quick action undo snackbar', () => {
  let user: ReturnType<typeof userEvent.setup>;

  beforeEach(() => {
    mockFetchTicket.mockResolvedValue(sampleTicket);
    mockFetchTicketComments.mockResolvedValue([]);
    mockPostTicketQuickAction.mockResolvedValue(undefined);
    mockPostTicketQuickActionUndo.mockResolvedValue(undefined);
    user = userEvent.setup();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows an undo snackbar after claim and posts unclaim-equivalent undo on click', async () => {
    renderPanelWithUndoSnackbar(new Map());

    const claimButtons = await screen.findAllByRole('button', { name: '着手' });
    await user.click(claimButtons[0]!);
    await user.click(screen.getByRole('button', { name: '実行する' }));

    await waitFor(() => {
      expect(mockPostTicketQuickAction).toHaveBeenCalledWith(sampleTicket.id, {
        action: 'claim',
      });
    });

    expect(await screen.findByText('着手しました')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '元に戻す' }));

    await waitFor(() => {
      expect(mockPostTicketQuickActionUndo).toHaveBeenCalledWith(
        sampleTicket.id,
        { action: 'claim' },
      );
    });
    expect(await screen.findByText('元に戻しました')).toBeInTheDocument();
  });

  it('carries the pre-change priority into the undo request', async () => {
    renderPanelWithUndoSnackbar(new Map());

    const raiseButtons = await screen.findAllByRole('button', {
      name: '優先度を上げる',
    });
    await user.click(raiseButtons[0]!);
    await user.click(screen.getByRole('button', { name: '実行する' }));

    await waitFor(() => {
      expect(mockPostTicketQuickAction).toHaveBeenCalledWith(sampleTicket.id, {
        action: 'priority',
        priority: sampleTicket.priority - 1,
      });
    });

    await user.click(
      await screen.findByRole('button', { name: '元に戻す' }),
    );

    await waitFor(() => {
      // sampleTicket.priority (=2) はアクション実行前の値。invalidate 後の
      // 新しい値(1)ではなく、実行前の値へ戻すリクエストになっていることを確認する。
      // expectedCurrentPriority はクイックアクションで実際にセットした値
      // (priority - 1)で、サーバー側の CAS チェック(bdboard-3tw.82)の期待値になる。
      expect(mockPostTicketQuickActionUndo).toHaveBeenCalledWith(
        sampleTicket.id,
        {
          action: 'priority',
          previousPriority: sampleTicket.priority,
          expectedCurrentPriority: sampleTicket.priority - 1,
        },
      );
    });
  });

  it('surfaces a visible failure instead of silently succeeding when undo fails', async () => {
    mockPostTicketQuickActionUndo.mockRejectedValue(
      new Error('issue is assigned to a different actor'),
    );

    renderPanelWithUndoSnackbar(new Map());

    const claimButtons = await screen.findAllByRole('button', { name: '着手' });
    await user.click(claimButtons[0]!);
    await user.click(screen.getByRole('button', { name: '実行する' }));

    await user.click(
      await screen.findByRole('button', { name: '元に戻す' }),
    );

    expect(
      await screen.findByText(
        '元に戻せませんでした: issue is assigned to a different actor',
      ),
    ).toBeInTheDocument();
  });
});

describe('TicketDetailPanel comment shortcut', () => {
  let user: ReturnType<typeof userEvent.setup>;

  beforeEach(() => {
    mockFetchTicket.mockResolvedValue(sampleTicket);
    mockFetchTicketComments.mockResolvedValue([]);
    user = userEvent.setup();
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('focuses the comment textarea when c is pressed in the panel', async () => {
    renderPanel(new Map());

    await screen.findByText('Sample ticket');
    const panel = screen.getByRole('dialog');
    panel.focus();
    await user.keyboard('c');

    const commentTextarea = screen.getByLabelText('コメントを追加');
    expect(commentTextarea).toHaveFocus();
  });

  it('types c into the comment textarea when it already has focus', async () => {
    renderPanel(new Map());

    const commentTextarea = await screen.findByLabelText('コメントを追加');
    await user.click(commentTextarea);
    await user.keyboard('c');

    expect(commentTextarea).toHaveFocus();
    expect(commentTextarea).toHaveValue('c');
  });
});

describe('TicketDetailPanel dependency editing', () => {
  let user: ReturnType<typeof userEvent.setup>;

  const ticketWithDependencies: TicketDetailDto = {
    ...sampleTicket,
    dependencies: [
      {
        issueId: sampleTicket.id,
        dependsOnId: 'bdboard-blocker',
        kind: 'blocks',
      },
      {
        issueId: sampleTicket.id,
        dependsOnId: 'bdboard-parent',
        kind: 'parent-child',
      },
    ],
  };

  const searchResults: TicketSearchResultDto[] = [
    {
      id: 'bdboard-same.1',
      projectId: 'proj-1',
      projectName: 'Project One',
      title: 'Same project candidate',
      status: 'open',
      priority: 2,
      issueType: 'task',
    },
    {
      id: 'bdboard-other.1',
      projectId: 'proj-2',
      projectName: 'Project Two',
      title: 'Other project candidate',
      status: 'open',
      priority: 2,
      issueType: 'task',
    },
  ];

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockFetchTicket.mockResolvedValue(ticketWithDependencies);
    mockFetchTicketComments.mockResolvedValue([]);
    mockPostTicketDependency.mockResolvedValue(undefined);
    mockDeleteTicketDependency.mockResolvedValue(undefined);
    mockSearchTickets.mockResolvedValue(searchResults);
    user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows remove button only for blocks dependencies', async () => {
    renderPanel(new Map());

    expect(
      await screen.findByRole('button', {
        name: 'bdboard-blocker への依存を削除',
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', {
        name: 'bdboard-parent への依存を削除',
      }),
    ).not.toBeInTheDocument();
  });

  it('calls deleteTicketDependency when remove button is clicked', async () => {
    renderPanel(new Map());

    await user.click(
      await screen.findByRole('button', {
        name: 'bdboard-blocker への依存を削除',
      }),
    );

    await waitFor(() => {
      expect(mockDeleteTicketDependency).toHaveBeenCalledWith(
        sampleTicket.id,
        'bdboard-blocker',
      );
    });
  });

  it('searches and shows same-project candidates after debounce', async () => {
    renderPanel(new Map());

    await user.type(
      await screen.findByLabelText('依存を追加(このチケットが待つ相手)'),
      'candidate',
    );

    expect(mockSearchTickets).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);

    await waitFor(() => {
      expect(mockSearchTickets).toHaveBeenCalledWith('candidate', 20);
    });

    expect(await screen.findByText('Same project candidate')).toBeInTheDocument();
    expect(screen.queryByText('Other project candidate')).not.toBeInTheDocument();
  });

  it('ignores stale dependency search responses when an older request resolves after a newer one', async () => {
    const oldResults: TicketSearchResultDto[] = [
      {
        id: 'bdboard-old',
        projectId: 'proj-1',
        projectName: 'Project One',
        title: 'Old stale result',
        status: 'open',
        priority: 3,
        issueType: 'task',
      },
    ];
    const newResults: TicketSearchResultDto[] = [
      {
        id: 'bdboard-new',
        projectId: 'proj-1',
        projectName: 'Project One',
        title: 'New correct result',
        status: 'open',
        priority: 1,
        issueType: 'task',
      },
    ];

    let resolveOld: (value: TicketSearchResultDto[]) => void;
    let resolveNew: (value: TicketSearchResultDto[]) => void;
    const oldPromise = new Promise<TicketSearchResultDto[]>((resolve) => {
      resolveOld = resolve;
    });
    const newPromise = new Promise<TicketSearchResultDto[]>((resolve) => {
      resolveNew = resolve;
    });

    mockSearchTickets
      .mockReset()
      .mockImplementationOnce(() => oldPromise)
      .mockImplementationOnce(() => newPromise);

    renderPanel(new Map());

    const input = await screen.findByLabelText(
      '依存を追加(このチケットが待つ相手)',
    );

    fireEvent.change(input, { target: { value: 'abc' } });
    await vi.advanceTimersByTimeAsync(200);
    await waitFor(() => {
      expect(mockSearchTickets).toHaveBeenCalledWith('abc', 20);
    });

    fireEvent.change(input, { target: { value: 'abcd' } });
    await vi.advanceTimersByTimeAsync(200);
    await waitFor(() => {
      expect(mockSearchTickets).toHaveBeenCalledWith('abcd', 20);
    });

    resolveNew!(newResults);
    expect(await screen.findByText('New correct result')).toBeInTheDocument();

    resolveOld!(oldResults);
    await waitFor(() => {
      expect(screen.getByText('New correct result')).toBeInTheDocument();
      expect(screen.queryByText('Old stale result')).not.toBeInTheDocument();
    });
  });

  it('calls postTicketDependency when a candidate is selected', async () => {
    renderPanel(new Map());

    await user.type(
      await screen.findByLabelText('依存を追加(このチケットが待つ相手)'),
      'candidate',
    );
    await vi.advanceTimersByTimeAsync(200);

    await user.click(await screen.findByText('Same project candidate'));

    await waitFor(() => {
      expect(mockPostTicketDependency).toHaveBeenCalledWith(
        sampleTicket.id,
        'bdboard-same.1',
      );
    });
  });

  it('shows bd circular dependency detail when add fails with 502', async () => {
    mockPostTicketDependency.mockRejectedValue(
      new ApiError(502, 'failed to add dependency', {
        errorMessage: 'failed to add dependency',
        detail: 'would create circular dependency: bdboard-abc.1 -> bdboard-same.1',
      }),
    );

    renderPanel(new Map());

    await user.type(
      await screen.findByLabelText('依存を追加(このチケットが待つ相手)'),
      'candidate',
    );
    await vi.advanceTimersByTimeAsync(200);
    await user.click(await screen.findByText('Same project candidate'));

    expect(
      await screen.findByText(
        'would create circular dependency: bdboard-abc.1 -> bdboard-same.1',
      ),
    ).toBeInTheDocument();
  });
});

describe('TicketDetailPanel label editing', () => {
  let user: ReturnType<typeof userEvent.setup>;

  const ticketWithLabels: TicketDetailDto = {
    ...sampleTicket,
    labels: ['human'],
  };

  beforeEach(() => {
    mockFetchTicket.mockResolvedValue(ticketWithLabels);
    mockFetchTicketComments.mockResolvedValue([]);
    mockPostTicketAddLabel.mockResolvedValue(undefined);
    mockDeleteTicketLabel.mockResolvedValue(undefined);
    user = userEvent.setup();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('adds a label from the input', async () => {
    renderPanel(new Map(), undefined, undefined, undefined, [
      'human',
      'needs-review',
    ]);

    const input = await screen.findByLabelText('ラベルを追加');
    await user.type(input, 'needs-review');
    await user.click(screen.getByRole('button', { name: '追加' }));

    await waitFor(() => {
      expect(mockPostTicketAddLabel).toHaveBeenCalledWith(
        sampleTicket.id,
        'needs-review',
      );
    });
  });

  it('removes an existing label', async () => {
    renderPanel(new Map());

    await user.click(
      await screen.findByRole('button', { name: 'ラベル human を削除' }),
    );

    await waitFor(() => {
      expect(mockDeleteTicketLabel).toHaveBeenCalledWith(
        sampleTicket.id,
        'human',
      );
    });
  });

  it('shows label suggestions from availableLabels', async () => {
    renderPanel(new Map(), undefined, undefined, undefined, [
      'human',
      'needs-review',
    ]);

    const input = await screen.findByLabelText('ラベルを追加');
    await user.type(input, 'need');

    const suggestionList = document.querySelector('.label-suggestions');
    expect(suggestionList).not.toBeNull();
    expect(
      within(suggestionList as HTMLElement).getByText('needs-review'),
    ).toBeInTheDocument();
    expect(
      within(suggestionList as HTMLElement).queryByText('human'),
    ).not.toBeInTheDocument();
  });
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
});

describe('TicketDetailPanel models', () => {
  beforeEach(() => {
    mockFetchTicketComments.mockResolvedValue([]);
  });

  afterEach(() => {
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

describe('TicketDetailPanel session link', () => {
  let user: ReturnType<typeof userEvent.setup>;

  const activeSessions: SessionDto[] = [
    {
      sessionId: 'session-active-1',
      pid: 111,
      cwd: '/Users/me/projects/bdboard',
      alive: true,
      startedAt: '2026-08-14T09:00:00.000Z',
      lastActivityAt: '2026-08-14T10:00:00.000Z',
      liveness: 'active',
      name: 'Active session one',
    },
    {
      sessionId: 'session-dead-1',
      pid: 222,
      cwd: '/Users/me/projects/bdboard',
      alive: false,
      startedAt: '2026-08-14T09:00:00.000Z',
      lastActivityAt: '2026-08-14T09:30:00.000Z',
      liveness: 'dormant',
    },
  ];

  beforeEach(() => {
    mockFetchTicket.mockResolvedValue(sampleTicket);
    mockFetchTicketComments.mockResolvedValue([]);
    mockFetchSessions.mockResolvedValue(activeSessions);
    mockPostTicketSessionLink.mockResolvedValue(undefined);
    mockDeleteTicketSessionLink.mockResolvedValue(undefined);
    user = userEvent.setup();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows empty message when there are no session links', async () => {
    renderPanel(new Map());

    expect(
      await screen.findByText('リンクされたセッションはありません'),
    ).toBeInTheDocument();
  });

  it('shows manual and inferred badges and only offers unlink for manual links', async () => {
    mockFetchTicket.mockResolvedValue({
      ...sampleTicket,
      sessionLinks: [
        { sessionId: 'session-manual', source: 'metadata' },
        { sessionId: 'session-inferred', source: 'transcript' },
      ],
    });

    renderPanel(new Map());

    expect(await screen.findByText('session-manual')).toBeInTheDocument();
    expect(screen.getByText('session-inferred')).toBeInTheDocument();
    expect(screen.getByText('手動')).toBeInTheDocument();
    expect(screen.getByText('自動推定')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'session-manual のリンクを解除' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'session-inferred のリンクを解除' }),
    ).not.toBeInTheDocument();
  });

  it('calls deleteTicketSessionLink and invalidates the ticket query when unlink is clicked', async () => {
    mockFetchTicket.mockResolvedValue({
      ...sampleTicket,
      sessionLinks: [{ sessionId: 'session-manual', source: 'metadata' }],
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderPanel(new Map(), undefined, undefined, queryClient);

    await user.click(
      await screen.findByRole('button', {
        name: 'session-manual のリンクを解除',
      }),
    );

    await waitFor(() => {
      expect(mockDeleteTicketSessionLink).toHaveBeenCalledWith(sampleTicket.id);
    });
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['ticket', sampleTicket.id],
      });
    });
  });

  it('does not fetch sessions until the picker is opened', async () => {
    renderPanel(new Map());

    await screen.findByText('リンクされたセッションはありません');
    expect(mockFetchSessions).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole('button', { name: 'セッションをリンク' }),
    );

    await waitFor(() => {
      expect(mockFetchSessions).toHaveBeenCalledTimes(1);
    });
  });

  it('explains why the picker is empty on a platform without session discovery', async () => {
    // win32 ではセッション検出そのものが動かないため、ここは常に空になる。
    // 理由が出ないと「稼働中のセッションがありません」が壊れているようにしか
    // 読めない (bdboard-70z.9, PR#115 fable レビュー minor)。
    mockFetchPlatformSupport.mockResolvedValue({
      platform: 'win32',
      limitations: [
        {
          feature: 'session-discovery',
          reason: '稼働中のエージェントセッションの検出は Windows では利用できません。',
          detail: 'セッション検出は ps と lsof に依存している。',
        },
      ],
    });
    renderPanel(new Map());

    await user.click(
      await screen.findByRole('button', { name: 'セッションをリンク' }),
    );

    expect(
      await screen.findByText(
        '稼働中のエージェントセッションの検出は Windows では利用できません。',
      ),
    ).toBeInTheDocument();
  });

  it('lists only alive sessions as link candidates', async () => {
    renderPanel(new Map());

    await user.click(
      await screen.findByRole('button', { name: 'セッションをリンク' }),
    );

    expect(
      await screen.findByText('Active session one (/Users/me/projects/bdboard)'),
    ).toBeInTheDocument();
    expect(screen.queryByText('session-dead-1')).not.toBeInTheDocument();
  });

  it('calls postTicketSessionLink when a candidate session is selected and closes the picker', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderPanel(new Map(), undefined, undefined, queryClient);

    await user.click(
      await screen.findByRole('button', { name: 'セッションをリンク' }),
    );
    await user.click(
      await screen.findByText('Active session one (/Users/me/projects/bdboard)'),
    );

    await waitFor(() => {
      expect(mockPostTicketSessionLink).toHaveBeenCalledWith(
        sampleTicket.id,
        'session-active-1',
      );
    });
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ['ticket', sampleTicket.id],
      });
    });
    // '閉じる' also labels the panel's own close button, so assert on
    // picker-specific content instead of that ambiguous button name.
    await waitFor(() => {
      expect(
        screen.queryByText('Active session one (/Users/me/projects/bdboard)'),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.getByRole('button', { name: 'セッションをリンク' }),
    ).toBeInTheDocument();
  });

  it('shows an error message when linking fails', async () => {
    mockPostTicketSessionLink.mockRejectedValue(
      new ApiError(502, 'failed to link session', {
        errorMessage: 'failed to link session',
        detail: 'bd exited with an error',
      }),
    );

    renderPanel(new Map());

    await user.click(
      await screen.findByRole('button', { name: 'セッションをリンク' }),
    );
    await user.click(
      await screen.findByText('Active session one (/Users/me/projects/bdboard)'),
    );

    expect(
      await screen.findByText('failed to link session'),
    ).toBeInTheDocument();
  });
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

describe('TicketDetailPanel resize', () => {
  beforeEach(() => {
    mockFetchTicket.mockResolvedValue(sampleTicket);
    mockFetchTicketComments.mockResolvedValue([]);
  });

  it('resizes on desktop and remembers its width', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
    const first = renderPanel(new Map());
    await screen.findByText(sampleTicket.title);
    const panel = first.container.querySelector('.detail-panel');
    const handle = screen.getByRole('separator', { name: 'チケット詳細パネルの幅を変更' });

    expect(panel).toHaveStyle({ width: '480px' });
    // pointerdown はカーソル位置から幅を再計算しない(bdboard-p2ew): ハンドルと
    // カーソル位置がずれていても、ドラッグ開始直後に幅が瞬間的に跳ばない。
    fireEvent(handle, new MouseEvent('pointerdown', { bubbles: true, clientX: 0 }));
    expect(panel).toHaveStyle({ width: '480px' });
    expect(localStorage.getItem('bdboard.ui.ticketDetailPanelWidth')).toBeNull();

    // pointerdown からの移動量(差分)で幅を更新する。開始位置から 900px 左に
    // 移動しており、480 + 900 は viewportMaximum(1000-320=680) でクランプされる。
    fireEvent(handle, new MouseEvent('pointermove', { bubbles: true, clientX: -900 }));
    expect(panel).toHaveStyle({ width: '680px' });
    // ドラッグ中はまだ localStorage へ書き込まない。確定は pointerup 時のみ。
    expect(localStorage.getItem('bdboard.ui.ticketDetailPanelWidth')).toBeNull();

    fireEvent(handle, new MouseEvent('pointerup', { bubbles: true }));
    expect(localStorage.getItem('bdboard.ui.ticketDetailPanelWidth')).toBe('680');
  });

  it('ハンドルにフォーカスがある状態で最大化してもフォーカスがパネル外へ落ちない', async () => {
    /*
     * 最大化するとリサイズハンドルが DOM から外れる。フォーカスがそこに残ったまま
     * だと activeElement が body に落ち、useFocusTrap がパネル要素に張った keydown
     * を受け取れなくなって Escape で閉じられなくなる (opus レビュー minor-1)。
     *
     * fireEvent.click を使うのが肝。userEvent.click は自前でフォーカスをボタンへ
     * 移すので、実装が何もしなくても通ってしまう (実測で確認: userEvent 版だと
     * focus() を削る変異が生存した)。fireEvent.click はフォーカスを動かさないので、
     * button クリックでフォーカスを与えない Safari/macOS と等価な経路になる。
     */
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
    const { container } = renderPanel(new Map());
    await screen.findByText(sampleTicket.title);

    const handle = screen.getByRole('separator', { name: 'チケット詳細パネルの幅を変更' });
    handle.focus();
    expect(document.activeElement).toBe(handle);

    fireEvent.click(screen.getByRole('button', { name: '最大化' }));

    expect(document.activeElement).not.toBe(document.body);
    expect(container.querySelector('.detail-panel')?.contains(document.activeElement)).toBe(true);

    // フォーカストラップが生きている = Escape でちゃんと閉じられる。
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  });

  it('最大化で全幅にし、解除すると直前の幅へ戻る (bdboard-0hcx)', async () => {
    // ドラッグ/キーボードのリサイズは MAX_WIDTH (720px) で頭打ちになる。最大化は
    // その上限を意図的に越える表示モードで、解除したら直前の幅へ戻ること。
    // 上限 720px が視野幅由来のクランプ (innerWidth - 320) より小さくなる幅に
    // 固定する。既定の 1024 のままだと 704px で頭打ちになり本題がぼやける。
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
    const user = userEvent.setup();
    const first = renderPanel(new Map());
    await screen.findByText(sampleTicket.title);
    const panel = first.container.querySelector('.detail-panel');
    const handleName = 'チケット詳細パネルの幅を変更';

    fireEvent.keyDown(screen.getByRole('separator', { name: handleName }), { key: 'End' });
    expect(panel).toHaveStyle({ width: '720px' });
    expect(localStorage.getItem('bdboard.ui.ticketDetailPanelWidth')).toBe('720');

    const maximize = screen.getByRole('button', { name: '最大化' });
    // 見出しの操作は .detail-header-actions にまとめる (ChatPanel と同じ)。
    expect(maximize.parentElement?.className).toContain('detail-header-actions');
    // aria-pressed は付けない。状態はラベル自体が伝える。
    expect(maximize).not.toHaveAttribute('aria-pressed');
    await user.click(maximize);

    expect(panel).toHaveStyle({ width: '100%' });
    expect(panel?.className).toContain('is-maximized');
    expect(screen.queryByRole('separator', { name: handleName })).not.toBeInTheDocument();
    // 100% は一時的な表示状態であり、通常幅の保存値を書き換えない。
    expect(localStorage.getItem('bdboard.ui.ticketDetailPanelWidth')).toBe('720');

    const shrink = screen.getByRole('button', { name: '縮小' });
    expect(shrink).not.toHaveAttribute('aria-pressed');
    await user.click(shrink);

    expect(panel).toHaveStyle({ width: '720px' });
    expect(panel?.className).not.toContain('is-maximized');
    expect(screen.getByRole('separator', { name: handleName })).toBeInTheDocument();

    // 最大化はこの表示中だけの状態。次に開いたときは保存済みの通常幅から。
    first.unmount();
    const second = renderPanel(new Map());
    await screen.findByText(sampleTicket.title);
    expect(second.container.querySelector('.detail-panel')).toHaveStyle({ width: '720px' });
    expect(screen.getByRole('button', { name: '最大化' })).toBeInTheDocument();
  });
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

describe('TicketDetailPanel agent run', () => {
  let user: ReturnType<typeof userEvent.setup>;

  const runningRunDetail: AgentRunDetailDto = {
    id: 'run-1',
    ticketId: sampleTicket.id,
    runner: 'claude',
    mode: 'spawn',
    status: 'running',
    startedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp/worktrees/bdboard-abc.1',
    log: 'starting claude\n',
  };

  const succeededRunDetail: AgentRunDetailDto = {
    ...runningRunDetail,
    status: 'succeeded',
    finishedAt: '2026-01-01T00:05:00.000Z',
    exitCode: 0,
    log: 'starting claude\ndone\n',
  };

  const cancellingRunDetail: AgentRunDetailDto = {
    ...runningRunDetail,
    status: 'cancelling',
  };

  const cancelledRunDetail: AgentRunDetailDto = {
    ...runningRunDetail,
    status: 'cancelled',
    finishedAt: '2026-01-01T00:03:00.000Z',
  };

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockFetchTicket.mockResolvedValue(sampleTicket);
    mockFetchTicketComments.mockResolvedValue([]);
    mockFetchTicketRuns.mockResolvedValue({ runs: [] });
    mockStartTicketRun.mockResolvedValue({
      runId: 'run-1',
      ticketId: sampleTicket.id,
      status: 'pending',
      worktreePath: '/tmp/worktrees/bdboard-abc.1',
      branchName: 'bd/bdboard-abc.1',
      reused: false,
    });
    mockFetchAgentRun.mockResolvedValue(runningRunDetail);
    mockCancelAgentRun.mockResolvedValue({ runId: 'run-1', status: 'cancelling' });
    user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('disables the run button when the ticket is blocked', async () => {
    mockFetchTicket.mockResolvedValue({
      ...sampleTicket,
      blockedBy: ['other'],
    });

    renderPanel(new Map());

    const runButton = await screen.findByRole('button', { name: '▶ 実行' });
    expect(runButton).toBeDisabled();
    expect(runButton).toHaveAttribute('title', 'ブロック中のチケットは実行できません');
  });

  it('starts a run and shows worktree metadata after confirmation', async () => {
    renderPanel(new Map());

    await user.click(await screen.findByRole('button', { name: '▶ 実行' }));
    const confirmPanel = screen.getByRole('alertdialog', {
      name: 'エージェント実行の確認',
    });
    await user.click(within(confirmPanel).getByRole('button', { name: '実行する' }));

    await waitFor(() => {
      expect(mockStartTicketRun).toHaveBeenCalledWith(sampleTicket.id);
    });

    expect(await screen.findByText('/tmp/worktrees/bdboard-abc.1')).toBeInTheDocument();
    expect(screen.getByText('bd/bdboard-abc.1')).toBeInTheDocument();
    expect(screen.getByText('新規作成')).toBeInTheDocument();
  });

  it('polls while running and stops after a terminal status', async () => {
    mockFetchAgentRun
      .mockResolvedValueOnce(runningRunDetail)
      .mockResolvedValueOnce(runningRunDetail)
      .mockResolvedValueOnce(succeededRunDetail);

    renderPanel(new Map());

    await user.click(await screen.findByRole('button', { name: '▶ 実行' }));
    const confirmPanel = screen.getByRole('alertdialog', {
      name: 'エージェント実行の確認',
    });
    await user.click(within(confirmPanel).getByRole('button', { name: '実行する' }));

    await waitFor(() => {
      expect(mockFetchAgentRun).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    await waitFor(() => {
      expect(mockFetchAgentRun).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    await waitFor(() => {
      expect(mockFetchAgentRun).toHaveBeenCalledTimes(3);
    });

    const callCountAfterTerminal = mockFetchAgentRun.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });

    expect(mockFetchAgentRun.mock.calls.length).toBe(callCountAfterTerminal);
    expect(await screen.findByText(/状態: 成功/)).toBeInTheDocument();
  });

  it('shows remote-run disabled help on 403', async () => {
    mockStartTicketRun.mockRejectedValue(
      new ApiError(403, 'remote agent runs are disabled', {
        errorMessage: 'remote agent runs are disabled',
      }),
    );

    renderPanel(new Map());

    await user.click(await screen.findByRole('button', { name: '▶ 実行' }));
    const confirmPanel = screen.getByRole('alertdialog', {
      name: 'エージェント実行の確認',
    });
    await user.click(within(confirmPanel).getByRole('button', { name: '実行する' }));

    expect(
      await screen.findByText(REMOTE_AGENT_RUNS_DISABLED_HELP),
    ).toBeInTheDocument();
  });

  it('shows a dedicated message when worktree is dirty (409 reason=worktree-dirty)', async () => {
    mockStartTicketRun.mockRejectedValue(
      new ApiError(
        409,
        '/tmp/worktrees/bdboard-abc.1: uncommitted changes prevent agent run',
        {
          errorMessage:
            '/tmp/worktrees/bdboard-abc.1: uncommitted changes prevent agent run',
          reason: 'worktree-dirty',
        },
      ),
    );

    renderPanel(new Map());

    await user.click(await screen.findByRole('button', { name: '▶ 実行' }));
    const confirmPanel = screen.getByRole('alertdialog', {
      name: 'エージェント実行の確認',
    });
    await user.click(within(confirmPanel).getByRole('button', { name: '実行する' }));

    expect(
      await screen.findByText(/未コミットの変更があるため実行できません/),
    ).toBeInTheDocument();
    expect(screen.getByText(/\/tmp\/worktrees\/bdboard-abc\.1/)).toBeInTheDocument();
  });

  it('still renders the dirty-worktree message when the path is absent from the message', async () => {
    mockStartTicketRun.mockRejectedValue(
      new ApiError(409, 'worktree has uncommitted changes', {
        errorMessage: 'worktree has uncommitted changes',
        reason: 'worktree-dirty',
      }),
    );

    renderPanel(new Map());

    await user.click(await screen.findByRole('button', { name: '▶ 実行' }));
    const confirmPanel = screen.getByRole('alertdialog', {
      name: 'エージェント実行の確認',
    });
    await user.click(within(confirmPanel).getByRole('button', { name: '実行する' }));

    expect(
      await screen.findByText(/未コミットの変更があるため実行できません/),
    ).toBeInTheDocument();
  });

  it('shows a dedicated message when worktree is on a different branch (409 reason=worktree-branch-mismatch)', async () => {
    mockStartTicketRun.mockRejectedValue(
      new ApiError(
        409,
        '/tmp/worktrees/bdboard-abc.1: on branch main, expected bd/bdboard-abc.1',
        {
          errorMessage:
            '/tmp/worktrees/bdboard-abc.1: on branch main, expected bd/bdboard-abc.1',
          reason: 'worktree-branch-mismatch',
        },
      ),
    );

    renderPanel(new Map());

    await user.click(await screen.findByRole('button', { name: '▶ 実行' }));
    const confirmPanel = screen.getByRole('alertdialog', {
      name: 'エージェント実行の確認',
    });
    await user.click(within(confirmPanel).getByRole('button', { name: '実行する' }));

    expect(
      await screen.findByText(/別のブランチ（main）にあるため実行できません/),
    ).toBeInTheDocument();
  });

  it('still renders the branch-mismatch message when the branch name is absent from the message', async () => {
    mockStartTicketRun.mockRejectedValue(
      new ApiError(409, 'worktree branch mismatch', {
        errorMessage: 'worktree branch mismatch',
        reason: 'worktree-branch-mismatch',
      }),
    );

    renderPanel(new Map());

    await user.click(await screen.findByRole('button', { name: '▶ 実行' }));
    const confirmPanel = screen.getByRole('alertdialog', {
      name: 'エージェント実行の確認',
    });
    await user.click(within(confirmPanel).getByRole('button', { name: '実行する' }));

    expect(
      await screen.findByText(/別のブランチにあるため実行できません/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/別のブランチ（/)).not.toBeInTheDocument();
  });

  it('does not claim a dirty worktree for a 409 that carries no reason', async () => {
    // 判定が `reason` ではなくメッセージの文字列一致に退行したら、この
    // ケースが誤って dirty-worktree 扱いになるので落ちる。
    mockStartTicketRun.mockRejectedValue(
      new ApiError(
        409,
        '/tmp/worktrees/bdboard-abc.1: uncommitted changes prevent agent run',
        {
          errorMessage:
            '/tmp/worktrees/bdboard-abc.1: uncommitted changes prevent agent run',
        },
      ),
    );

    renderPanel(new Map());

    await user.click(await screen.findByRole('button', { name: '▶ 実行' }));
    const confirmPanel = screen.getByRole('alertdialog', {
      name: 'エージェント実行の確認',
    });
    await user.click(within(confirmPanel).getByRole('button', { name: '実行する' }));

    // reason が無い 409 は describeWriteError の汎用 409 分岐に落ちる。
    expect(await screen.findByText(CONFLICT_WRITE_HELP)).toBeInTheDocument();
    expect(
      screen.queryByText(/未コミットの変更があるため実行できません/),
    ).not.toBeInTheDocument();
  });

  it('stops polling after three consecutive failures and re-enables the run button', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetchAgentRun.mockRejectedValue(new Error('boom'));

    renderPanel(new Map());

    await user.click(await screen.findByRole('button', { name: '▶ 実行' }));
    const confirmPanel = screen.getByRole('alertdialog', {
      name: 'エージェント実行の確認',
    });
    await user.click(within(confirmPanel).getByRole('button', { name: '実行する' }));

    await waitFor(() => {
      expect(mockFetchAgentRun).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    await waitFor(() => {
      expect(mockFetchAgentRun).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    await waitFor(() => {
      expect(mockFetchAgentRun).toHaveBeenCalledTimes(3);
    });

    const callCountAfterStop = mockFetchAgentRun.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });

    expect(mockFetchAgentRun.mock.calls.length).toBe(callCountAfterStop);
    expect(screen.getByText(/状態を取得できません/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '▶ 実行' })).not.toBeDisabled();
  });

  it('keeps polling while cancelling and stops after cancelled', async () => {
    mockFetchAgentRun
      .mockResolvedValueOnce(runningRunDetail)
      .mockResolvedValueOnce(cancellingRunDetail)
      .mockResolvedValueOnce(cancellingRunDetail)
      .mockResolvedValueOnce(cancelledRunDetail);

    renderPanel(new Map());

    await user.click(await screen.findByRole('button', { name: '▶ 実行' }));
    const confirmPanel = screen.getByRole('alertdialog', {
      name: 'エージェント実行の確認',
    });
    await user.click(within(confirmPanel).getByRole('button', { name: '実行する' }));

    await waitFor(() => {
      expect(mockFetchAgentRun).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    await waitFor(() => {
      expect(mockFetchAgentRun).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: '中止中…' }),
      ).toBeDisabled();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    await waitFor(() => {
      expect(mockFetchAgentRun).toHaveBeenCalledTimes(3);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    await waitFor(() => {
      expect(mockFetchAgentRun).toHaveBeenCalledTimes(4);
    });

    const callCountAfterTerminal = mockFetchAgentRun.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });

    expect(mockFetchAgentRun.mock.calls.length).toBe(callCountAfterTerminal);
    expect(await screen.findByText(/状態: 中止/)).toBeInTheDocument();
  });

  it('shows reused worktree label when the server reuses an existing worktree', async () => {
    mockStartTicketRun.mockResolvedValue({
      runId: 'run-1',
      ticketId: sampleTicket.id,
      status: 'pending',
      worktreePath: '/tmp/worktrees/bdboard-abc.1',
      branchName: 'bd/bdboard-abc.1',
      reused: true,
    });

    renderPanel(new Map());

    await user.click(await screen.findByRole('button', { name: '▶ 実行' }));
    const confirmPanel = screen.getByRole('alertdialog', {
      name: 'エージェント実行の確認',
    });
    await user.click(within(confirmPanel).getByRole('button', { name: '実行する' }));

    expect(await screen.findByText('既存を再利用')).toBeInTheDocument();
  });
});
