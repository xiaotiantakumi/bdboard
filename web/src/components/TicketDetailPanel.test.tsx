import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  deleteTicketDependency,
  deleteTicketLabel,
  deleteTicketSessionLink,
  fetchSessions,
  fetchTicket,
  fetchTicketComments,
  fetchTicketTimeline,
  fetchSimilarTickets,
  postTicketComment,
  postTicketDecision,
  postTicketAddLabel,
  postTicketDependency,
  postTicketQuickAction,
  postTicketQuickActionUndo,
  postTicketSessionLink,
  searchTickets,
} from '../api';
import { TicketDetailPanel } from './TicketDetailPanel';
import { UndoSnackbarProvider } from './UndoSnackbar';
import { WatchedTicketsProvider } from './WatchedTicketsProvider';
import { computeDeferUntilDate } from '../deferPeriods';
import { NETWORK_FETCH_HELP, TUNNEL_WRITE_HELP } from '../writeAccessMessage';

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
    postTicketDependency: vi.fn(),
    deleteTicketDependency: vi.fn(),
    deleteTicketLabel: vi.fn(),
    searchTickets: vi.fn(),
    fetchSessions: vi.fn(),
    postTicketSessionLink: vi.fn(),
    deleteTicketSessionLink: vi.fn(),
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
const mockPostTicketDependency = vi.mocked(postTicketDependency);
const mockDeleteTicketDependency = vi.mocked(deleteTicketDependency);
const mockDeleteTicketLabel = vi.mocked(deleteTicketLabel);
const mockSearchTickets = vi.mocked(searchTickets);
const mockFetchSessions = vi.mocked(fetchSessions);
const mockPostTicketSessionLink = vi.mocked(postTicketSessionLink);
const mockDeleteTicketSessionLink = vi.mocked(deleteTicketSessionLink);

beforeEach(() => {
  mockFetchSimilarTickets.mockResolvedValue([]);
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
        <TicketDetailPanel
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
        <TicketDetailPanel
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
          <TicketDetailPanel
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
          <TicketDetailPanel
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
          <TicketDetailPanel
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
    mockPostTicketDecision.mockResolvedValue(undefined);
    user = userEvent.setup();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('hides the pending decision section when pendingDecision is undefined', async () => {
    renderPanel(new Map());

    await screen.findByText('Sample ticket');
    expect(screen.queryByText('ユーザー確認待ち')).not.toBeInTheDocument();
  });

  it('shows only freeform when question exists without options', async () => {
    renderPanel(new Map(), {
      id: sampleTicket.id,
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
  });

  it('submits freeform text only', async () => {
    renderPanel(new Map(), {
      id: sampleTicket.id,
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
      projectId: sampleTicket.projectId,
      allowFreeform: true,
    });

    const textarea = await screen.findByLabelText('自由記入');
    await user.type(textarea, 'トンネル経由の回答');
    await user.click(screen.getByRole('button', { name: '回答を送信' }));

    expect(await screen.findByText(TUNNEL_WRITE_HELP)).toBeInTheDocument();
    expect(textarea).toHaveValue('トンネル経由の回答');
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
