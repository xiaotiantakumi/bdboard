// bdboard-sso1.88: TicketDetailPanel.test.tsx (2764行) から move-only で分割した
// 「pending-decisions」関心のファイル。関数本体・アサーション・フィクスチャの値は
// 元ファイルから1文字も変えていない。

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PendingDecisionDto,
  PrBadgeDto,
} from '../api';
import {
  ApiError,
  fetchTicket,
  fetchTicketComments,
  fetchSimilarTickets,
  postTicketDecision,
  fetchPlatformSupport,
  fetchTicketRuns,
  fetchTicketInFlightOverlaps,
  fetchProjectHarnessStatus,
} from '../api';
import { resetPlatformSupportCache } from './PlatformLimitationNotice';
import { MaximizablePanel, harnessStatus, renderPanel, sampleTicket } from './TicketDetailPanel-test-support';
import { WatchedTicketsProvider } from './WatchedTicketsProvider';
import {
  NETWORK_FETCH_HELP,
  TUNNEL_WRITE_HELP,
} from '../writeAccessMessage';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    fetchTicket: vi.fn(),
    fetchTicketComments: vi.fn(),
    fetchSimilarTickets: vi.fn(),
    postTicketDecision: vi.fn(),
    fetchPlatformSupport: vi.fn(),
    fetchTicketRuns: vi.fn(),
    fetchTicketInFlightOverlaps: vi.fn(),
    fetchProjectHarnessStatus: vi.fn(),
  };
});

const mockFetchTicket = vi.mocked(fetchTicket);
const mockFetchTicketComments = vi.mocked(fetchTicketComments);
const mockFetchSimilarTickets = vi.mocked(fetchSimilarTickets);
const mockPostTicketDecision = vi.mocked(postTicketDecision);
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

const defaultTicketDecisionOutcome = {
  kind: 'ticket',
  closed: false,
} as const;

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

describe('TicketDetailPanel pending decisions', () => {
  let user: ReturnType<typeof userEvent.setup>;

  beforeEach(() => {
    mockFetchTicket.mockResolvedValue(sampleTicket);
    mockFetchTicketComments.mockResolvedValue([]);
    mockPostTicketDecision.mockResolvedValue(defaultTicketDecisionOutcome);
    user = userEvent.setup();
  });

  afterEach(() => {
    vi.resetAllMocks();
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
    // bdboard-n5ns: no clearedHumanLabelTicketIds in the response means no sibling notice.
    expect(
      screen.queryByText(/他に .* 件のチケットの確認待ちも解除しました/),
    ).not.toBeInTheDocument();
  });

  // bdboard-v78e: when respond() returns ambiguousGateIds (bdboard-q1k9: 2+ distinct open
  // human gates blocked this ticket, so nothing was resolved), the UI must show guidance
  // to answer the gates individually instead of the generic closed:false message, which
  // would otherwise falsely imply the ticket left the awaiting-human queue.
  // bdboard-cine: the wording is deliberately reason-neutral — ambiguousGateIds is also
  // returned for a single blocking gate when the ticket itself carries its own
  // decision_question (respond.ts), and RespondOutcome doesn't distinguish which reason
  // applied. This test's 2-gate fixture exercises the q1k9 shape, but the same text (and
  // this same assertion) covers the cine shape too — see
  // bd-cli-human-decisions.respond.test.ts for the server-side behavior of each case.
  it('shows ambiguous-gate guidance instead of the generic message when the decision resolves nothing (bdboard-v78e)', async () => {
    mockPostTicketDecision.mockResolvedValue({
      kind: 'ticket',
      closed: false,
      ambiguousGateIds: ['bdboard-gate-1', 'bdboard-gate-2'],
    });

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

    expect(
      await screen.findByText(
        'このチケットには、個別に回答が必要な human gate が残っています。回答はこのチケットへのコメントとして記録しましたが、gate の解決と確認待ちの解除は行っていません。このチケットは確認待ちのまま残ります。下の gate を開いて個別に回答してください。gate に回答した後もこのチケットが確認待ちのまま残っている場合は、このチケットにもう一度回答してください。',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'bdboard-gate-1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'bdboard-gate-2' })).toBeInTheDocument();
    expect(
      screen.queryByText(
        'このチケットはクローズしていません。確認待ちから外れ、次の更新で通常のレーンに戻ります。',
      ),
    ).not.toBeInTheDocument();
  });

  // bdboard-v78e レビュー指摘#9: ambiguousGateIds のリンクはサーバー由来の確定IDなので、
  // 盤面フィルタ状態(isTicketOnBoard)に関わらず常にクリック可能でなければならない
  // (エピック絞り込み中は gate が isTicketOnBoard=false になりがち — TicketIdLink を
  // 使わずボタン直書きにしたのはそのため)。isTicketOnBoard=false でも押せること、押すと
  // onOpenTicket が正しい gate ID で呼ばれることを回帰テストで固定する。
  it('keeps ambiguous-gate links clickable even when isTicketOnBoard reports false (bdboard-v78e)', async () => {
    mockPostTicketDecision.mockResolvedValue({
      kind: 'ticket',
      closed: false,
      ambiguousGateIds: ['bdboard-gate-9'],
    });

    const onOpenTicket = vi.fn();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <WatchedTicketsProvider>
          <MaximizablePanel
            ticketId={sampleTicket.id}
            projectRootPaths={new Map()}
            pendingDecision={{
              id: sampleTicket.id,
              kind: 'ticket',
              projectId: sampleTicket.projectId,
              options: [
                { label: 'A案', value: 'a' },
                { label: 'B案', value: 'b' },
              ],
              allowFreeform: true,
            }}
            onClose={() => {}}
            onChatAboutTicket={() => {}}
            onOpenTicket={onOpenTicket}
            isTicketOnBoard={() => false}
            onFilterByEpic={() => {}}
          />
        </WatchedTicketsProvider>
      </QueryClientProvider>,
    );

    await user.click(await screen.findByRole('button', { name: 'A案' }));
    await user.click(screen.getByRole('button', { name: '回答を送信' }));

    const gateLink = await screen.findByRole('button', { name: 'bdboard-gate-9' });
    expect(gateLink).toBeInTheDocument();
    expect(gateLink).not.toBeDisabled();

    await user.click(gateLink);
    expect(onOpenTicket).toHaveBeenCalledWith('bdboard-gate-9');
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

  it('shows sibling human-label notices for ticket decisions alongside the normal outcome', async () => {
    mockPostTicketDecision.mockResolvedValue({
      kind: 'ticket',
      closed: false,
      clearedHumanLabelTicketIds: ['bdboard-sib-1', 'bdboard-sib-2'],
    });

    const onOpenTicket = vi.fn();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <WatchedTicketsProvider>
          <MaximizablePanel
            ticketId={sampleTicket.id}
            projectRootPaths={new Map()}
            pendingDecision={{
              id: sampleTicket.id,
              kind: 'ticket',
              projectId: sampleTicket.projectId,
              options: [{ label: 'A案', value: 'a' }],
              allowFreeform: true,
            }}
            onClose={() => {}}
            onChatAboutTicket={() => {}}
            onOpenTicket={onOpenTicket}
            isTicketOnBoard={() => true}
            onFilterByEpic={() => {}}
          />
        </WatchedTicketsProvider>
      </QueryClientProvider>,
    );

    await user.click(await screen.findByRole('button', { name: 'A案' }));
    await user.click(screen.getByRole('button', { name: '回答を送信' }));

    expect(await screen.findByText('他に 2 件のチケットの確認待ちも解除しました:')).toBeInTheDocument();
    const sib1Link = screen.getByRole('button', { name: 'bdboard-sib-1' });
    expect(sib1Link).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'bdboard-sib-2' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'このチケットはクローズしていません。確認待ちから外れ、次の更新で通常のレーンに戻ります。',
      ),
    ).toBeInTheDocument();

    await user.click(sib1Link);
    expect(onOpenTicket).toHaveBeenCalledWith('bdboard-sib-1');
  });

  it('shows sibling human-label notices for gate decisions alongside the gate outcome', async () => {
    mockPostTicketDecision.mockResolvedValue({
      kind: 'gate',
      closed: true,
      clearedHumanLabelTicketIds: ['bdboard-sib-3'],
    });

    renderPanel(new Map(), {
      id: sampleTicket.id,
      kind: 'gate',
      projectId: sampleTicket.projectId,
      allowFreeform: true,
    });

    await user.type(await screen.findByLabelText('自由記入'), 'ゲート回答');
    await user.click(screen.getByRole('button', { name: '回答を送信' }));

    expect(await screen.findByText('他に 1 件のチケットの確認待ちも解除しました:')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'bdboard-sib-3' })).toBeInTheDocument();
    expect(
      screen.getByText(
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
