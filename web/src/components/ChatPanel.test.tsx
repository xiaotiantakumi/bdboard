import { StrictMode } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatAgentDto, ChatThreadDto, ProjectDto } from '../api';
import { expectNoA11yViolations } from '../test/axe';
import { installFakeHistory } from '../test/fakeHistory';
import { writePersistedChatThread, readPersistedChatThreads } from '../chatThreadStorage';
import { CHAT_BUSY_HELP } from '../writeAccessMessage';
import { ChatPanel } from './ChatPanel';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    fetchChatAgents: vi.fn(() => Promise.resolve<ChatAgentDto[]>([])),
    fetchChatThreads: vi.fn(() => Promise.resolve<ChatThreadDto[]>([])),
    deleteChatThread: vi.fn(() => Promise.resolve()),
    updateChatThread: vi.fn(() =>
      Promise.resolve<ChatThreadDto>({
        sessionId: 'sess-1',
        agentId: 'claude',
        title: 'updated',
        pinned: false,
        updatedAt: '2026-01-01T00:00:00Z',
      }),
    ),
    fetchDiscoveredChatSessions: vi.fn(() => Promise.resolve({ sessions: [] })),
  };
});

import {
  deleteChatThread,
  fetchChatAgents,
  fetchChatThreads,
  fetchDiscoveredChatSessions,
  updateChatThread,
} from '../api';

const fetchChatAgentsMock = vi.mocked(fetchChatAgents);
const fetchChatThreadsMock = vi.mocked(fetchChatThreads);
const deleteChatThreadMock = vi.mocked(deleteChatThread);
const updateChatThreadMock = vi.mocked(updateChatThread);
const fetchDiscoveredChatSessionsMock = vi.mocked(fetchDiscoveredChatSessions);
const defaultWindowInnerWidth = window.innerWidth;

function makeProjectDto(
  overrides: Partial<ProjectDto> & Pick<ProjectDto, 'id'>,
): ProjectDto {
  return {
    name: overrides.name ?? overrides.id,
    rootPath: `/projects/${overrides.id}`,
    prefixes: ['bdboard'],
    sessionCount: 0,
    activeSessionCount: 0,
    sessions: [],
    ...overrides,
  };
}

const PROJECT_A = makeProjectDto({ id: 'proj-a', name: 'Project Alpha' });
const PROJECT_B = makeProjectDto({ id: 'proj-b', name: 'Project Beta' });

const CLAUDE_AGENT: ChatAgentDto = {
  id: 'claude',
  label: 'Claude',
  models: [{ id: 'sonnet', label: 'Sonnet' }],
  experimental: false,
  capability: 'bd-only',
  availability: 'available',
  supportsStreaming: false,
};

const EXAMPLE_AGENT: ChatAgentDto = {
  id: 'example-agent',
  label: 'Example Agent',
  models: [{ id: 'fast', label: 'Fast' }],
  experimental: false,
  capability: 'bd-only',
  availability: 'available',
  supportsStreaming: false,
};

const AGY_AGENT: ChatAgentDto = {
  id: 'agy',
  label: 'Antigravity',
  models: [{ id: 'gemini', label: 'Gemini' }],
  experimental: true,
  capability: 'bd-only',
  availability: 'available',
  supportsStreaming: false,
};

const READS_PROJECT_AGENT: ChatAgentDto = {
  id: 'reads-project-agent',
  label: 'Reads Project Agent',
  models: [{ id: 'sonnet', label: 'Sonnet' }],
  experimental: false,
  capability: 'reads-project',
  availability: 'available',
  supportsStreaming: false,
};

const STREAMING_AGENT: ChatAgentDto = {
  ...CLAUDE_AGENT,
  supportsStreaming: true,
};

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function getChatMessagePostCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(
    ([url, init]) =>
      url === '/api/chat/message' &&
      (init as RequestInit | undefined)?.method === 'POST',
  );
}

function parseChatMessageBody(
  fetchMock: ReturnType<typeof vi.fn>,
  callIndex = -1,
): Record<string, unknown> {
  const calls = getChatMessagePostCalls(fetchMock);
  const target = calls.at(callIndex);
  if (target === undefined) {
    throw new Error(`No chat message POST at index ${callIndex}`);
  }
  const init = target[1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

function openChatSettings(container: HTMLElement) {
  const details = container.querySelector('.chat-panel-settings');
  if (details instanceof HTMLDetailsElement && !details.open) {
    const summary = details.querySelector('summary');
    if (summary !== null) {
      fireEvent.click(summary);
    }
  }
}

function renderChatPanel(
  projects: readonly ProjectDto[] = [PROJECT_A, PROJECT_B],
  options: {
    initialProjectId?: string;
    initialInput?: string;
    ticketContextToken?: number;
    onProjectIdChange?: (projectId: string) => void;
    leaveSettingsCollapsed?: boolean;
    isTicketOnBoard?: (ticketId: string) => boolean;
    onOpenTicket?: (ticketId: string) => void;
  } = {},
) {
  const onClose = vi.fn();
  const onOpenTicket = options.onOpenTicket ?? vi.fn();
  const isTicketOnBoard = options.isTicketOnBoard ?? (() => false);
  const rendered = render(
    <ChatPanel
      projects={projects}
      initialProjectId={options.initialProjectId}
      initialInput={options.initialInput}
      ticketContextToken={options.ticketContextToken}
      onProjectIdChange={options.onProjectIdChange}
      isTicketOnBoard={isTicketOnBoard}
      onOpenTicket={onOpenTicket}
      onClose={onClose}
    />,
  );
  if (!options.leaveSettingsCollapsed) {
    openChatSettings(rendered.container);
  }
  return { onClose, onOpenTicket, isTicketOnBoard, ...rendered };
}

describe('ChatPanel', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    installFakeHistory({});
    localStorage.clear();
    fetchChatAgentsMock.mockResolvedValue([]);
    fetchChatThreadsMock.mockResolvedValue([]);
    deleteChatThreadMock.mockResolvedValue();
    updateChatThreadMock.mockResolvedValue({
      sessionId: 'sess-1',
      agentId: 'claude',
      title: 'updated',
      pinned: false,
      updatedAt: '2026-01-01T00:00:00Z',
    });
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/chat/message' && init?.method === 'POST') {
        return jsonResponse({
          reply: 'AI reply',
          sessionId: 'sess-default',
          agentId: 'claude',
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: defaultWindowInnerWidth,
    });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('prefills the input with initialInput', () => {
    renderChatPanel([PROJECT_A], { initialInput: 'bdboard-abc.1 について: ' });

    expect(screen.getByLabelText('メッセージ')).toHaveValue(
      'bdboard-abc.1 について: ',
    );
  });

  it('has no a11y violations in the default loaded state', async () => {
    fetchChatAgentsMock.mockResolvedValue([CLAUDE_AGENT]);
    const { container } = renderChatPanel([PROJECT_A], {
      initialProjectId: 'proj-a',
    });

    await screen.findByLabelText('メッセージ');
    await expectNoA11yViolations(container);
  });

  it('resizes the desktop chat panel within bounds and remembers the width', () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1000,
    });
    const first = renderChatPanel([PROJECT_A]);
    const panel = first.container.querySelector('.detail-panel.chat-panel');
    const handle = screen.getByRole('separator', { name: 'チャットパネルの幅を変更' });

    expect(panel).toHaveStyle({ width: '480px' });

    fireEvent(handle, new MouseEvent('pointerdown', { bubbles: true, clientX: 0 }));
    expect(panel).toHaveStyle({ width: '680px' });
    fireEvent(handle, new MouseEvent('pointermove', { bubbles: true, clientX: 900 }));
    expect(panel).toHaveStyle({ width: '360px' });
    fireEvent(handle, new MouseEvent('pointerup', { bubbles: true }));
    expect(localStorage.getItem('bdboard.ui.chatPanelWidth')).toBe('360');

    first.unmount();
    const second = renderChatPanel([PROJECT_A]);
    expect(second.container.querySelector('.detail-panel.chat-panel')).toHaveStyle({
      width: '360px',
    });
  });

  it('supports keyboard resizing on desktop', () => {
    const { container } = renderChatPanel([PROJECT_A]);
    const panel = container.querySelector('.detail-panel.chat-panel');
    const handle = screen.getByRole('separator', { name: 'チャットパネルの幅を変更' });

    fireEvent.keyDown(handle, { key: 'ArrowLeft' });

    expect(panel).toHaveStyle({ width: '500px' });
  });

  it('resolves the initial project when projects arrive after a regular chat mount', async () => {
    const onProjectIdChange = vi.fn();
    const rendered = renderChatPanel([], {
      initialProjectId: 'proj-b',
      onProjectIdChange,
    });

    rendered.rerender(
      <ChatPanel
        projects={[PROJECT_A, PROJECT_B]}
        initialProjectId="proj-b"
        onProjectIdChange={onProjectIdChange}
        isTicketOnBoard={rendered.isTicketOnBoard}
        onOpenTicket={rendered.onOpenTicket}
        onClose={rendered.onClose}
      />,
    );

    await waitFor(() => {
      expect(fetchChatThreadsMock).toHaveBeenCalledWith('proj-b');
      expect(onProjectIdChange).toHaveBeenCalledWith('proj-b');
    });
  });

  it('moves draft input entered before projects arrive to the resolved project', async () => {
    const user = userEvent.setup();
    const rendered = renderChatPanel([], { initialProjectId: 'proj-b' });

    await user.type(screen.getByLabelText('メッセージ'), '書きかけのドラフト');
    rendered.rerender(
      <ChatPanel
        projects={[PROJECT_A, PROJECT_B]}
        initialProjectId="proj-b"
        isTicketOnBoard={rendered.isTicketOnBoard}
        onOpenTicket={rendered.onOpenTicket}
        onClose={rendered.onClose}
      />,
    );

    await waitFor(() => {
      expect(fetchChatThreadsMock).toHaveBeenCalledWith('proj-b');
      expect(screen.getByLabelText('メッセージ')).toHaveValue('書きかけのドラフト');
    });
  });

  it('moves draft input to the resolved project even when the draft nonce advanced during the cold window (M1 regression)', async () => {
    // M1 再現: projects 未解決(selectedProjectId==='')の間でも「新規スレッド」
    // ボタンは selectedProjectId!=='' でゲートされておらず startNewDraftThread('')
    // を呼べるため、draftNonces[''] が 0 から進み得る。移行元キーを
    // makeDraftKey('', 0) に固定していると、この後の入力(実際には new::1 に
    // 入る)を見逃してドラフトが消失する。
    const user = userEvent.setup();
    const rendered = renderChatPanel([], { initialProjectId: 'proj-b' });

    // projects 未解決のうちに「新規スレッド」を押して draftNonces[''] を 0→1 へ
    // 進める(この時点の空ドラフトは意図的に空のまま)。
    await user.click(screen.getByRole('button', { name: '新しい空のスレッドを開始' }));
    // 進んだ nonce のキー(new::1)へ実際に入力する。
    await user.type(screen.getByLabelText('メッセージ'), '進んだnonceでのドラフト');

    rendered.rerender(
      <ChatPanel
        projects={[PROJECT_A, PROJECT_B]}
        initialProjectId="proj-b"
        isTicketOnBoard={rendered.isTicketOnBoard}
        onOpenTicket={rendered.onOpenTicket}
        onClose={rendered.onClose}
      />,
    );

    await waitFor(() => {
      expect(fetchChatThreadsMock).toHaveBeenCalledWith('proj-b');
      expect(screen.getByLabelText('メッセージ')).toHaveValue('進んだnonceでのドラフト');
    });
  });

  it('keeps delayed ticket-context project resolution and prefill intact', async () => {
    const rendered = renderChatPanel([], {
      initialProjectId: 'proj-b',
      initialInput: 'proj-b のチケットについて: ',
      ticketContextToken: 1,
    });

    rendered.rerender(
      <ChatPanel
        projects={[PROJECT_A, PROJECT_B]}
        initialProjectId="proj-b"
        initialInput="proj-b のチケットについて: "
        ticketContextToken={1}
        isTicketOnBoard={rendered.isTicketOnBoard}
        onOpenTicket={rendered.onOpenTicket}
        onClose={rendered.onClose}
      />,
    );

    await waitFor(() => {
      expect(fetchChatThreadsMock).toHaveBeenCalledWith('proj-b');
      expect(screen.getByLabelText('メッセージ')).toHaveValue('proj-b のチケットについて: ');
    });
  });

  it('carries an edit made during the cold ticket-launch window (projects not yet arrived) into the resolved project draft instead of discarding it (104.17 regression)', async () => {
    // bdboard-3tw.104.17 再現: ticket 経路のコールドウィンドウ(projects 未到着 →
    // selectedProjectId==='' のまま)では initialInput が会話キー `new::0` に
    // シードされる。projects 解決後の会話キーは `new:proj-b:1` になるため、
    // startNewDraftThread の編集保持チェック(previousDraftKey)は同一
    // projectId 内(`new:proj-b:0` など)しか見ておらず、`new::0` は一致しない。
    // 修正前はここでユーザーの追記が無言で discard され、元のプリフィル文言に
    // 巻き戻っていた。
    const rendered = renderChatPanel([], {
      initialProjectId: 'proj-b',
      initialInput: 'proj-b のチケットについて: ',
      ticketContextToken: 1,
    });

    // マウント時点でコールドな `new::0` キーがチケットプリフィルでシードされて
    // いることを確認してから、projects 未到着のうちにユーザーがさらに書き足す。
    expect(screen.getByLabelText('メッセージ')).toHaveValue('proj-b のチケットについて: ');
    fireEvent.change(screen.getByLabelText('メッセージ'), {
      target: { value: 'proj-b のチケットについて: コールドウィンドウ中の追記' },
    });
    expect(screen.getByLabelText('メッセージ')).toHaveValue(
      'proj-b のチケットについて: コールドウィンドウ中の追記',
    );

    // projects が到着し、ticket-context effect が対象プロジェクトを解決する。
    rendered.rerender(
      <ChatPanel
        projects={[PROJECT_A, PROJECT_B]}
        initialProjectId="proj-b"
        initialInput="proj-b のチケットについて: "
        ticketContextToken={1}
        isTicketOnBoard={rendered.isTicketOnBoard}
        onOpenTicket={rendered.onOpenTicket}
        onClose={rendered.onClose}
      />,
    );

    await waitFor(() => {
      expect(fetchChatThreadsMock).toHaveBeenCalledWith('proj-b');
      // 解決後の会話キー(new:proj-b:1)にコールドウィンドウ中の追記が引き継がれ、
      // 元のプリフィル文言に巻き戻っていないこと。
      expect(screen.getByLabelText('メッセージ')).toHaveValue(
        'proj-b のチケットについて: コールドウィンドウ中の追記',
      );
    });
    expect(screen.getByLabelText('対象プロジェクト')).toHaveValue('proj-b');
  });

  it('carries a model selection made during the cold ticket-launch window (projects not yet arrived) into the resolved project draft instead of reverting to the agent default (104.18 regression)', async () => {
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([
      {
        ...CLAUDE_AGENT,
        model: 'sonnet',
        models: [
          { id: 'sonnet', label: 'Sonnet' },
          { id: 'opus', label: 'Opus' },
        ],
      },
    ]);

    const rendered = renderChatPanel([], {
      initialProjectId: 'proj-b',
      initialInput: 'proj-b のチケットについて: ',
      ticketContextToken: 1,
    });

    const modelSelect = await screen.findByLabelText('モデル');
    expect(modelSelect).toHaveValue('sonnet');
    await user.selectOptions(modelSelect, 'opus');
    expect(modelSelect).toHaveValue('opus');

    rendered.rerender(
      <ChatPanel
        projects={[PROJECT_A, PROJECT_B]}
        initialProjectId="proj-b"
        initialInput="proj-b のチケットについて: "
        ticketContextToken={1}
        isTicketOnBoard={rendered.isTicketOnBoard}
        onOpenTicket={rendered.onOpenTicket}
        onClose={rendered.onClose}
      />,
    );

    await waitFor(() => {
      expect(fetchChatThreadsMock).toHaveBeenCalledWith('proj-b');
      expect(screen.getByLabelText('モデル')).toHaveValue('opus');
    });
  });

  it('keeps a cold-window edit intact when the same ticket is opened again with a new context token (104.17 Opus review should-fix1 regression)', async () => {
    // 104.17 Opus レビュー should-fix1 再現: 上のテストで「コールドウィンドウ中の
    // 編集がプリフィルとして pendingPrefillRef に積まれ、解決後の会話キーへ適用
    // される」ところまでは正しく動くが、修正前の実装ではその適用時に
    // draftSeedTextRef へ「システムがシードした文言」として記録してしまって
    // いた(startNewDraftThread の `textToApply === prefillText` 分岐が無条件で
    // seed 記録する)。この状態でユーザーが送信する前に同じチケットをもう一度
    // 開く(=新しい ticketContextToken で ticket-context effect が再実行される)
    // と、SF1 判定は「draftSeedTextRef と現在値が一致する→未編集」と誤断し、
    // せっかく引き継いだユーザー編集を2回目のプリフィルで無言上書きしていた。
    const rendered = renderChatPanel([], {
      initialProjectId: 'proj-b',
      initialInput: '最初のプリフィル: ',
      ticketContextToken: 1,
    });

    expect(screen.getByLabelText('メッセージ')).toHaveValue('最初のプリフィル: ');
    fireEvent.change(screen.getByLabelText('メッセージ'), {
      target: { value: '最初のプリフィル: コールド編集' },
    });

    // projects が到着し、コールドウィンドウ中の編集が解決後の会話キーへ引き継がれる。
    rendered.rerender(
      <ChatPanel
        projects={[PROJECT_A, PROJECT_B]}
        initialProjectId="proj-b"
        initialInput="最初のプリフィル: "
        ticketContextToken={1}
        isTicketOnBoard={rendered.isTicketOnBoard}
        onOpenTicket={rendered.onOpenTicket}
        onClose={rendered.onClose}
      />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText('メッセージ')).toHaveValue('最初のプリフィル: コールド編集');
    });

    // ユーザーがまだ送信していないうちに、同じチケットをもう一度開く
    // (新しい ticketContextToken、initialInput は2回目の起動内容)。
    rendered.rerender(
      <ChatPanel
        projects={[PROJECT_A, PROJECT_B]}
        initialProjectId="proj-b"
        initialInput="2回目のプリフィル: "
        ticketContextToken={2}
        isTicketOnBoard={rendered.isTicketOnBoard}
        onOpenTicket={rendered.onOpenTicket}
        onClose={rendered.onClose}
      />,
    );

    // 引き継がれたユーザー編集は2回目のプリフィルに無言上書きされず残り続ける
    // (draftSeedTextRef へシード記録されていないことの間接的な確認)。
    await waitFor(() => {
      expect(screen.getByLabelText('メッセージ')).toHaveValue('最初のプリフィル: コールド編集');
    });
  });

  it('falls back to the first project when the ticket project is missing from the list (deadlock regression)', async () => {
    const rendered = renderChatPanel([], {
      initialProjectId: 'proj-missing',
      initialInput: 'proj-missing のチケットについて: ',
      ticketContextToken: 1,
    });

    rendered.rerender(
      <ChatPanel
        projects={[PROJECT_A, PROJECT_B]}
        initialProjectId="proj-missing"
        initialInput="proj-missing のチケットについて: "
        ticketContextToken={1}
        isTicketOnBoard={rendered.isTicketOnBoard}
        onOpenTicket={rendered.onOpenTicket}
        onClose={rendered.onClose}
      />,
    );

    await waitFor(() => {
      expect(fetchChatThreadsMock).toHaveBeenCalledWith(PROJECT_A.id);
    });
    expect(screen.getByLabelText('メッセージ')).toHaveValue('proj-missing のチケットについて: ');
  });

  it('shows a notice when the ticket project falls back to the first project', async () => {
    const rendered = renderChatPanel([], {
      initialProjectId: 'proj-missing',
      initialInput: 'proj-missing のチケットについて: ',
      ticketContextToken: 1,
    });

    rendered.rerender(
      <ChatPanel
        projects={[PROJECT_A, PROJECT_B]}
        initialProjectId="proj-missing"
        initialInput="proj-missing のチケットについて: "
        ticketContextToken={1}
        isTicketOnBoard={rendered.isTicketOnBoard}
        onOpenTicket={rendered.onOpenTicket}
        onClose={rendered.onClose}
      />,
    );

    await waitFor(() => {
      const notice = document.querySelector('.chat-ticket-project-fallback-notice');
      expect(notice).not.toBeNull();
      expect(notice).toHaveAttribute('role', 'status');
      expect(notice).toHaveTextContent('proj-missing');
      expect(notice).toHaveTextContent('見つからない');
      expect(notice).toHaveTextContent('Project Alpha');
      // S2: 送信先が fallback プロジェクトになる事実を明示する文言であることも
      // 固定する(単に「表示しています」という受動的な文言に戻る退行を防ぐ)。
      expect(notice).toHaveTextContent('送信されます');
    });
  });

  it('does not show a fallback notice when the ticket project exists', async () => {
    renderChatPanel([PROJECT_A, PROJECT_B], {
      initialProjectId: PROJECT_B.id,
      initialInput: 'proj-b のチケットについて: ',
      ticketContextToken: 1,
    });

    await waitFor(() => {
      expect(fetchChatThreadsMock).toHaveBeenCalledWith(PROJECT_B.id);
    });
    expect(document.querySelector('.chat-ticket-project-fallback-notice')).toBeNull();
  });

  it('keeps the already-resolved project instead of re-resolving to projects[0] when the ticket project is missing (S1a ablation)', async () => {
    // Opus レビュー S1: 「selectedProjectId がまだ '' のときだけ projects[0] へ
    // フォールバックする」という条件分岐が、ablation(条件を外す)で実際に
    // 挙動を変えることをテストで固定する。パネルが既に Project Beta を
    // 選択中の状態でチケットが存在しないプロジェクトを参照した場合、
    // projects[0](Project Alpha)への再解決は起きず、Project Beta に留まる
    // べき。
    const rendered = renderChatPanel([PROJECT_A, PROJECT_B], {
      initialProjectId: PROJECT_B.id,
    });

    await waitFor(() => {
      expect(fetchChatThreadsMock).toHaveBeenCalledWith(PROJECT_B.id);
    });
    fetchChatThreadsMock.mockClear();

    rendered.rerender(
      <ChatPanel
        projects={[PROJECT_A, PROJECT_B]}
        initialProjectId="proj-missing"
        initialInput="proj-missing のチケットについて: "
        ticketContextToken={1}
        isTicketOnBoard={rendered.isTicketOnBoard}
        onOpenTicket={rendered.onOpenTicket}
        onClose={rendered.onClose}
      />,
    );

    await waitFor(() => {
      const notice = document.querySelector('.chat-ticket-project-fallback-notice');
      expect(notice).not.toBeNull();
      expect(notice).toHaveTextContent('Project Beta');
    });
    expect(fetchChatThreadsMock).not.toHaveBeenCalledWith(PROJECT_A.id);
    expect(screen.getByLabelText('対象プロジェクト')).toHaveValue(PROJECT_B.id);
    expect(screen.getByLabelText('メッセージ')).toHaveValue('proj-missing のチケットについて: ');
  });

  it('clears the fallback notice when the project is switched manually (S1b ablation)', async () => {
    const user = userEvent.setup();
    const rendered = renderChatPanel([], {
      initialProjectId: 'proj-missing',
      initialInput: 'proj-missing のチケットについて: ',
      ticketContextToken: 1,
    });

    rendered.rerender(
      <ChatPanel
        projects={[PROJECT_A, PROJECT_B]}
        initialProjectId="proj-missing"
        initialInput="proj-missing のチケットについて: "
        ticketContextToken={1}
        isTicketOnBoard={rendered.isTicketOnBoard}
        onOpenTicket={rendered.onOpenTicket}
        onClose={rendered.onClose}
      />,
    );

    await waitFor(() => {
      expect(
        document.querySelector('.chat-ticket-project-fallback-notice'),
      ).not.toBeNull();
    });

    await user.selectOptions(screen.getByLabelText('対象プロジェクト'), 'proj-b');

    await waitFor(() => {
      expect(
        document.querySelector('.chat-ticket-project-fallback-notice'),
      ).toBeNull();
    });
  });

  it('updates the fallback notice once the missing ticket project becomes available later (S3)', async () => {
    const rendered = renderChatPanel([], {
      initialProjectId: 'proj-missing',
      initialInput: 'proj-missing のチケットについて: ',
      ticketContextToken: 1,
    });

    rendered.rerender(
      <ChatPanel
        projects={[PROJECT_A, PROJECT_B]}
        initialProjectId="proj-missing"
        initialInput="proj-missing のチケットについて: "
        ticketContextToken={1}
        isTicketOnBoard={rendered.isTicketOnBoard}
        onOpenTicket={rendered.onOpenTicket}
        onClose={rendered.onClose}
      />,
    );

    await waitFor(() => {
      expect(
        document.querySelector('.chat-ticket-project-fallback-notice'),
      ).toHaveTextContent('見つからない');
    });
    fetchChatThreadsMock.mockClear();

    const RECOVERED_PROJECT = makeProjectDto({
      id: 'proj-missing',
      name: 'Recovered Project',
    });
    rendered.rerender(
      <ChatPanel
        projects={[PROJECT_A, PROJECT_B, RECOVERED_PROJECT]}
        initialProjectId="proj-missing"
        initialInput="proj-missing のチケットについて: "
        ticketContextToken={1}
        isTicketOnBoard={rendered.isTicketOnBoard}
        onOpenTicket={rendered.onOpenTicket}
        onClose={rendered.onClose}
      />,
    );

    await waitFor(() => {
      const notice = document.querySelector('.chat-ticket-project-fallback-notice');
      expect(notice).not.toBeNull();
      expect(notice).toHaveTextContent('利用可能になりました');
      expect(notice).toHaveTextContent('Recovered Project');
    });
    // selectedProjectId は自動では切り替わらない(自動再解決/再fetchが起きない)。
    expect(fetchChatThreadsMock).not.toHaveBeenCalledWith('proj-missing');
    expect(screen.getByLabelText('対象プロジェクト')).toHaveValue(PROJECT_A.id);
  });

  it('opens a new draft when launched from a ticket with existing threads', async () => {
    fetchChatThreadsMock.mockResolvedValue([
      {
        sessionId: 'sess-existing',
        agentId: 'claude',
        title: '既存スレッド',
        pinned: false,
        updatedAt: '2026-01-02T00:00:00Z',
      },
    ]);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/chat/sessions/sess-existing/messages')) {
        return jsonResponse({
          sessionId: 'sess-existing',
          agentId: 'claude',
          messages: [{ role: 'user', content: '既存の履歴', createdAt: '2026-01-02T00:00:00Z' }],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    renderChatPanel([PROJECT_A], {
      initialProjectId: 'proj-a',
      initialInput: 'bdboard-x.1 について: ',
      ticketContextToken: 1,
    });

    expect(await screen.findByRole('tab', { name: '既存スレッド' })).toBeInTheDocument();
    expect(screen.queryByText('既存の履歴')).not.toBeInTheDocument();
    expect(screen.getByLabelText('メッセージ')).toHaveValue('bdboard-x.1 について: ');
  });

  it('keeps draft input independent from an existing thread and restores it', async () => {
    const user = userEvent.setup();
    fetchChatThreadsMock.mockResolvedValue([
      {
        sessionId: 'sess-existing',
        agentId: 'claude',
        title: '既存スレッド',
        pinned: false,
        updatedAt: '2026-01-02T00:00:00Z',
      },
    ]);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/chat/sessions/sess-existing/messages')) {
        return jsonResponse({ sessionId: 'sess-existing', agentId: 'claude', messages: [] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    renderChatPanel([PROJECT_A]);
    const existingTab = await screen.findByRole('tab', { name: '既存スレッド' });
    await user.click(screen.getByRole('button', { name: '新しい空のスレッドを開始' }));
    await user.type(screen.getByLabelText('メッセージ'), '書きかけのドラフト');
    await user.click(existingTab);
    expect(screen.getByLabelText('メッセージ')).toHaveValue('');

    await user.click(screen.getByRole('button', { name: 'スレッド「既存スレッド」を閉じる' }));
    expect(screen.getByLabelText('メッセージ')).toHaveValue('書きかけのドラフト');
  });

  it('clears only the submitted conversation input after a successful send', async () => {
    const user = userEvent.setup();
    fetchChatThreadsMock.mockResolvedValue([
      { sessionId: 'sess-first', agentId: 'claude', title: 'first thread', pinned: false, updatedAt: '2026-01-02T00:00:00Z' },
      { sessionId: 'sess-second', agentId: 'claude', title: 'second thread', pinned: false, updatedAt: '2026-01-01T00:00:00Z' },
    ]);
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/chat/sessions/')) {
        return jsonResponse({ sessionId: url.includes('sess-first') ? 'sess-first' : 'sess-second', agentId: 'claude', messages: [] });
      }
      if (url === '/api/chat/message' && init?.method === 'POST') {
        return jsonResponse({ reply: '送信成功', sessionId: 'sess-second', agentId: 'claude' });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A]);
    await screen.findByRole('tab', { name: 'first thread' });
    await user.type(screen.getByLabelText('メッセージ'), 'first draft');
    await user.click(screen.getByRole('tab', { name: 'second thread' }));
    await user.type(screen.getByLabelText('メッセージ'), 'second draft');
    await user.click(screen.getByRole('button', { name: '送信' }));

    await screen.findByText('送信成功');
    expect(screen.getByLabelText('メッセージ')).toHaveValue('');
    await user.click(screen.getByRole('tab', { name: 'first thread' }));
    expect(screen.getByLabelText('メッセージ')).toHaveValue('first draft');
  });

  it('keeps the draft input across an agent switch (MF1 regression)', async () => {
    // MF1 再現: エージェント切替は draftNonce を進めて会話キーを新しいドラフトへ
    // 強制的に切り替えるが、その瞬間まで入力欄にあった書きかけの本文は
    // ユーザーがまだ送信していない作業なので失われてはいけない。これが無いと
    // 今回の退行はすり抜ける。
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([CLAUDE_AGENT, EXAMPLE_AGENT]);

    renderChatPanel([PROJECT_A]);
    await screen.findByLabelText('チャットエージェント');
    await user.type(screen.getByLabelText('メッセージ'), '書きかけの本文');

    await user.selectOptions(
      screen.getByLabelText('チャットエージェント'),
      'example-agent',
    );

    expect(screen.getByLabelText('メッセージ')).toHaveValue('書きかけの本文');
  });

  it('clears the draft input after promotion to a session and does not resurrect it in a later fresh draft', async () => {
    // ドラフトから送信成功→sessionId スレッドへ昇格した後、入力欄が空である
    // ことに加え、昇格したスレッドを閉じて同じ nonce のドラフトキーへ戻っても
    // 送信済みの旧文言が復活しないことを確認する(未来キー予測の廃止で
    // 解消したクラスの孤児エントリ/resurrect 退行のガード)。
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/chat/message' && init?.method === 'POST') {
        return jsonResponse({ reply: 'reply', sessionId: 'sess-promoted', agentId: 'claude' });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A]);
    await user.type(screen.getByLabelText('メッセージ'), 'first message');
    await user.click(screen.getByRole('button', { name: '送信' }));
    await screen.findByText('reply');
    expect(screen.getByLabelText('メッセージ')).toHaveValue('');

    await user.click(
      screen.getByRole('button', { name: 'スレッド「first message」を閉じる' }),
    );
    expect(screen.getByLabelText('メッセージ')).toHaveValue('');
  });

  it('preserves existing conversation content after switching to a ticket draft', async () => {
    fetchChatThreadsMock.mockResolvedValue([
      {
        sessionId: 'sess-existing',
        agentId: 'claude',
        title: '既存スレッド',
        pinned: false,
        updatedAt: '2026-01-02T00:00:00Z',
      },
    ]);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/chat/sessions/sess-existing/messages')) {
        return jsonResponse({
          sessionId: 'sess-existing',
          agentId: 'claude',
          messages: [{ role: 'user', content: '保持される履歴', createdAt: '2026-01-02T00:00:00Z' }],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const rendered = renderChatPanel([PROJECT_A]);
    expect(await screen.findByText('保持される履歴')).toBeInTheDocument();
    rendered.rerender(
      <ChatPanel
        projects={[PROJECT_A]}
        initialProjectId="proj-a"
        initialInput="bdboard-x.1 について: "
        ticketContextToken={1}
        isTicketOnBoard={rendered.isTicketOnBoard}
        onOpenTicket={rendered.onOpenTicket}
        onClose={rendered.onClose}
      />,
    );

    expect(await screen.findByRole('tab', { name: '既存スレッド' })).toBeInTheDocument();
    expect(screen.queryByText('保持される履歴')).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('tab', { name: '既存スレッド' }));
    expect(await screen.findByText('保持される履歴')).toBeInTheDocument();
  });

  it('starts a fresh draft and replaces the input on each ticket context token', async () => {
    const user = userEvent.setup();
    fetchChatThreadsMock.mockResolvedValue([
      {
        sessionId: 'sess-existing',
        agentId: 'claude',
        title: '既存スレッド',
        pinned: false,
        updatedAt: '2026-01-02T00:00:00Z',
      },
    ]);
    const rendered = renderChatPanel([PROJECT_A], {
      initialProjectId: 'proj-a',
      initialInput: '最初のチケット: ',
      ticketContextToken: 1,
    });
    expect(await screen.findByRole('tab', { name: '既存スレッド' })).toBeInTheDocument();
    expect(screen.getByLabelText('メッセージ')).toHaveValue('最初のチケット: ');

    // N6: 1回目のドラフトから既存スレッドへ手動で切り替え、選択状態を作ってから
    // 2回目のチケット起動を投げる。これにより「2回目のトークンが既存スレッドの
    // 選択を確実に上書きする」ことを、単なる新規ドラフトの初期状態(元々
    // 未選択)ではなく、実際に選択済みだった状態からの遷移として検証できる。
    await user.click(screen.getByRole('tab', { name: '既存スレッド' }));
    expect(screen.getByRole('tab', { name: '既存スレッド' })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    rendered.rerender(
      <ChatPanel
        projects={[PROJECT_A]}
        initialProjectId="proj-a"
        initialInput="2回目のチケット: "
        ticketContextToken={2}
        isTicketOnBoard={rendered.isTicketOnBoard}
        onOpenTicket={rendered.onOpenTicket}
        onClose={rendered.onClose}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText('メッセージ')).toHaveValue('2回目のチケット: ');
    });
    // S3: 「既存の履歴」というテキストはこのテストのどの fetch モックからも
    // 返されないため、queryByText で不在を確認しても常に真になり回帰を検出
    // できない(恒真アサーション)。観測可能な差分として、既存スレッドタブが
    // 「選択されていない」(aria-selected=false, つまり新規ドラフトが選択中)
    // ことを直接確認する。
    expect(screen.getByRole('tab', { name: '既存スレッド' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  it('opens a fresh draft when crossing projects into an already-visited project (MF1 regression)', async () => {
    // MF1 再現: プロジェクトB を先に訪問して openThreadIds['proj-b'] を
    // 確定させたあと、プロジェクトA のチケットでチャットを開き、続けて
    // プロジェクトB のチケットでチャットを開く。修正前は「対象プロジェクトが
    // 訪問済み」という条件だけで即 startNewDraftThread を呼んでいたため、
    // setSelectedProjectId による B 向け fetch effect の再実行が後から
    // persisted/open[0](既存スレッド)で上書きし、プリフィルが既存スレッドの
    // 会話に合流してしまっていた。
    fetchChatThreadsMock.mockImplementation((projectId: string) =>
      Promise.resolve(
        projectId === 'proj-b'
          ? [
              {
                sessionId: 'sess-b-existing',
                agentId: 'claude',
                title: 'B既存スレッド',
                pinned: false,
                updatedAt: '2026-01-03T00:00:00Z',
              },
            ]
          : [],
      ),
    );
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/chat/sessions/sess-b-existing/messages')) {
        return jsonResponse({
          sessionId: 'sess-b-existing',
          agentId: 'claude',
          messages: [{ role: 'user', content: 'B既存の履歴', createdAt: '2026-01-03T00:00:00Z' }],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    // 1. まずプロジェクトB を普通に開いて訪問済みにする(ticketContext 無し)。
    const rendered = renderChatPanel([PROJECT_A, PROJECT_B], {
      initialProjectId: 'proj-b',
    });
    expect(await screen.findByRole('tab', { name: 'B既存スレッド' })).toBeInTheDocument();

    // 2. プロジェクトA のチケットでチャットを開く(トークン1)。
    rendered.rerender(
      <ChatPanel
        projects={[PROJECT_A, PROJECT_B]}
        initialProjectId="proj-a"
        initialInput="bdboard-a.1 について: "
        ticketContextToken={1}
        isTicketOnBoard={rendered.isTicketOnBoard}
        onOpenTicket={rendered.onOpenTicket}
        onClose={rendered.onClose}
      />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText('メッセージ')).toHaveValue('bdboard-a.1 について: ');
    });

    // 3. 続けてプロジェクトB(訪問済み)のチケットでチャットを開く(トークン2)。
    rendered.rerender(
      <ChatPanel
        projects={[PROJECT_A, PROJECT_B]}
        initialProjectId="proj-b"
        initialInput="bdboard-b.1 について: "
        ticketContextToken={2}
        isTicketOnBoard={rendered.isTicketOnBoard}
        onOpenTicket={rendered.onOpenTicket}
        onClose={rendered.onClose}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText('メッセージ')).toHaveValue('bdboard-b.1 について: ');
    });
    expect(await screen.findByRole('tab', { name: 'B既存スレッド' })).toBeInTheDocument();
    expect(screen.queryByText('B既存の履歴')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'B既存スレッド' })).toHaveAttribute(
        'aria-selected',
        'false',
      );
    });
  });

  it('does not leave a stray pending draft when a project is abandoned mid-fetch and later revisited normally (MF2 regression)', async () => {
    const user = userEvent.setup();
    const deferredB = createDeferred<ChatThreadDto[]>();
    let projectBCallCount = 0;
    fetchChatThreadsMock.mockImplementation((projectId: string) => {
      if (projectId === 'proj-a') {
        return Promise.resolve([]);
      }
      projectBCallCount += 1;
      if (projectBCallCount === 1) {
        // 1回目(チケット文脈起動によるもの)は in-flight のまま放置される。
        return deferredB.promise;
      }
      // 2回目(あとで自発的にプロジェクトBへ戻ったとき)は正常に解決する。
      return Promise.resolve([
        {
          sessionId: 'sess-b-existing',
          agentId: 'claude',
          title: 'B既存スレッド',
          pinned: false,
          updatedAt: '2026-01-03T00:00:00Z',
        },
      ]);
    });

    const rendered = renderChatPanel([PROJECT_A, PROJECT_B], {
      initialProjectId: 'proj-a',
    });
    await waitFor(() => {
      expect(fetchChatThreadsMock.mock.calls.some(([id]) => id === 'proj-a')).toBe(true);
    });

    // チケット文脈でプロジェクトB のチャットを開く → fetch が in-flight のまま。
    rendered.rerender(
      <ChatPanel
        projects={[PROJECT_A, PROJECT_B]}
        initialProjectId="proj-b"
        initialInput="bdboard-b.1 について: "
        ticketContextToken={1}
        isTicketOnBoard={rendered.isTicketOnBoard}
        onOpenTicket={rendered.onOpenTicket}
        onClose={rendered.onClose}
      />,
    );
    await waitFor(() => {
      expect(projectBCallCount).toBe(1);
    });

    // ユーザーが応答を待たずにプロジェクトA へ離脱する(in-flight fetch は cancel される)。
    await user.selectOptions(screen.getByLabelText('対象プロジェクト'), 'proj-a');

    // 放置されていた最初のB フェッチがようやく解決しても、離脱後は無視される。
    deferredB.resolve([]);

    // ユーザーが自発的にプロジェクトB へ戻る(ticketContext を介さない通常のナビゲーション)。
    await user.selectOptions(screen.getByLabelText('対象プロジェクト'), 'proj-b');

    const existingTab = await screen.findByRole('tab', { name: 'B既存スレッド' });
    await waitFor(() => {
      expect(existingTab).toHaveAttribute('aria-selected', 'true');
    });
  });

  it('carries a user edit made during the pending prefill window into the promoted draft instead of rolling it back (SF1 regression)', async () => {
    const deferred = createDeferred<ChatThreadDto[]>();
    fetchChatThreadsMock.mockImplementation(() => deferred.promise);

    renderChatPanel([PROJECT_A], {
      initialProjectId: 'proj-a',
      initialInput: 'bdboard-x.1 について: ',
      ticketContextToken: 1,
    });

    // マウント直後、nonce 0 のドラフトはチケットプリフィルでシードされている。
    expect(screen.getByLabelText('メッセージ')).toHaveValue('bdboard-x.1 について: ');

    // スレッド一覧 fetch が pending の窓の間に、ユーザーがさらに書き足す。
    // (user.type は既に非空の value を持つ textarea へのキャレット位置推定が
    // jsdom 上で不安定なため、onChange を直接駆動する fireEvent.change を使う。)
    fireEvent.change(screen.getByLabelText('メッセージ'), {
      target: { value: 'bdboard-x.1 について: 追記した本文' },
    });
    expect(screen.getByLabelText('メッセージ')).toHaveValue('bdboard-x.1 について: 追記した本文');

    // fetch が解決し、pendingTicketDraftProjectRef の消化が実際のドラフトキーを
    // 採番する。この消化で書きかけの追記が無言でプリフィルへ巻き戻ってはならない。
    deferred.resolve([]);

    await waitFor(() => {
      expect(screen.getByLabelText('メッセージ')).toHaveValue('bdboard-x.1 について: 追記した本文');
    });
  });

  it('lets an explicit new-thread click during the pending prefill window win over the ticket-context prefill (SF5 regression)', async () => {
    const user = userEvent.setup();
    const deferred = createDeferred<ChatThreadDto[]>();
    fetchChatThreadsMock.mockImplementation(() => deferred.promise);

    renderChatPanel([PROJECT_A], {
      initialProjectId: 'proj-a',
      initialInput: 'bdboard-x.1 について: ',
      ticketContextToken: 1,
    });
    expect(screen.getByLabelText('メッセージ')).toHaveValue('bdboard-x.1 について: ');

    // スレッド一覧 fetch がまだ pending(=保留中のプリフィルがまだ消化されていない)
    // うちに、ユーザーが自分で「新規スレッド」を押す。
    await user.click(screen.getByRole('button', { name: '新しい空のスレッドを開始' }));
    expect(screen.getByLabelText('メッセージ')).toHaveValue('');

    // 後から fetch が解決しても、消化済みのはずの pending なプリフィルが誤って
    // この手動ドラフトに混入したり、nonce が余分に進んでプリフィルがどこにも
    // 表示されなくなったりしない。
    deferred.resolve([]);
    await waitFor(() => {
      expect(fetchChatThreadsMock).toHaveBeenCalled();
    });
    expect(screen.getByLabelText('メッセージ')).toHaveValue('');
  });

  it('keeps a new draft selected when the thread-list fetch resolves with an existing thread after an explicit new-thread click (bdboard-ysu regression)', async () => {
    const user = userEvent.setup();
    const deferred = createDeferred<ChatThreadDto[]>();
    fetchChatThreadsMock.mockImplementation(() => deferred.promise);
    // SF4(Opus レビュー): messages: [] だと「既存の履歴が表示されていない」
    // アサーションが常に真になり空虚(履歴を読み込んでも読み込まなくても
    // 同じ結果)。実際に本文を持つ履歴を返し、「(タブが未選択/未読込のため)
    // 表示されていない」ことを実質的に検証する。
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/chat/sessions/sess-existing/messages')) {
        return jsonResponse({
          sessionId: 'sess-existing',
          agentId: 'claude',
          messages: [{ role: 'user', content: '既存の履歴', createdAt: '2026-01-02T00:00:00Z' }],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    // ticketContextToken 無し(通常のチャットを開いた場合)で、スレッド一覧
    // fetch が pending のうちにユーザーが「新規スレッド」を押す。
    renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });
    await user.click(screen.getByRole('button', { name: '新しい空のスレッドを開始' }));
    expect(screen.getByLabelText('メッセージ')).toHaveValue('');

    // fetch が既存スレッドを1件返して解決しても、fetch 開始前に無かった
    // (fetch中に新規作成された)ドラフトの選択を上書きしてはならない —
    // これを上書きすると本来存在した既存スレッドへ選択が巻き戻ってしまう
    // (bdboard-dpq 最終レビュー nit の回帰)。
    deferred.resolve([
      {
        sessionId: 'sess-existing',
        agentId: 'claude',
        title: '既存スレッド',
        pinned: false,
        updatedAt: '2026-01-02T00:00:00Z',
      },
    ]);

    const existingTab = await screen.findByRole('tab', { name: '既存スレッド' });
    await waitFor(() => {
      expect(existingTab).toHaveAttribute('aria-selected', 'false');
    });
    expect(screen.getByLabelText('メッセージ')).toHaveValue('');
    expect(screen.queryByText('既存の履歴')).not.toBeInTheDocument();
  });

  it('still restores the persisted/first existing thread when no explicit new draft was requested during a pending fetch (bdboard-ysu reverse case)', async () => {
    // N1(Opus レビュー): タイトルが「pending fetch の間」を謳っているのに
    // 即座に resolve するモックだと、その pending 窓の間は何もしない、という
    // このテストの実質的な主張を検証できていなかった。createDeferred で実際に
    // fetch を pending のまま保持し、「その間ユーザーは何もしない」→解決後に
    // persisted/open[0] の自動選択が働く、という形に直す。
    const deferred = createDeferred<ChatThreadDto[]>();
    fetchChatThreadsMock.mockImplementation(() => deferred.promise);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/chat/sessions/sess-existing/messages')) {
        return jsonResponse({ sessionId: 'sess-existing', agentId: 'claude', messages: [] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });

    // fetch が pending のうちはユーザーは何もしない(比較対象の regression
    // テストと違い、明示的な新規ドラフト操作が一切無い)。
    deferred.resolve([
      {
        sessionId: 'sess-existing',
        agentId: 'claude',
        title: '既存スレッド',
        pinned: false,
        updatedAt: '2026-01-02T00:00:00Z',
      },
    ]);

    const existingTab = await screen.findByRole('tab', { name: '既存スレッド' });
    await waitFor(() => {
      expect(existingTab).toHaveAttribute('aria-selected', 'true');
    });
  });

  it('keeps the post-switch draft selected when the thread-list fetch resolves with an existing thread after an agent switch (bdboard-ysu SF1 regression: handleAgentChange also advances draftNonces)', async () => {
    // Opus レビュー SF1: draftNonces を進めて selectedThreadIds[projectId] を
    // undefined にする経路は startNewDraftThread(「新規スレッド」ボタン)だけ
    // ではなく、handleAgentChange(エージェント切替)も同じことを直接行う。
    // どちらも「fetch pending 中にユーザーが明示的にドラフトへ切り替えた」の
    // 同種ケースなので、同じガードで保護されるべきことを確認する。
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([CLAUDE_AGENT, EXAMPLE_AGENT]);
    const deferred = createDeferred<ChatThreadDto[]>();
    fetchChatThreadsMock.mockImplementation(() => deferred.promise);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/chat/sessions/sess-existing/messages')) {
        return jsonResponse({
          sessionId: 'sess-existing',
          agentId: 'claude',
          messages: [{ role: 'user', content: '既存の履歴', createdAt: '2026-01-02T00:00:00Z' }],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });
    await screen.findByLabelText('チャットエージェント');

    // スレッド一覧 fetch が pending のうちに、エージェントを切り替える。
    await user.selectOptions(screen.getByLabelText('チャットエージェント'), 'example-agent');
    expect(screen.getByLabelText('メッセージ')).toHaveValue('');

    deferred.resolve([
      {
        sessionId: 'sess-existing',
        agentId: 'claude',
        title: '既存スレッド',
        pinned: false,
        updatedAt: '2026-01-02T00:00:00Z',
      },
    ]);

    const existingTab = await screen.findByRole('tab', { name: '既存スレッド' });
    await waitFor(() => {
      expect(existingTab).toHaveAttribute('aria-selected', 'false');
    });
    expect(screen.getByLabelText('メッセージ')).toHaveValue('');
    expect(screen.queryByText('既存の履歴')).not.toBeInTheDocument();
  });

  it('keeps a new draft selected when the thread-list fetch fails after an explicit new-thread click (bdboard-ysu SF3 regression: catch branch)', async () => {
    // Opus レビュー SF3: レビュアーの ablation で catch 側ガードのみを削除しても
    // 全テストが pass することを確認済み(=then 側のテストしか無かった)。
    // fetchChatThreads が失敗する経路でも同じ保護が効くことを確認する。
    const user = userEvent.setup();
    writePersistedChatThread('proj-a', { sessionId: 'sess-existing', agentId: 'claude' });
    const deferred = createDeferred<ChatThreadDto[]>();
    fetchChatThreadsMock.mockImplementation(() => deferred.promise);

    renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });
    await user.click(screen.getByRole('button', { name: '新しい空のスレッドを開始' }));
    expect(screen.getByLabelText('メッセージ')).toHaveValue('');

    deferred.reject(new Error('boom'));

    await waitFor(() => {
      expect(screen.getByText('スレッド一覧の取得に失敗しました。')).toBeInTheDocument();
    });
    const tab = screen.getByRole('tab', { name: '(無題)' });
    expect(tab).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByLabelText('メッセージ')).toHaveValue('');
  });

  it('keeps the cold-window draft selected when projects resolve and the thread-list fetch resolves with an existing thread (bdboard-ysu SF2 regression: cold-window nonce carry-over)', async () => {
    // Opus レビュー SF2(実測確認済みの症状): projects 未到着(selectedProjectId
    // === '')の間に「新規スレッド」を押すと nonce は '' キーへ積まれる。projects
    // 到着後の migration effect がこれを resolved 側の draftNonces へ引き継が
    // ないと、project-sync effect の fetch 開始時点のスナップショットは 0 のまま
    // となり、ガードをすり抜けて既存スレッドが選択されてしまう(チケットの症状
    // そのもの)。
    const user = userEvent.setup();
    const deferred = createDeferred<ChatThreadDto[]>();
    fetchChatThreadsMock.mockImplementation(() => deferred.promise);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/chat/sessions/sess-existing/messages')) {
        return jsonResponse({
          sessionId: 'sess-existing',
          agentId: 'claude',
          messages: [{ role: 'user', content: '既存の履歴', createdAt: '2026-01-02T00:00:00Z' }],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    // projects が遅延到着する(=プロジェクト未解決のコールドウィンドウ)。
    const rendered = renderChatPanel([], { initialProjectId: 'proj-a' });

    // コールド中に「新規スレッド」を押す(draftNonces[''] が 0→1 へ進む)。
    await user.click(screen.getByRole('button', { name: '新しい空のスレッドを開始' }));
    expect(screen.getByLabelText('メッセージ')).toHaveValue('');

    // ここで projects が到着し、selectedProjectId が 'proj-a' へ解決される。
    rendered.rerender(
      <ChatPanel
        projects={[PROJECT_A]}
        initialProjectId="proj-a"
        isTicketOnBoard={rendered.isTicketOnBoard}
        onOpenTicket={rendered.onOpenTicket}
        onClose={rendered.onClose}
      />,
    );

    await waitFor(() => {
      expect(fetchChatThreadsMock).toHaveBeenCalledWith('proj-a');
    });

    // 到着後の(まだ pending だった)fetch が既存スレッド1件で解決しても、
    // コールド中に作られたドラフトの選択を上書きしてはならない。
    deferred.resolve([
      {
        sessionId: 'sess-existing',
        agentId: 'claude',
        title: '既存スレッド',
        pinned: false,
        updatedAt: '2026-01-02T00:00:00Z',
      },
    ]);

    const existingTab = await screen.findByRole('tab', { name: '既存スレッド' });
    await waitFor(() => {
      expect(existingTab).toHaveAttribute('aria-selected', 'false');
    });
    expect(screen.getByLabelText('メッセージ')).toHaveValue('');
    expect(screen.queryByText('既存の履歴')).not.toBeInTheDocument();
  });

  it('keeps a draft selected after leaving and revisiting its project, even though the earlier fetch already resolved (bdboard-ysu sticky-guard regression)', async () => {
    // Opus 再レビュー最終追補: 「fetch の in-flight 窓の間だけ」ではなく、
    // ドラフトを見ている間はプロジェクトを離れて戻ってきても自動選択で
    // 引き剥がされない、という持続条件であることを固定する(base との
    // user-visible な挙動差分、レビュアー実測)。プロジェクトA でドラフトを
    // 作成 → スレッドを選び直さないまま B へ切替 → A に戻る(再 fetch が
    // 既存スレッドを返す)→ ドラフトが維持される。
    const user = userEvent.setup();
    fetchChatThreadsMock.mockImplementation((projectId: string) => {
      if (projectId === 'proj-a') {
        return Promise.resolve([
          {
            sessionId: 'sess-existing',
            agentId: 'claude',
            title: '既存スレッド',
            pinned: false,
            updatedAt: '2026-01-02T00:00:00Z',
          },
        ]);
      }
      return Promise.resolve([]);
    });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/chat/sessions/sess-existing/messages')) {
        return jsonResponse({
          sessionId: 'sess-existing',
          agentId: 'claude',
          messages: [{ role: 'user', content: '既存の履歴', createdAt: '2026-01-02T00:00:00Z' }],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    renderChatPanel([PROJECT_A, PROJECT_B], { initialProjectId: 'proj-a' });

    // A の最初の fetch が(既存スレッドで)解決してから、明示的に「新規
    // スレッド」を押す — in-flight 中ではなく、既に fetch が片付いた後の
    // 明示操作であることが sticky 判定を確認するうえで重要。
    await screen.findByRole('tab', { name: '既存スレッド' });
    await user.click(screen.getByRole('button', { name: '新しい空のスレッドを開始' }));
    expect(screen.getByLabelText('メッセージ')).toHaveValue('');

    // スレッドを選び直さないまま B へ離脱する。
    await user.selectOptions(screen.getByLabelText('対象プロジェクト'), 'proj-b');

    // A へ戻る → 新しい fetch(A) が発火し、既存スレッドで解決する。
    await user.selectOptions(screen.getByLabelText('対象プロジェクト'), 'proj-a');

    const existingTab = await screen.findByRole('tab', { name: '既存スレッド' });
    await waitFor(() => {
      expect(existingTab).toHaveAttribute('aria-selected', 'false');
    });
    expect(screen.getByLabelText('メッセージ')).toHaveValue('');
    expect(screen.queryByText('既存の履歴')).not.toBeInTheDocument();
  });

  it('still applies a later ticket prefill after an unedited agent switch in between (SFX regression)', async () => {
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([CLAUDE_AGENT, EXAMPLE_AGENT]);
    fetchChatThreadsMock.mockResolvedValue([]);

    const rendered = renderChatPanel([PROJECT_A], {
      initialProjectId: 'proj-a',
      initialInput: 'チケットA について: ',
      ticketContextToken: 1,
    });
    await screen.findByLabelText('チャットエージェント');
    await waitFor(() => {
      expect(screen.getByLabelText('メッセージ')).toHaveValue('チケットA について: ');
    });

    // シードされた文言を一切編集しないままエージェントを切り替える。
    // handleAgentChange は draftSeedTextRef の記録も値と一緒にコピーする義務を
    // 負う(SFX) — これを怠ると、次のチケット起動時に新キーの「シード記録が無い」
    // ため無条件で「編集済み」と誤判定され、A の文言が居座って B のプリフィルが
    // 適用されなくなる。
    await user.selectOptions(screen.getByLabelText('チャットエージェント'), 'example-agent');
    expect(screen.getByLabelText('メッセージ')).toHaveValue('チケットA について: ');

    // 続けて別チケット(B)でチャットを開く(同一プロジェクト)。
    rendered.rerender(
      <ChatPanel
        projects={[PROJECT_A]}
        initialProjectId="proj-a"
        initialInput="チケットB について: "
        ticketContextToken={2}
        isTicketOnBoard={rendered.isTicketOnBoard}
        onOpenTicket={rendered.onOpenTicket}
        onClose={rendered.onClose}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText('メッセージ')).toHaveValue('チケットB について: ');
    });
  });

  it('opens a fresh draft on the very first mount even under StrictMode double-invocation (MF3 regression)', async () => {
    // MF3 再現:「パネルを閉じた状態からチケットチャットを開く」という主経路
    // (App.tsx は chatOpen が false→true になるたびに ChatPanel を新規マウント
    // し、ticketContextToken は既に確定した値で渡す)を StrictMode 下で検証する。
    // main.tsx(web/src/main.tsx:34)は実際に StrictMode でレンダーしているため、
    // 開発時のダブル実行(mount→destroy→mount)は本番の初回起動でも発生する。
    // 修正前(pending クリアが cleanup 側にあった実装)では、この擬似アン
    // マウントを「別プロジェクトへ離脱した」と誤認して pending 意図を消して
    // しまい、mount#2 で再実行された fetch の解決時に既存スレッドが選択されて
    // しまっていた(このテストは新 HEAD で FAIL、修正適用後の HEAD で PASS
    // することをレビュアーが確認済み)。
    fetchChatThreadsMock.mockResolvedValue([
      {
        sessionId: 'sess-existing',
        agentId: 'claude',
        title: '既存スレッド',
        pinned: false,
        updatedAt: '2026-01-02T00:00:00Z',
      },
    ]);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/chat/sessions/sess-existing/messages')) {
        return jsonResponse({
          sessionId: 'sess-existing',
          agentId: 'claude',
          messages: [{ role: 'user', content: '既存の履歴', createdAt: '2026-01-02T00:00:00Z' }],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const view = render(
      <StrictMode>
        <ChatPanel
          projects={[PROJECT_A]}
          initialProjectId="proj-a"
          initialInput="bdboard-x.1 について: "
          ticketContextToken={1}
          isTicketOnBoard={() => false}
          onOpenTicket={vi.fn()}
          onClose={vi.fn()}
        />
      </StrictMode>,
    );
    openChatSettings(view.container);

    expect(await screen.findByRole('tab', { name: '既存スレッド' })).toBeInTheDocument();
    expect(screen.getByLabelText('メッセージ')).toHaveValue('bdboard-x.1 について: ');
    expect(screen.queryByText('既存の履歴')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: '既存スレッド' })).toHaveAttribute(
        'aria-selected',
        'false',
      );
    });
  });

  it('opens the CLI session discovery panel', async () => {
    const user = userEvent.setup();
    fetchDiscoveredChatSessionsMock.mockResolvedValue({ sessions: [] });
    renderChatPanel([PROJECT_A]);

    await user.click(screen.getByRole('button', { name: 'CLIセッションを再開' }));
    expect(await screen.findByText('再開できるCLIセッションはありません。')).toBeInTheDocument();
    expect(fetchDiscoveredChatSessionsMock).toHaveBeenCalledWith('proj-a');
  });

  it('sends the first message without sessionId and shows the reply', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/chat/message' && init?.method === 'POST') {
        return jsonResponse({
          reply: 'Hello from AI',
          sessionId: 'sess-1',
          agentId: 'claude',
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A]);
    await user.type(screen.getByLabelText('メッセージ'), 'first message');
    await user.click(screen.getByRole('button', { name: '送信' }));

    await waitFor(() => {
      expect(getChatMessagePostCalls(fetchMock)).toHaveLength(1);
    });

    const body = parseChatMessageBody(fetchMock);
    expect(body).toEqual({
      projectId: 'proj-a',
      message: 'first message',
    });
    expect(body).not.toHaveProperty('sessionId');
    expect(await screen.findByText('Hello from AI')).toBeInTheDocument();
  });

  it('posts to the streaming endpoint and shows the completed streamed reply', async () => {
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
    // bdboard-l1t.9 Opus レビュー S7: 最終結果(applyChatSuccess後の表示)だけを見ると
    // onDelta が no-op でも通ってしまう。第1delta到着後・done到着前の途中経過を
    // 明示的に観測できるよう、続きの chunk 送出をテスト側から制御できるゲートを挟む。
    let releaseRemainingChunks: () => void = () => {};
    const remainingChunksGate = new Promise<void>((resolve) => {
      releaseRemainingChunks = resolve;
    });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/chat/message/stream' && init?.method === 'POST') {
        return new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(
                new TextEncoder().encode('event: delta\ndata: {"text":"streamed "}\n\n'),
              );
              await remainingChunksGate;
              controller.enqueue(
                new TextEncoder().encode('event: delta\ndata: {"text":"reply"}\n\n'),
              );
              await Promise.resolve();
              controller.enqueue(
                new TextEncoder().encode(
                  'event: done\ndata: {"reply":"streamed reply","sessionId":"sess-stream","agentId":"claude"}\n\n',
                ),
              );
              controller.close();
            },
          }),
        );
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A]);
    await screen.findByLabelText('チャットエージェント');
    await user.type(screen.getByLabelText('メッセージ'), 'stream this');
    await user.click(screen.getByRole('button', { name: '送信' }));

    const messages = screen.getByRole('log');
    // 第1delta到着後・done到着前: onDelta が実際にストリーミング吹き出しへ
    // 部分テキストを反映していることを確認する(ここが no-op だと絶対に通らない)。
    await waitFor(() => {
      const streamingText = messages.querySelector('.chat-message-streaming .chat-message-text');
      expect(streamingText).not.toBeNull();
      expect(streamingText?.textContent).toBe('streamed ');
    });

    releaseRemainingChunks();

    await waitFor(() => {
      expect(within(messages).getByText('streamed reply')).toBeInTheDocument();
    });
    expect(messages.querySelector('.chat-message-streaming')).toBeNull();
    expect(
      fetchMock.mock.calls.filter(
        ([url, request]) =>
          url === '/api/chat/message/stream' &&
          (request as RequestInit | undefined)?.method === 'POST',
      ),
    ).toHaveLength(1);
    expect(getChatMessagePostCalls(fetchMock)).toHaveLength(0);
  });

  it('posts to the non-streaming endpoint for a non-streaming agent', async () => {
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([CLAUDE_AGENT]);

    renderChatPanel([PROJECT_A]);
    await screen.findByLabelText('チャットエージェント');
    await user.type(screen.getByLabelText('メッセージ'), 'regular chat');
    await user.click(screen.getByRole('button', { name: '送信' }));

    await waitFor(() => {
      expect(within(screen.getByRole('log')).getByText('AI reply')).toBeInTheDocument();
    });
    expect(getChatMessagePostCalls(fetchMock)).toHaveLength(1);
    expect(
      fetchMock.mock.calls.some(([url, request]) =>
        url === '/api/chat/message/stream' &&
        (request as RequestInit | undefined)?.method === 'POST',
      ),
    ).toBe(false);
  });

  it('shows the stream error and clears the partial streaming reply', async () => {
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
    // bdboard-l1t.9 Opus レビュー S7: エラー発生前にストリーミング吹き出しが実際に
    // 表示されていたことを確認できるよう、error chunk の送出をテスト側から
    // 制御できるゲートを挟む(同期的に一気に enqueue すると途中経過を
    // 観測できないまま最終状態だけを見てしまう)。
    let releaseErrorChunk: () => void = () => {};
    const errorChunkGate = new Promise<void>((resolve) => {
      releaseErrorChunk = resolve;
    });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/chat/message/stream' && init?.method === 'POST') {
        return new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(
                new TextEncoder().encode('event: delta\ndata: {"text":"partial"}\n\n'),
              );
              await errorChunkGate;
              controller.enqueue(
                new TextEncoder().encode(
                  'event: error\ndata: {"error":"chat failed","code":"agent-error","detail":"safe detail"}\n\n',
                ),
              );
              controller.close();
            },
          }),
        );
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A]);
    await screen.findByLabelText('チャットエージェント');
    await user.type(screen.getByLabelText('メッセージ'), 'fail this stream');
    await user.click(screen.getByRole('button', { name: '送信' }));

    const messages = screen.getByRole('log');
    // エラー到着前: ストリーミング吹き出しが部分テキストとともに実在したことを確認する。
    await waitFor(() => {
      const streamingText = messages.querySelector('.chat-message-streaming .chat-message-text');
      expect(streamingText).not.toBeNull();
      expect(streamingText?.textContent).toBe('partial');
    });

    releaseErrorChunk();

    await waitFor(() => {
      const errorMessage = within(messages).getByText('chat failed');
      expect(errorMessage).toHaveClass('chat-message-text');
      expect(errorMessage.closest('.chat-message')).toHaveClass('chat-message-error');
      expect(messages.querySelector('.chat-message-streaming')).toBeNull();
    });
  });

  describe('streaming abort on unmount / conversation switch (bdboard-7st)', () => {
    function makeGatedStreamingFetchMock(
      fetchMock: ReturnType<typeof vi.fn>,
      options: { capturedSignal?: { current: AbortSignal | undefined } } = {},
    ) {
      let releaseRemainingChunks: () => void = () => {};
      const remainingChunksGate = new Promise<void>((resolve) => {
        releaseRemainingChunks = resolve;
      });
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === '/api/chat/message/stream' && init?.method === 'POST') {
          if (options.capturedSignal !== undefined) {
            options.capturedSignal.current = init.signal ?? undefined;
          }
          return new Response(
            new ReadableStream({
              async start(controller) {
                controller.enqueue(
                  new TextEncoder().encode('event: delta\ndata: {"text":"partial "}\n\n'),
                );
                init.signal?.addEventListener('abort', () => {
                  controller.error(
                    new DOMException('The operation was aborted.', 'AbortError'),
                  );
                });
                await remainingChunksGate;
                controller.enqueue(
                  new TextEncoder().encode(
                    'event: done\ndata: {"reply":"partial reply","sessionId":"sess-stream","agentId":"claude"}\n\n',
                  ),
                );
                controller.close();
              },
            }),
          );
        }
        throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
      });
      return { releaseRemainingChunks };
    }

    it('aborts the fetch signal on unmount while streaming', async () => {
      const user = userEvent.setup();
      fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
      const capturedSignal: { current: AbortSignal | undefined } = { current: undefined };
      makeGatedStreamingFetchMock(fetchMock, { capturedSignal });

      const view = renderChatPanel([PROJECT_A]);
      await screen.findByLabelText('チャットエージェント');
      await user.type(screen.getByLabelText('メッセージ'), 'stream then unmount');
      await user.click(screen.getByRole('button', { name: '送信' }));

      const messages = screen.getByRole('log');
      await waitFor(() => {
        const streamingText = messages.querySelector('.chat-message-streaming .chat-message-text');
        expect(streamingText).not.toBeNull();
        expect(streamingText?.textContent).toBe('partial ');
      });
      expect(capturedSignal.current).toBeDefined();

      view.unmount();
      await waitFor(() => {
        expect(capturedSignal.current?.aborted).toBe(true);
      });
    });

    it('aborts the fetch signal when switching threads while streaming', async () => {
      const user = userEvent.setup();
      fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
      fetchChatThreadsMock.mockResolvedValue([
        {
          sessionId: 'sess-1',
          agentId: 'claude',
          title: 'first thread',
          pinned: false,
          updatedAt: '2026-01-02T00:00:00Z',
        },
        {
          sessionId: 'sess-2',
          agentId: 'claude',
          title: 'second thread',
          pinned: false,
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ]);
      const capturedSignal: { current: AbortSignal | undefined } = { current: undefined };
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes('/api/chat/sessions/sess-1/messages')) {
          return jsonResponse({ sessionId: 'sess-1', agentId: 'claude', messages: [] });
        }
        if (url.includes('/api/chat/sessions/sess-2/messages')) {
          return jsonResponse({ sessionId: 'sess-2', agentId: 'claude', messages: [] });
        }
        if (url === '/api/chat/message/stream' && init?.method === 'POST') {
          capturedSignal.current = init.signal ?? undefined;
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode('event: delta\ndata: {"text":"partial "}\n\n'),
                );
                init.signal?.addEventListener('abort', () => {
                  controller.error(
                    new DOMException('The operation was aborted.', 'AbortError'),
                  );
                });
              },
            }),
          );
        }
        throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
      });

      renderChatPanel([PROJECT_A]);
      expect(await screen.findByRole('tab', { name: 'first thread' })).toBeInTheDocument();

      await user.type(screen.getByLabelText('メッセージ'), 'message for first');
      await user.click(screen.getByRole('button', { name: '送信' }));

      const messages = screen.getByRole('log');
      await waitFor(() => {
        expect(messages.querySelector('.chat-message-streaming')).not.toBeNull();
      });
      expect(capturedSignal.current).toBeDefined();

      await user.click(screen.getByRole('tab', { name: 'second thread' }));

      await waitFor(() => {
        expect(capturedSignal.current?.aborted).toBe(true);
      });
      expect(messages.querySelector('.chat-message-streaming')).toBeNull();
    });

    it('aborts the fetch signal when switching projects while streaming', async () => {
      const user = userEvent.setup();
      fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
      const capturedSignal: { current: AbortSignal | undefined } = { current: undefined };
      makeGatedStreamingFetchMock(fetchMock, { capturedSignal });

      const rendered = renderChatPanel([PROJECT_A, PROJECT_B], {
        initialProjectId: 'proj-a',
        ticketContextToken: 1,
      });
      await screen.findByLabelText('チャットエージェント');
      await user.type(screen.getByLabelText('メッセージ'), 'project switch abort');
      await user.click(screen.getByRole('button', { name: '送信' }));

      const messages = screen.getByRole('log');
      await waitFor(() => {
        expect(messages.querySelector('.chat-message-streaming')).not.toBeNull();
      });
      expect(capturedSignal.current).toBeDefined();

      rendered.rerender(
        <ChatPanel
          projects={[PROJECT_A, PROJECT_B]}
          initialProjectId="proj-b"
          ticketContextToken={2}
          isTicketOnBoard={rendered.isTicketOnBoard}
          onOpenTicket={rendered.onOpenTicket}
          onClose={rendered.onClose}
        />,
      );

      await waitFor(() => {
        expect(capturedSignal.current?.aborted).toBe(true);
      });
      expect(screen.getByRole('log').querySelector('.chat-message-streaming')).toBeNull();
    });

    it('does not add an error bubble when abort comes from a thread switch', async () => {
      const user = userEvent.setup();
      fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
      fetchChatThreadsMock.mockResolvedValue([
        {
          sessionId: 'sess-1',
          agentId: 'claude',
          title: 'first thread',
          pinned: false,
          updatedAt: '2026-01-02T00:00:00Z',
        },
        {
          sessionId: 'sess-2',
          agentId: 'claude',
          title: 'second thread',
          pinned: false,
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ]);
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes('/api/chat/sessions/sess-1/messages')) {
          return jsonResponse({ sessionId: 'sess-1', agentId: 'claude', messages: [] });
        }
        if (url.includes('/api/chat/sessions/sess-2/messages')) {
          return jsonResponse({ sessionId: 'sess-2', agentId: 'claude', messages: [] });
        }
        if (url === '/api/chat/message/stream' && init?.method === 'POST') {
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode('event: delta\ndata: {"text":"partial "}\n\n'),
                );
                init.signal?.addEventListener('abort', () => {
                  controller.error(
                    new DOMException('The operation was aborted.', 'AbortError'),
                  );
                });
              },
            }),
          );
        }
        throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
      });

      renderChatPanel([PROJECT_A]);
      expect(await screen.findByRole('tab', { name: 'first thread' })).toBeInTheDocument();

      await user.type(screen.getByLabelText('メッセージ'), 'abort without error bubble');
      await user.click(screen.getByRole('button', { name: '送信' }));

      await waitFor(() => {
        expect(screen.getByRole('log').querySelector('.chat-message-streaming')).not.toBeNull();
      });

      await user.click(screen.getByRole('tab', { name: 'second thread' }));
      await waitFor(() => {
        expect(screen.getByRole('log').querySelector('.chat-message-streaming')).toBeNull();
      });

      await user.click(screen.getByRole('tab', { name: 'first thread' }));
      const firstThreadMessages = screen.getByRole('log');
      await waitFor(() => {
        expect(within(firstThreadMessages).getByText('abort without error bubble')).toBeInTheDocument();
      });
      expect(firstThreadMessages.querySelectorAll('.chat-message-error')).toHaveLength(0);
      expect(firstThreadMessages.querySelector('.chat-message-streaming')).toBeNull();
    });
  });

  // bdboard-otf(bdboard-dpq レビュー N2 フォローアップ): 送信失敗時に入力欄へ本文を
  // 復元する回帰テスト群。
  describe('restores the input after a send failure (bdboard-otf)', () => {
    it('restores the draft after a non-streaming send failure', async () => {
      const user = userEvent.setup();
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === '/api/chat/message' && init?.method === 'POST') {
          return jsonResponse({ error: 'boom' }, 500);
        }
        throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
      });

      renderChatPanel([PROJECT_A]);
      const input = screen.getByLabelText('メッセージ');
      await user.type(input, 'failed batch message');
      await user.click(screen.getByRole('button', { name: '送信' }));

      await screen.findByText('boom');
      await waitFor(() => {
        expect(screen.getByLabelText('メッセージ')).toHaveValue('failed batch message');
      });
    });

    it('restores the draft after a streaming send failure, including a failure after partial deltas', async () => {
      const user = userEvent.setup();
      fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
      // bdboard-otf Opus レビュー N6: タイトルの「partial deltas 受信後」を
      // テスト自身に確認させる。同期的に一気に enqueue すると、delta が実際に
      // 描画された事実を観測できないまま最終状態だけを見てしまう(l1t.9 の
      // 既存ストリーミングエラーテストと同じゲートパターン)。
      let releaseErrorChunk: () => void = () => {};
      const errorChunkGate = new Promise<void>((resolve) => {
        releaseErrorChunk = resolve;
      });
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === '/api/chat/message/stream' && init?.method === 'POST') {
          return new Response(
            new ReadableStream({
              async start(controller) {
                controller.enqueue(
                  new TextEncoder().encode('event: delta\ndata: {"text":"partial"}\n\n'),
                );
                await errorChunkGate;
                controller.enqueue(
                  new TextEncoder().encode(
                    'event: error\ndata: {"error":"stream boom","code":"agent-error"}\n\n',
                  ),
                );
                controller.close();
              },
            }),
          );
        }
        throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
      });

      renderChatPanel([PROJECT_A]);
      await screen.findByLabelText('チャットエージェント');
      const input = screen.getByLabelText('メッセージ');
      await user.type(input, 'failed stream message');
      await user.click(screen.getByRole('button', { name: '送信' }));

      const messages = screen.getByRole('log');
      // エラー到着前: ストリーミング吹き出しが部分テキストとともに実在した
      // ことを確認する(N6、これが無いとタイトルの主張が未検証のまま)。
      await waitFor(() => {
        const streamingText = messages.querySelector('.chat-message-streaming .chat-message-text');
        expect(streamingText).not.toBeNull();
        expect(streamingText?.textContent).toBe('partial');
      });

      releaseErrorChunk();

      await screen.findByText('stream boom');
      // ストリーミング途中(delta 受信後)の失敗でも、部分応答の破棄(既存挙動)とは
      // 独立に、ユーザーが送った本文は入力欄へ復元される。
      await waitFor(() => {
        expect(screen.getByLabelText('メッセージ')).toHaveValue('failed stream message');
      });
      expect(messages.querySelector('.chat-message-streaming')).toBeNull();
    });

    it('does not overwrite a draft the user typed into the same key after the send started', async () => {
      const user = userEvent.setup();
      const deferred = createDeferred<Response>();
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === '/api/chat/message' && init?.method === 'POST') {
          return deferred.promise;
        }
        throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
      });

      renderChatPanel([PROJECT_A]);
      const input = screen.getByLabelText('メッセージ');
      await user.type(input, 'original message');
      await user.click(screen.getByRole('button', { name: '送信' }));

      // 送信中は入力欄が disabled になり、同じ会話キーへの直接入力はできない
      // (this repository's UI invariant)。一方でこのキーに新しい下書きが
      // React state 経由で既に入っていた場合(例: プログラム的な書き込み)、
      // 失敗時の復元がそれを上書きしてはいけない、という不変条件を検証する
      // ため、conversationInputs の書き込み経路である onChange を disabled でも
      // 確実に模す代わりに、fireEvent で直接 change イベントを発火させる。
      expect(input).toBeDisabled();
      fireEvent.change(input, { target: { value: 'a newer draft typed meanwhile' } });

      deferred.resolve(jsonResponse({ error: 'boom' }, 500));

      await screen.findByText('boom');
      await waitFor(() => {
        expect(screen.getByLabelText('メッセージ')).toHaveValue('a newer draft typed meanwhile');
      });
    });

    it('restores the draft into the original conversation key, not the one currently visible, when the user switched threads while the send was pending', async () => {
      const user = userEvent.setup();
      fetchChatThreadsMock.mockResolvedValue([
        { sessionId: 'sess-1', agentId: 'claude', title: 'first thread', pinned: false, updatedAt: '2026-01-02T00:00:00Z' },
        { sessionId: 'sess-2', agentId: 'claude', title: 'second thread', pinned: false, updatedAt: '2026-01-01T00:00:00Z' },
      ]);
      const deferred = createDeferred<Response>();
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes('/api/chat/sessions/sess-1/messages')) {
          return jsonResponse({ sessionId: 'sess-1', agentId: 'claude', messages: [] });
        }
        if (url.includes('/api/chat/sessions/sess-2/messages')) {
          return jsonResponse({ sessionId: 'sess-2', agentId: 'claude', messages: [] });
        }
        if (url === '/api/chat/message' && init?.method === 'POST') {
          return deferred.promise;
        }
        throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
      });

      renderChatPanel([PROJECT_A]);
      expect(await screen.findByRole('tab', { name: 'first thread' })).toBeInTheDocument();

      const input = screen.getByLabelText('メッセージ');
      await user.type(input, 'message for the first thread');
      await user.click(screen.getByRole('button', { name: '送信' }));

      // 送信中でもスレッドタブの切り替え自体は disabled になっていないため、
      // ユーザーは送信の完了を待たずに別スレッドへ切り替えられる。
      await user.click(screen.getByRole('tab', { name: 'second thread' }));
      // 現在表示中(second thread)の入力欄は、まだ何も打っていないので空のまま。
      expect(screen.getByLabelText('メッセージ')).toHaveValue('');

      deferred.resolve(jsonResponse({ error: 'boom' }, 500));
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalled();
      });

      // 復元は送信時点のキー(first thread)へのみ行われ、現在表示中の
      // second thread の入力欄は汚染されない。
      await waitFor(() => {
        expect(screen.getByLabelText('メッセージ')).toHaveValue('');
      });

      await user.click(screen.getByRole('tab', { name: 'first thread' }));
      await waitFor(() => {
        expect(screen.getByLabelText('メッセージ')).toHaveValue('message for the first thread');
      });
    });

    it('keeps the seed record after restoring an unedited prefill, so a later prefill still replaces it (SF1 regression)', async () => {
      // bdboard-otf Opus レビュー SF1: 復元時に draftSeedTextRef.current[convKey] を
      // delete すると、未編集のプリフィルを送って失敗→復元したあと、次のチケット
      // 起動(startNewDraftThread の SF1 判定)が「シード記録が無い = 編集済み」と
      // 誤判定し、新しいプリフィルが無言で捨てられて古い文言が居座る。delete
      // しなければ(記録を維持すれば)、復元文言はまさにシード文言そのものなので
      // 「未編集」と正しく判定され、次のプリフィルへ置き換わる。
      const user = userEvent.setup();
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === '/api/chat/message' && init?.method === 'POST') {
          return jsonResponse({ error: 'boom' }, 500);
        }
        throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
      });

      const firstPrefill = '最初のチケットについて: ';
      const rendered = renderChatPanel([PROJECT_A], {
        initialProjectId: 'proj-a',
        initialInput: firstPrefill,
        ticketContextToken: 1,
      });

      await waitFor(() => {
        expect(screen.getByLabelText('メッセージ')).toHaveValue(firstPrefill);
      });

      // 未編集のままプリフィルを送信 → 失敗 → 復元(まさに SF1 が守る「未編集
      // シードの復元」ケース)。
      await user.click(screen.getByRole('button', { name: '送信' }));
      await screen.findByText('boom');
      await waitFor(() => {
        expect(screen.getByLabelText('メッセージ')).toHaveValue(firstPrefill);
      });

      // 別チケットを開く(2回目のトークン) → 復元後もシード記録が保たれていれば
      // 「未編集」と判定され、新しいプリフィルへ正しく置き換わる。delete して
      // いた場合はここで firstPrefill が居座り、このアサーションが fail する。
      const secondPrefill = '次のチケットについて: ';
      rendered.rerender(
        <ChatPanel
          projects={[PROJECT_A]}
          initialProjectId="proj-a"
          initialInput={secondPrefill}
          ticketContextToken={2}
          isTicketOnBoard={rendered.isTicketOnBoard}
          onOpenTicket={rendered.onOpenTicket}
          onClose={rendered.onClose}
        />,
      );

      await waitFor(() => {
        expect(screen.getByLabelText('メッセージ')).toHaveValue(secondPrefill);
      });
    });

    it('shows only one user message in the transcript after failure and retry (bdboard-sp2)', async () => {
      const user = userEvent.setup();
      const messageText = 'retry after failure';
      let postCount = 0;
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === '/api/chat/message' && init?.method === 'POST') {
          postCount += 1;
          if (postCount === 1) {
            return jsonResponse({ error: 'boom' }, 500);
          }
          return jsonResponse({
            reply: 'success reply',
            sessionId: 'sess-retry',
            agentId: 'claude',
          });
        }
        throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
      });

      renderChatPanel([PROJECT_A]);
      const input = screen.getByLabelText('メッセージ');
      await user.type(input, messageText);
      await user.click(screen.getByRole('button', { name: '送信' }));

      await screen.findByText('boom');
      const messages = screen.getByRole('log');
      const userMessagesAfterFailure = [...messages.querySelectorAll('.chat-message-user')].filter(
        (element) => element.textContent === messageText,
      );
      expect(userMessagesAfterFailure).toHaveLength(0);
      expect(screen.getByLabelText('メッセージ')).toHaveValue(messageText);

      await user.click(screen.getByRole('button', { name: '送信' }));
      await screen.findByText('success reply');

      const userMessagesAfterRetry = [...messages.querySelectorAll('.chat-message-user')].filter(
        (element) => element.textContent === messageText,
      );
      expect(userMessagesAfterRetry).toHaveLength(1);
      expect(getChatMessagePostCalls(fetchMock)).toHaveLength(2);
    });

    it('removes the optimistic user message from the transcript after a streaming send failure (bdboard-sp2)', async () => {
      const user = userEvent.setup();
      const messageText = 'failed stream rollback';
      fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === '/api/chat/message/stream' && init?.method === 'POST') {
          return new Response(
            new TextEncoder().encode(
              'event: error\ndata: {"error":"stream boom","code":"agent-error"}\n\n',
            ),
          );
        }
        throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
      });

      renderChatPanel([PROJECT_A]);
      await screen.findByLabelText('チャットエージェント');
      const input = screen.getByLabelText('メッセージ');
      await user.type(input, messageText);
      await user.click(screen.getByRole('button', { name: '送信' }));

      await screen.findByText('stream boom');
      const messages = screen.getByRole('log');
      const userMessagesAfterFailure = [...messages.querySelectorAll('.chat-message-user')].filter(
        (element) => element.textContent === messageText,
      );
      expect(userMessagesAfterFailure).toHaveLength(0);
    });
  });

  it('shows thread tabs, switches them, closes without deleting, and deletes after confirmation', async () => {
    const user = userEvent.setup();
    fetchChatThreadsMock.mockResolvedValue([
      { sessionId: 'sess-1', agentId: 'claude', title: 'first thread', pinned: false, updatedAt: '2026-01-02T00:00:00Z' },
      { sessionId: 'sess-2', agentId: 'claude', title: 'second thread', pinned: false, updatedAt: '2026-01-01T00:00:00Z' },
    ]);
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/chat/sessions/sess-1/messages')) {
        return jsonResponse({ sessionId: 'sess-1', agentId: 'claude', messages: [{ role: 'user', content: 'one', createdAt: '2026-01-02T00:00:00Z' }] });
      }
      if (url.includes('/api/chat/sessions/sess-2/messages')) {
        return jsonResponse({ sessionId: 'sess-2', agentId: 'claude', messages: [{ role: 'user', content: 'two', createdAt: '2026-01-01T00:00:00Z' }] });
      }
      if (url === '/api/chat/message' && init?.method === 'POST') return jsonResponse({ reply: 'reply', sessionId: 'sess-2', agentId: 'claude' });
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });
    renderChatPanel([PROJECT_A]);

    expect(await screen.findByRole('tab', { name: 'first thread' })).toBeInTheDocument();
    expect(await screen.findByText('one')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'second thread' }));
    expect(await screen.findByText('two')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'スレッド「second thread」を閉じる' }));
    expect(screen.queryByRole('tab', { name: 'second thread' })).not.toBeInTheDocument();
    expect(deleteChatThreadMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole('tab', { name: 'first thread' }));
    await user.click(screen.getByRole('button', { name: 'スレッド「first thread」を削除' }));
    expect(deleteChatThreadMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'スレッド「first thread」の削除を確定' }));
    await waitFor(() => expect(deleteChatThreadMock).toHaveBeenCalledWith('sess-1', 'proj-a'));
    expect(screen.queryByRole('tab', { name: 'first thread' })).not.toBeInTheDocument();
  });

  it('renames a thread via inline edit and clears custom title when empty', async () => {
    const user = userEvent.setup();
    fetchChatThreadsMock.mockResolvedValue([
      { sessionId: 'sess-1', agentId: 'claude', title: 'first thread', pinned: false, updatedAt: '2026-01-02T00:00:00Z' },
    ]);
    updateChatThreadMock.mockImplementation(async (sessionId, _projectId, patch) => ({
      sessionId,
      agentId: 'claude',
      title: patch.title === null ? null : (patch.title ?? 'first thread'),
      pinned: patch.pinned ?? false,
      updatedAt: '2026-01-02T01:00:00Z',
    }));
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/chat/sessions/sess-1/messages')) {
        return jsonResponse({ sessionId: 'sess-1', agentId: 'claude', messages: [] });
      }
      throw new Error(`Unexpected fetch: GET ${url}`);
    });
    renderChatPanel([PROJECT_A]);

    expect(await screen.findByRole('tab', { name: 'first thread' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'スレッド「first thread」をリネーム' }));

    const renameInput = screen.getByLabelText('スレッド「first thread」の新しいタイトル');
    await user.clear(renameInput);
    await user.type(renameInput, 'renamed thread');
    fireEvent.blur(renameInput);

    await waitFor(() =>
      expect(updateChatThreadMock).toHaveBeenCalledWith('sess-1', 'proj-a', { title: 'renamed thread' }),
    );
    expect(await screen.findByRole('tab', { name: 'renamed thread' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'スレッド「renamed thread」をリネーム' }));
    const clearInput = screen.getByLabelText('スレッド「renamed thread」の新しいタイトル');
    await user.clear(clearInput);
    fireEvent.blur(clearInput);

    await waitFor(() =>
      expect(updateChatThreadMock).toHaveBeenCalledWith('sess-1', 'proj-a', { title: null }),
    );
  });

  it('toggles thread pin state immediately', async () => {
    const user = userEvent.setup();
    fetchChatThreadsMock.mockResolvedValue([
      { sessionId: 'sess-1', agentId: 'claude', title: 'first thread', pinned: false, updatedAt: '2026-01-02T00:00:00Z' },
    ]);
    updateChatThreadMock.mockImplementation(async (sessionId, _projectId, patch) => ({
      sessionId,
      agentId: 'claude',
      title: 'first thread',
      pinned: patch.pinned ?? false,
      updatedAt: '2026-01-02T01:00:00Z',
    }));
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/chat/sessions/sess-1/messages')) {
        return jsonResponse({ sessionId: 'sess-1', agentId: 'claude', messages: [] });
      }
      throw new Error(`Unexpected fetch: GET ${url}`);
    });
    renderChatPanel([PROJECT_A]);

    expect(await screen.findByRole('tab', { name: 'first thread' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'スレッド「first thread」をピン留め' }));
    await waitFor(() =>
      expect(updateChatThreadMock).toHaveBeenCalledWith('sess-1', 'proj-a', { pinned: true }),
    );
    expect(screen.getByRole('button', { name: 'スレッド「first thread」のピン留めを解除' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'スレッド「first thread」のピン留めを解除' }));
    await waitFor(() =>
      expect(updateChatThreadMock).toHaveBeenCalledWith('sess-1', 'proj-a', { pinned: false }),
    );
  });

  it('shows thread error when updateChatThread fails', async () => {
    const user = userEvent.setup();
    fetchChatThreadsMock.mockResolvedValue([
      { sessionId: 'sess-1', agentId: 'claude', title: 'first thread', pinned: false, updatedAt: '2026-01-02T00:00:00Z' },
    ]);
    updateChatThreadMock.mockRejectedValue(new Error('patch failed'));
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/chat/sessions/sess-1/messages')) {
        return jsonResponse({ sessionId: 'sess-1', agentId: 'claude', messages: [] });
      }
      throw new Error(`Unexpected fetch: GET ${url}`);
    });
    renderChatPanel([PROJECT_A]);

    expect(await screen.findByRole('tab', { name: 'first thread' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'スレッド「first thread」をピン留め' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('ピン留めの変更に失敗しました。');
  });

  it('starts a new draft without displaying or sending the previous session', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/chat/message' && init?.method === 'POST') {
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        return jsonResponse({
          reply: body.message === 'first message' ? 'first reply' : 'second reply',
          sessionId: 'sess-established',
          agentId: 'claude',
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A]);
    await user.type(screen.getByLabelText('メッセージ'), 'first message');
    await user.click(screen.getByRole('button', { name: '送信' }));
    expect(await screen.findByText('first reply')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '新しい空のスレッドを開始' }));
    const messageLog = within(screen.getByRole('log'));
    expect(messageLog.queryByText('first message')).not.toBeInTheDocument();
    expect(messageLog.queryByText('first reply')).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('メッセージ'), 'second message');
    await user.click(screen.getByRole('button', { name: '送信' }));
    await screen.findByText('second reply');

    const secondBody = parseChatMessageBody(fetchMock, 1);
    expect(secondBody).toEqual({
      projectId: 'proj-a',
      message: 'second message',
    });
    expect(secondBody).not.toHaveProperty('sessionId');
  });

  it('shows a warning banner when the response reports failedTools (bdboard-l1t.4 MF3)', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/chat/message' && init?.method === 'POST') {
        return jsonResponse({
          reply: 'partial reply',
          sessionId: 'sess-1',
          agentId: 'codex',
          failedTools: ['bd_ready', 'bd_close'],
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A]);
    await user.type(screen.getByLabelText('メッセージ'), 'first message');
    await user.click(screen.getByRole('button', { name: '送信' }));

    expect(await screen.findByText('partial reply')).toBeInTheDocument();
    expect(
      await screen.findByText(
        '一部のツール呼び出しが実行できませんでした: bd_ready, bd_close',
      ),
    ).toBeInTheDocument();
  });

  it('does not show a failed-tools banner when the response has none', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/chat/message' && init?.method === 'POST') {
        return jsonResponse({
          reply: 'clean reply',
          sessionId: 'sess-1',
          agentId: 'claude',
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A]);
    await user.type(screen.getByLabelText('メッセージ'), 'first message');
    await user.click(screen.getByRole('button', { name: '送信' }));

    expect(await screen.findByText('clean reply')).toBeInTheDocument();
    expect(
      screen.queryByText(/一部のツール呼び出しが実行できませんでした/),
    ).not.toBeInTheDocument();
  });

  it('shows an agent-warnings banner when the response reports agentWarnings (bdboard-l1t.6 N-e)', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/chat/message' && init?.method === 'POST') {
        return jsonResponse({
          reply: 'partial reply',
          sessionId: 'sess-1',
          agentId: 'agy',
          agentWarnings: [
            'headless auto-deny: some tool call(s) were soft-denied mid-turn',
          ],
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A]);
    await user.type(screen.getByLabelText('メッセージ'), 'first message');
    await user.click(screen.getByRole('button', { name: '送信' }));

    expect(await screen.findByText('partial reply')).toBeInTheDocument();
    expect(
      await screen.findByText(
        'エージェントの警告: headless auto-deny: some tool call(s) were soft-denied mid-turn',
      ),
    ).toBeInTheDocument();
  });

  it('does not show an agent-warnings banner when the response has none (bdboard-l1t.6 N-e)', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/chat/message' && init?.method === 'POST') {
        return jsonResponse({
          reply: 'clean reply',
          sessionId: 'sess-1',
          agentId: 'agy',
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A]);
    await user.type(screen.getByLabelText('メッセージ'), 'first message');
    await user.click(screen.getByRole('button', { name: '送信' }));

    expect(await screen.findByText('clean reply')).toBeInTheDocument();
    expect(screen.queryByText(/エージェントの警告:/)).not.toBeInTheDocument();
  });

  it('includes sessionId from the previous response on the second message', async () => {
    const user = userEvent.setup();
    let postCount = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/chat/message' && init?.method === 'POST') {
        postCount += 1;
        if (postCount === 1) {
          return jsonResponse({
            reply: 'first reply',
            sessionId: 'sess-abc',
            agentId: 'claude',
          });
        }
        return jsonResponse({
          reply: 'second reply',
          sessionId: 'sess-abc',
          agentId: 'claude',
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A]);

    await user.type(screen.getByLabelText('メッセージ'), 'message one');
    await user.click(screen.getByRole('button', { name: '送信' }));
    await screen.findByText('first reply');

    await user.type(screen.getByLabelText('メッセージ'), 'message two');
    await user.click(screen.getByRole('button', { name: '送信' }));
    await screen.findByText('second reply');

    await waitFor(() => {
      expect(getChatMessagePostCalls(fetchMock)).toHaveLength(2);
    });

    const secondBody = parseChatMessageBody(fetchMock, 1);
    expect(secondBody).toEqual({
      projectId: 'proj-a',
      message: 'message two',
      sessionId: 'sess-abc',
    });
  });

  it('does not send sessionId after switching projects', async () => {
    const user = userEvent.setup();
    let postCount = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/chat/message' && init?.method === 'POST') {
        postCount += 1;
        const body = JSON.parse(init.body as string) as {
          projectId: string;
          message: string;
        };
        return jsonResponse({
          reply: `reply for ${body.projectId}`,
          sessionId: `sess-${body.projectId}`,
          agentId: 'claude',
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel();

    await user.type(screen.getByLabelText('メッセージ'), 'on project a');
    await user.click(screen.getByRole('button', { name: '送信' }));
    await screen.findByText('reply for proj-a');

    await user.selectOptions(
      screen.getByLabelText('対象プロジェクト'),
      'proj-b',
    );

    await user.type(screen.getByLabelText('メッセージ'), 'on project b');
    await user.click(screen.getByRole('button', { name: '送信' }));
    await screen.findByText('reply for proj-b');

    await waitFor(() => {
      expect(getChatMessagePostCalls(fetchMock)).toHaveLength(2);
    });

    const secondBody = parseChatMessageBody(fetchMock, 1);
    expect(secondBody).toEqual({
      projectId: 'proj-b',
      message: 'on project b',
    });
    expect(secondBody).not.toHaveProperty('sessionId');
    expect(postCount).toBe(2);
  });

  it('shows a busy message on 409 responses', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/chat/message' && init?.method === 'POST') {
        return jsonResponse({ error: 'chat is busy for this project' }, 409);
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A]);
    await user.type(screen.getByLabelText('メッセージ'), 'busy test');
    await user.click(screen.getByRole('button', { name: '送信' }));

    expect(
      await screen.findByText(CHAT_BUSY_HELP),
    ).toBeInTheDocument();
  });

  // bdboard-l1t.5 Opus 再レビュー DF1: サーバー側 (chat-agent.ts / chat-routes.ts) が
  // 'agent-workspace-untrusted' を 502 + { error, code, detail } で返したとき、
  // ChatPanel が code をマップして「ワークスペースを信頼させる」趣旨の日本語文言を
  // 描画することを固定する(以前は error.errorMessage ?? error.message = 'chat failed'
  // という素通しの汎用文言しか出なかった)。
  it('shows a workspace-trust message when the server reports agent-workspace-untrusted (502)', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/chat/message' && init?.method === 'POST') {
        return jsonResponse(
          {
            error: 'chat failed',
            code: 'agent-workspace-untrusted',
            detail:
              'the chat agent requires this project directory to be trusted outside bdboard before it can run non-interactively',
          },
          502,
        );
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A]);
    await user.type(screen.getByLabelText('メッセージ'), 'untrusted workspace test');
    await user.click(screen.getByRole('button', { name: '送信' }));

    expect(
      await screen.findByText(/このプロジェクト\(ワークスペース\)を cursor-agent に信頼させる必要があります。/),
    ).toBeInTheDocument();
    // 生の detail(サーバーログ専用の定型文とはいえ、UI にはこの汎用フォールバックが
    // 出てはいけないことを固定する)。
    expect(screen.queryByText('chat failed')).not.toBeInTheDocument();
  });

  // bdboard-l1t.6 Opus レビュー SF1 (上の l1t.5 DF1 と同型): agy の headless モードが
  // ツール呼び出しを自動拒否したとき、サーバーは 'agent-headless-denied' を
  // 502 + { error, code, detail } で返す。ChatPanel が code をマップして
  // 「permissions.allow の許可ルールが要る」趣旨の日本語文言を描画することを固定する。
  it('shows a permissions-setup message when the server reports agent-headless-denied (502)', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/chat/message' && init?.method === 'POST') {
        return jsonResponse(
          {
            error: 'chat failed',
            code: 'agent-headless-denied',
            detail:
              'the chat agent auto-denied a tool call that its headless mode cannot approve; the agy CLI needs an operator-side permissions.allow rule for the bd command (see README)',
          },
          502,
        );
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A]);
    await user.type(screen.getByLabelText('メッセージ'), 'headless denial test');
    await user.click(screen.getByRole('button', { name: '送信' }));

    expect(
      await screen.findByText(/headless モードがツール呼び出しを自動拒否したため/),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(/permissions\.allow/),
    ).toBeInTheDocument();
    expect(screen.queryByText('chat failed')).not.toBeInTheDocument();
  });

  it('clears sessionId after unknown chat session and omits it on the next send', async () => {
    const user = userEvent.setup();
    let postCount = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/chat/message' && init?.method === 'POST') {
        postCount += 1;
        if (postCount === 1) {
          return jsonResponse({
            reply: 'ok',
            sessionId: 'stale-session',
            agentId: 'claude',
          });
        }
        if (postCount === 2) {
          return jsonResponse({ error: 'unknown chat session' }, 400);
        }
        return jsonResponse({
          reply: 'fresh start',
          sessionId: 'new-session',
          agentId: 'claude',
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A]);

    await user.type(screen.getByLabelText('メッセージ'), 'first');
    await user.click(screen.getByRole('button', { name: '送信' }));
    await screen.findByText('ok');

    await user.type(screen.getByLabelText('メッセージ'), 'second');
    await user.click(screen.getByRole('button', { name: '送信' }));
    expect(
      await screen.findByText('会話の続きが失われました。もう一度送信してください。'),
    ).toBeInTheDocument();
    // bdboard-otf: clearSession 経路(unknown chat session)でも送信失敗時に本文が
    // 入力欄へ復元される。この後で送信するのは意図的に別の文言("third")なので、
    // 復元された "second" をいったんクリアしてから打ち直す。
    await waitFor(() => {
      expect(screen.getByLabelText('メッセージ')).toHaveValue('second');
    });
    await user.clear(screen.getByLabelText('メッセージ'));

    await user.type(screen.getByLabelText('メッセージ'), 'third');
    await user.click(screen.getByRole('button', { name: '送信' }));
    await screen.findByText('fresh start');

    await waitFor(() => {
      expect(getChatMessagePostCalls(fetchMock)).toHaveLength(3);
    });

    const secondBody = parseChatMessageBody(fetchMock, 1);
    expect(secondBody.sessionId).toBe('stale-session');

    const thirdBody = parseChatMessageBody(fetchMock, 2);
    expect(thirdBody).toEqual({
      projectId: 'proj-a',
      message: 'third',
    });
    expect(thirdBody).not.toHaveProperty('sessionId');
  });

  it('disables the textarea and submit button while sending', async () => {
    const user = userEvent.setup();
    const deferred = createDeferred<Response>();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/chat/message' && init?.method === 'POST') {
        return deferred.promise;
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A]);
    const textarea = screen.getByLabelText('メッセージ');
    const submitButton = screen.getByRole('button', { name: '送信' });

    await user.type(textarea, 'pending message');
    await user.click(submitButton);

    await waitFor(() => {
      expect(textarea).toBeDisabled();
      expect(submitButton).toBeDisabled();
    });
    expect(screen.getByText('考え中…（最大3分かかることがあります）')).toBeInTheDocument();

    deferred.resolve(
      jsonResponse({ reply: 'done', sessionId: 'sess-done', agentId: 'claude' }),
    );

    await waitFor(() => {
      expect(textarea).not.toBeDisabled();
      expect(submitButton).toBeDisabled();
    });
    expect(await screen.findByText('done')).toBeInTheDocument();
  });

  it('renders assistant HTML-like text without interpreting it as markup', async () => {
    const user = userEvent.setup();
    const xssPayload = '<img src=x onerror=alert(1)>';
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/chat/message' && init?.method === 'POST') {
        return jsonResponse({ reply: xssPayload, sessionId: 'sess-xss', agentId: 'claude' });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A]);
    await user.type(screen.getByLabelText('メッセージ'), 'xss test');
    await user.click(screen.getByRole('button', { name: '送信' }));

    const messageText = await screen.findByText(xssPayload);
    const messageContainer = messageText.closest('.chat-message-text');
    expect(messageContainer).not.toBeNull();
    expect(messageContainer).toHaveClass('markdown-body');
    expect(messageContainer?.querySelector('img')).toBeNull();
    expect(document.querySelector('.chat-message-text img')).toBeNull();
    expect(messageContainer?.innerHTML).not.toMatch(/<img\b/i);
  });

  it('renders assistant markdown including headings and code blocks', async () => {
    const user = userEvent.setup();
    const markdownReply = ['# Summary', '', '```ts', 'const x = 1;', '```'].join('\n');
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/chat/message' && init?.method === 'POST') {
        return jsonResponse({
          reply: markdownReply,
          sessionId: 'sess-markdown',
          agentId: 'claude',
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A]);
    await user.type(screen.getByLabelText('メッセージ'), 'markdown test');
    await user.click(screen.getByRole('button', { name: '送信' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Summary' }),
    ).toBeInTheDocument();
    expect(screen.getByText('const x = 1;')).toBeInTheDocument();
  });

  it('links known bead IDs in assistant messages and calls onOpenTicket', async () => {
    const user = userEvent.setup();
    const onOpenTicket = vi.fn();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/chat/message' && init?.method === 'POST') {
        return jsonResponse({
          reply: 'Blocked by bdboard-abc.1 until done.',
          sessionId: 'sess-bead-link',
          agentId: 'claude',
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A], {
      isTicketOnBoard: (id) => id === 'bdboard-abc.1',
      onOpenTicket,
    });
    await user.type(screen.getByLabelText('メッセージ'), 'bead link test');
    await user.click(screen.getByRole('button', { name: '送信' }));

    const ticketButton = await screen.findByRole('button', { name: 'bdboard-abc.1' });
    expect(ticketButton).toHaveClass('ticket-id-link');
    await user.click(ticketButton);
    expect(onOpenTicket).toHaveBeenCalledWith('bdboard-abc.1');
  });

  it('selects the sole claude agent by default when only one option exists', async () => {
    fetchChatAgentsMock.mockResolvedValue([CLAUDE_AGENT]);

    renderChatPanel([PROJECT_A]);

    const select = await screen.findByLabelText('チャットエージェント');
    const options = select.querySelectorAll('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveValue('claude');
    expect(select).toHaveValue('claude');
  });

  it('clears sessionId when switching agents and sends a fresh conversation', async () => {
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([CLAUDE_AGENT, EXAMPLE_AGENT]);
    let postCount = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/chat/message' && init?.method === 'POST') {
        postCount += 1;
        const body = JSON.parse(init.body as string) as {
          projectId: string;
          message: string;
          sessionId?: string;
          agentId?: string;
        };
        if (postCount === 1) {
          expect(body.sessionId).toBeUndefined();
          expect(body.agentId).toBe('claude');
          return jsonResponse({
            reply: 'reply one',
            sessionId: 'sess-1',
            agentId: 'claude',
          });
        }
        if (postCount === 2) {
          expect(body.sessionId).toBe('sess-1');
          expect(body.agentId).toBe('claude');
          return jsonResponse({
            reply: 'reply two',
            sessionId: 'sess-1',
            agentId: 'claude',
          });
        }
        expect(body.sessionId).toBeUndefined();
        expect(body.agentId).toBe('example-agent');
        return jsonResponse({
          reply: 'reply three',
          sessionId: 'sess-2',
          agentId: 'example-agent',
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A]);
    await screen.findByLabelText('チャットエージェント');

    await user.type(screen.getByLabelText('メッセージ'), 'message one');
    await user.click(screen.getByRole('button', { name: '送信' }));
    await screen.findByText('reply one');

    await user.type(screen.getByLabelText('メッセージ'), 'message two');
    await user.click(screen.getByRole('button', { name: '送信' }));
    await screen.findByText('reply two');

    await user.selectOptions(
      screen.getByLabelText('チャットエージェント'),
      'example-agent',
    );

    await user.type(screen.getByLabelText('メッセージ'), 'message three');
    await user.click(screen.getByRole('button', { name: '送信' }));
    await screen.findByText('reply three');

    expect(within(screen.getByRole('log')).queryByText('message one')).not.toBeInTheDocument();
    expect(within(screen.getByRole('log')).queryByText('reply one')).not.toBeInTheDocument();
    expect(within(screen.getByRole('log')).queryByText('message two')).not.toBeInTheDocument();
    expect(within(screen.getByRole('log')).queryByText('reply two')).not.toBeInTheDocument();

    await waitFor(() => {
      expect(getChatMessagePostCalls(fetchMock)).toHaveLength(3);
    });
    expect(postCount).toBe(3);
  });

  it('shows capability warning for non-bd-only agents and hides bd-only help text', async () => {
    fetchChatAgentsMock.mockResolvedValue([CLAUDE_AGENT, READS_PROJECT_AGENT]);

    renderChatPanel([PROJECT_A]);
    const agentSelect = await screen.findByLabelText('チャットエージェント');

    expect(
      screen.getByText(/bdチケット操作\(一覧・詳細・claim・状態変更・クローズ・コメント追加\)だけです/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/bd チケット操作以外の権限を持ちます/),
    ).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.selectOptions(agentSelect, 'reads-project-agent');

    expect(
      screen.getByText(
        'このエージェントは bd チケット操作以外の権限を持ちます（reads-project）。',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/bdチケット操作\(一覧・詳細・claim・状態変更・クローズ・コメント追加\)だけです/),
    ).not.toBeInTheDocument();

    await user.selectOptions(agentSelect, 'claude');

    expect(
      screen.getByText(/bdチケット操作\(一覧・詳細・claim・状態変更・クローズ・コメント追加\)だけです/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/bd チケット操作以外の権限を持ちます/),
    ).not.toBeInTheDocument();
  });

  it('shows unavailable label and note when the selected agent is unavailable', async () => {
    fetchChatAgentsMock.mockResolvedValue([
      { ...CLAUDE_AGENT, availability: 'unavailable' },
    ]);

    renderChatPanel([PROJECT_A]);
    const agentSelect = await screen.findByLabelText('チャットエージェント');

    expect(agentSelect).toHaveTextContent('Claude（利用不可）');
    expect(
      screen.getByText(
        'このエージェントは利用できません（CLI が無いか、認証が通っていません）。',
      ),
    ).toBeInTheDocument();
  });

  it('shows unknown label but no availability note when auth is unverified', async () => {
    fetchChatAgentsMock.mockResolvedValue([
      { ...CLAUDE_AGENT, availability: 'unknown' },
    ]);

    renderChatPanel([PROJECT_A]);
    const agentSelect = await screen.findByLabelText('チャットエージェント');

    expect(agentSelect).toHaveTextContent('Claude（認証未確認）');
    expect(
      screen.queryByText(
        'このエージェントの認証状態を確認できませんでした。送信してみるまで使えるか分かりません。',
      ),
    ).not.toBeInTheDocument();
  });

  it('collapses and expands chat settings controls', async () => {
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([CLAUDE_AGENT]);
    const { container } = renderChatPanel([PROJECT_A, PROJECT_B], {
      leaveSettingsCollapsed: true,
    });

    const details = container.querySelector('.chat-panel-settings');
    expect(details).toBeInstanceOf(HTMLDetailsElement);
    expect((details as HTMLDetailsElement).open).toBe(false);
    expect(screen.queryByLabelText('対象プロジェクト')).not.toBeVisible();
    expect(screen.getByText(/チャット設定 — Project Alpha/)).toBeInTheDocument();

    await user.click(screen.getByText(/チャット設定 — Project Alpha/));
    expect((details as HTMLDetailsElement).open).toBe(true);
    expect(screen.getByLabelText('対象プロジェクト')).toBeInTheDocument();

    await user.click(screen.getByText(/チャット設定 — Project Alpha/));
    expect((details as HTMLDetailsElement).open).toBe(false);
    expect(screen.queryByLabelText('対象プロジェクト')).not.toBeVisible();
  });

  it('selects initialProjectId when provided', async () => {
    renderChatPanel([PROJECT_A, PROJECT_B], { initialProjectId: 'proj-b' });

    expect(screen.getByLabelText('対象プロジェクト')).toHaveValue('proj-b');
  });

  it('calls onProjectIdChange when the project select changes', async () => {
    const user = userEvent.setup();
    const onProjectIdChange = vi.fn();
    renderChatPanel([PROJECT_A, PROJECT_B], { onProjectIdChange });

    await waitFor(() => {
      expect(onProjectIdChange).toHaveBeenCalledWith('proj-a');
    });
    onProjectIdChange.mockClear();

    await user.selectOptions(
      screen.getByLabelText('対象プロジェクト'),
      'proj-b',
    );

    expect(onProjectIdChange).toHaveBeenCalledWith('proj-b');
  });

  it('falls back to the first project when initialProjectId is unknown', async () => {
    renderChatPanel([PROJECT_A, PROJECT_B], {
      initialProjectId: 'missing-project',
    });

    expect(screen.getByLabelText('対象プロジェクト')).toHaveValue('proj-a');
  });

  it('works without agent select when fetchChatAgents fails', async () => {
    const user = userEvent.setup();
    fetchChatAgentsMock.mockRejectedValue(new Error('agents unavailable'));
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/chat/message' && init?.method === 'POST') {
        return jsonResponse({
          reply: 'fallback reply',
          sessionId: 'sess-fallback',
          agentId: 'claude',
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A]);
    await waitFor(() => {
      expect(fetchChatAgentsMock).toHaveBeenCalled();
    });

    expect(screen.queryByLabelText('チャットエージェント')).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('メッセージ'), 'still works');
    await user.click(screen.getByRole('button', { name: '送信' }));

    await waitFor(() => {
      expect(getChatMessagePostCalls(fetchMock)).toHaveLength(1);
    });

    const body = parseChatMessageBody(fetchMock);
    expect(body).toEqual({
      projectId: 'proj-a',
      message: 'still works',
    });
    expect(body).not.toHaveProperty('agentId');
    expect(await screen.findByText('fallback reply')).toBeInTheDocument();
  });

  it('shows model select when the agent exposes two or more models and sends the choice', async () => {
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([
      {
        ...CLAUDE_AGENT,
        model: 'sonnet',
        models: [
          { id: 'sonnet', label: 'Sonnet' },
          { id: 'opus', label: 'Opus' },
        ],
      },
    ]);

    renderChatPanel([PROJECT_A]);
    const modelSelect = await screen.findByLabelText('モデル');
    expect(modelSelect).toHaveValue('sonnet');

    await user.selectOptions(modelSelect, 'opus');
    await user.type(screen.getByLabelText('メッセージ'), 'use opus');
    await user.click(screen.getByRole('button', { name: '送信' }));

    await waitFor(() => {
      expect(getChatMessagePostCalls(fetchMock)).toHaveLength(1);
    });

    expect(parseChatMessageBody(fetchMock)).toEqual({
      projectId: 'proj-a',
      message: 'use opus',
      agentId: 'claude',
      model: 'opus',
    });

    // エージェント側のラベルに descriptor 既定を出さない。出すと Opus 選択中に
    // 「Claude Code (sonnet)」と並んで表示され、2つのコントロールが矛盾する。
    expect(
      screen.getByLabelText('チャットエージェント'),
    ).not.toHaveTextContent('(sonnet)');
  });

  it('hides model select when the agent exposes fewer than two models', async () => {
    fetchChatAgentsMock.mockResolvedValue([
      {
        ...CLAUDE_AGENT,
        model: 'sonnet',
        models: [{ id: 'sonnet', label: 'Sonnet' }],
      },
    ]);

    renderChatPanel([PROJECT_A]);
    await screen.findByLabelText('チャットエージェント');

    expect(screen.queryByLabelText('モデル')).not.toBeInTheDocument();
  });

  it('resets model selection to the new agent default when switching agents', async () => {
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([
      {
        ...CLAUDE_AGENT,
        model: 'sonnet',
        models: [
          { id: 'sonnet', label: 'Sonnet' },
          { id: 'opus', label: 'Opus' },
        ],
      },
      {
        ...EXAMPLE_AGENT,
        model: 'fast',
        models: [
          { id: 'fast', label: 'Fast' },
          { id: 'slow', label: 'Slow' },
        ],
      },
    ]);

    renderChatPanel([PROJECT_A]);
    const modelSelect = await screen.findByLabelText('モデル');
    await user.selectOptions(modelSelect, 'opus');
    expect(modelSelect).toHaveValue('opus');

    await user.selectOptions(
      screen.getByLabelText('チャットエージェント'),
      'example-agent',
    );

    expect(await screen.findByLabelText('モデル')).toHaveValue('fast');
  });

  it('restores a draft model selection after remounting without sending', async () => {
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([
      {
        ...CLAUDE_AGENT,
        model: 'sonnet',
        models: [
          { id: 'sonnet', label: 'Sonnet' },
          { id: 'opus', label: 'Opus' },
        ],
      },
    ]);

    const first = renderChatPanel([PROJECT_A]);
    const modelSelect = await screen.findByLabelText('モデル');
    await user.selectOptions(modelSelect, 'opus');
    expect(modelSelect).toHaveValue('opus');
    first.unmount();

    renderChatPanel([PROJECT_A]);
    await waitFor(() => {
      expect(screen.getByLabelText('モデル')).toHaveValue('opus');
    });
  });

  it('preserves model selection when switching back to the same agent', async () => {
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([
      {
        ...CLAUDE_AGENT,
        model: 'sonnet',
        models: [
          { id: 'sonnet', label: 'Sonnet' },
          { id: 'opus', label: 'Opus' },
        ],
      },
      {
        ...EXAMPLE_AGENT,
        model: 'fast',
        models: [
          { id: 'fast', label: 'Fast' },
          { id: 'slow', label: 'Slow' },
        ],
      },
    ]);

    renderChatPanel([PROJECT_A]);
    const modelSelect = await screen.findByLabelText('モデル');
    await user.selectOptions(modelSelect, 'opus');
    expect(modelSelect).toHaveValue('opus');

    await user.selectOptions(
      screen.getByLabelText('チャットエージェント'),
      'example-agent',
    );

    expect(await screen.findByLabelText('モデル')).toHaveValue('fast');

    await user.selectOptions(
      screen.getByLabelText('チャットエージェント'),
      'claude',
    );

    expect(await screen.findByLabelText('モデル')).toHaveValue('opus');
  });

  it('restores the model after history resolves before the agents request', async () => {
    writePersistedChatThread('proj-a', {
      sessionId: 'sess-model-race',
      agentId: 'claude',
    });
    fetchChatThreadsMock.mockResolvedValue([
      {
        sessionId: 'sess-model-race',
        agentId: 'claude',
        title: 'race',
        pinned: false,
        updatedAt: '2026-08-16T03:00:00.000Z',
      },
    ]);
    const agentsDeferred = createDeferred<ChatAgentDto[]>();
    fetchChatAgentsMock.mockReturnValue(agentsDeferred.promise);
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/chat/sessions/sess-model-race/messages')) {
        return jsonResponse({
          sessionId: 'sess-model-race',
          agentId: 'claude',
          model: 'opus',
          messages: [],
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) =>
        String(url).startsWith('/api/chat/sessions/sess-model-race/messages'),
      )).toBe(true);
    });
    expect(fetchChatAgentsMock).toHaveBeenCalled();

    // agents リクエストがまだ解決していない時点では、モデル選択セレクトはまだ
    // 描画されない(エージェント一覧が空なので selectedAgent が定まらない)。
    // ここで復元済みの値が早期に(誤って)反映されていないことを確認してから
    // agents を解決させることで、pendingModelRestoreRef 相当のキャッシュ経由の
    // 復元経路を確実に踏ませる。
    expect(screen.queryByLabelText('モデル')).not.toBeInTheDocument();

    agentsDeferred.resolve([{
      ...CLAUDE_AGENT,
      model: 'sonnet',
      models: [
        { id: 'sonnet', label: 'Sonnet' },
        { id: 'opus', label: 'Opus' },
      ],
    }]);

    // findByLabelText はセレクト要素が最初に現れた時点(まだ既定値 'sonnet' の
    // ままの可能性がある)で解決してしまうため、値の確定は waitFor で
    // 再ポーリングして待つ。
    await waitFor(() => {
      expect(screen.getByLabelText('モデル')).toHaveValue('opus');
    });
  });

  it('restores the agent and falls back from an invalid persisted model', async () => {
    writePersistedChatThread('proj-a', {
      sessionId: 'sess-invalid-model',
      agentId: 'example-agent',
    });
    fetchChatThreadsMock.mockResolvedValue([
      {
        sessionId: 'sess-invalid-model',
        agentId: 'example-agent',
        title: 'invalid',
        pinned: false,
        updatedAt: '2026-08-16T03:00:00.000Z',
      },
    ]);
    fetchChatAgentsMock.mockResolvedValue([
      {
        ...CLAUDE_AGENT,
        model: 'sonnet',
        models: [
          { id: 'sonnet', label: 'Sonnet' },
          { id: 'opus', label: 'Opus' },
        ],
      },
      {
        ...EXAMPLE_AGENT,
        model: 'fast',
        models: [
          { id: 'fast', label: 'Fast' },
          { id: 'slow', label: 'Slow' },
        ],
      },
    ]);
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/chat/sessions/sess-invalid-model/messages')) {
        return jsonResponse({
          sessionId: 'sess-invalid-model',
          agentId: 'example-agent',
          model: 'nonexistent-model',
          messages: [],
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });

    await waitFor(() => {
      expect(screen.getByLabelText('チャットエージェント')).toHaveValue(
        'example-agent',
      );
    });
    await waitFor(() => {
      expect(screen.getByLabelText('モデル')).toHaveValue('fast');
    });
  });

  it('restores the persisted agent even when the default-agent effect sets a different agent first (bdboard-2n8 stale-ref regression)', async () => {
    // 以前は「履歴リクエスト開始時点の selectedAgentId」のスナップショットと
    // 「現在の selectedAgentId」を比較しており、この effect の外で起きる
    // 「エージェント一覧ロード後の既定エージェント自動選択」だけでもスナップ
    // ショットとの不一致が生まれ、ユーザーが何も手動操作していないのに
    // 永続化されていたエージェントへの復元が失敗していた。ここでは
    // 履歴フェッチより先にエージェント一覧の解決(既定選択)を起こし、
    // その後で履歴フェッチが「別のエージェント」を返すという順序を明示的に
    // 再現して、復元が成功することを確認する。
    writePersistedChatThread('proj-a', {
      sessionId: 'sess-agent-race',
      agentId: 'example-agent',
    });
    fetchChatThreadsMock.mockResolvedValue([
      {
        sessionId: 'sess-agent-race',
        agentId: 'example-agent',
        title: 'race',
        pinned: false,
        updatedAt: '2026-08-16T03:00:00.000Z',
      },
    ]);
    const agentsDeferred = createDeferred<ChatAgentDto[]>();
    fetchChatAgentsMock.mockReturnValue(agentsDeferred.promise);
    const messagesDeferred = createDeferred<Response>();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/chat/sessions/sess-agent-race/messages')) {
        return messagesDeferred.promise;
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) =>
        String(url).startsWith('/api/chat/sessions/sess-agent-race/messages'),
      )).toBe(true);
    });

    // 履歴フェッチはまだ in-flight。ここでエージェント一覧を解決させ、
    // 「既定エージェント(list[0] = claude)の自動選択」を先に起こす。
    agentsDeferred.resolve([CLAUDE_AGENT, EXAMPLE_AGENT]);
    await waitFor(() => {
      expect(screen.getByLabelText('チャットエージェント')).toHaveValue('claude');
    });

    // このあとで履歴フェッチが解決し、永続化されていた 'example-agent' を
    // 返す。ユーザーは一度も手動でエージェントを変更していないので、
    // 復元が適用されるべき。
    messagesDeferred.resolve(
      jsonResponse({
        sessionId: 'sess-agent-race',
        agentId: 'example-agent',
        messages: [],
      }),
    );
    await waitFor(() => {
      expect(screen.getByLabelText('チャットエージェント')).toHaveValue('example-agent');
    });
  });

  it('restores the model from the server after sending and remounting', async () => {
    const user = userEvent.setup();
    const modelEnabledClaude: ChatAgentDto = {
      ...CLAUDE_AGENT,
      model: 'sonnet',
      models: [
        { id: 'sonnet', label: 'Sonnet' },
        { id: 'opus', label: 'Opus' },
      ],
    };
    fetchChatAgentsMock.mockResolvedValue([modelEnabledClaude]);
    // 1回目(初回マウント時)は「まだスレッドが無い」状態、2回目(再マウント時、
    // 送信後の localStorage を引き継いだ状態)は送信で作られたスレッドが
    // サーバー側の一覧にも載っている状態を模す。
    fetchChatThreadsMock.mockResolvedValueOnce([]).mockResolvedValue([
      {
        sessionId: 'sess-sent-model',
        agentId: 'claude',
        title: 'sent',
        pinned: false,
        updatedAt: '2026-08-16T03:00:00.000Z',
      },
    ]);
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/chat/message' && init?.method === 'POST') {
        return jsonResponse({
          reply: 'sent', sessionId: 'sess-sent-model', agentId: 'claude', model: 'opus',
        });
      }
      if (url.startsWith('/api/chat/sessions/sess-sent-model/messages')) {
        return jsonResponse({
          sessionId: 'sess-sent-model', agentId: 'claude', model: 'opus', messages: [],
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    const first = renderChatPanel([PROJECT_A]);
    const modelSelect = await screen.findByLabelText('モデル');
    await user.selectOptions(modelSelect, 'opus');
    await user.type(screen.getByLabelText('メッセージ'), 'persist this choice');
    await user.click(screen.getByRole('button', { name: '送信' }));
    await screen.findByText('sent');
    first.unmount();

    renderChatPanel([PROJECT_A]);
    await waitFor(() => {
      expect(screen.getByLabelText('モデル')).toHaveValue('opus');
    });
  });

  it('keeps a manual model pick made while the history fetch is still in flight (bdboard-2n8)', async () => {
    const user = userEvent.setup();
    writePersistedChatThread('proj-a', {
      sessionId: 'sess-manual-race',
      agentId: 'claude',
    });
    fetchChatThreadsMock.mockResolvedValue([
      {
        sessionId: 'sess-manual-race',
        agentId: 'claude',
        title: 'manual',
        pinned: false,
        updatedAt: '2026-08-16T03:00:00.000Z',
      },
    ]);
    fetchChatAgentsMock.mockResolvedValue([
      {
        ...CLAUDE_AGENT,
        model: 'sonnet',
        models: [
          { id: 'sonnet', label: 'Sonnet' },
          { id: 'opus', label: 'Opus' },
        ],
      },
    ]);
    const messagesDeferred = createDeferred<Response>();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/chat/sessions/sess-manual-race/messages')) {
        return messagesDeferred.promise;
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });

    const modelSelect = await screen.findByLabelText('モデル');
    await waitFor(() => expect(modelSelect).toHaveValue('sonnet'));
    await user.selectOptions(modelSelect, 'opus');
    expect(modelSelect).toHaveValue('opus');

    // 履歴フェッチが後から解決し、サーバー側の復元値('sonnet')を返す。
    // ユーザーが in-flight 中に手動で 'opus' を選んでいるので、
    // これで上書きされてはいけない。
    messagesDeferred.resolve(
      jsonResponse({
        sessionId: 'sess-manual-race',
        agentId: 'claude',
        model: 'sonnet',
        messages: [],
      }),
    );

    await waitFor(() => {
      expect(screen.queryByText('履歴を読み込み中…')).not.toBeInTheDocument();
    });
    expect(screen.getByLabelText('モデル')).toHaveValue('opus');
  });

  it('keeps a manual model pick on an unsent draft thread across a round trip through another project (bdboard-2n8)', async () => {
    // ドラフト(未送信)スレッドの会話キーは `new:${projectId}:${draftNonce}` で、
    // draftNonce はプロジェクトごとに独立している。そのためプロジェクトを
    // 切り替えて元に戻ると、ドラフトの会話キー自体は変わらない —
    // これが「タブ往復」で手動選択を保持できるかを検証できる具体的な経路。
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([
      {
        ...CLAUDE_AGENT,
        model: 'sonnet',
        models: [
          { id: 'sonnet', label: 'Sonnet' },
          { id: 'opus', label: 'Opus' },
        ],
      },
    ]);
    fetchChatThreadsMock.mockResolvedValue([]);

    renderChatPanel([PROJECT_A, PROJECT_B], { initialProjectId: 'proj-a' });

    const modelSelect = await screen.findByLabelText('モデル');
    await waitFor(() => expect(modelSelect).toHaveValue('sonnet'));
    await user.selectOptions(modelSelect, 'opus');
    expect(modelSelect).toHaveValue('opus');

    await user.selectOptions(screen.getByLabelText('対象プロジェクト'), 'proj-b');
    await waitFor(() => {
      expect(screen.getByLabelText('対象プロジェクト')).toHaveValue('proj-b');
    });
    await waitFor(() => {
      expect(screen.getByLabelText('モデル')).toHaveValue('sonnet');
    });

    await user.selectOptions(screen.getByLabelText('対象プロジェクト'), 'proj-a');
    await waitFor(() => {
      expect(screen.getByLabelText('モデル')).toHaveValue('opus');
    });
  });

  it('reapplies each thread’s own restored model when switching between already-loaded tabs', async () => {
    // MF3: 履歴読み込み effect はスレッドごとに一度きり(historyLoadedFor で
    // ガード)なので、既に両方読み込み済みのスレッドを A→B→A と行き来したときに
    // モデルが再適用されるのは「フェッチが起きた時」ではなく「表示中の会話キーが
    // 変わった時」に反応するキャッシュ経由でなければならない。
    const user = userEvent.setup();
    const modelEnabledClaude: ChatAgentDto = {
      ...CLAUDE_AGENT,
      model: 'sonnet',
      models: [
        { id: 'sonnet', label: 'Sonnet' },
        { id: 'opus', label: 'Opus' },
      ],
    };
    fetchChatAgentsMock.mockResolvedValue([modelEnabledClaude]);
    fetchChatThreadsMock.mockResolvedValue([
      { sessionId: 'sess-thread-a', agentId: 'claude', title: 'thread A', pinned: false, updatedAt: '2026-08-16T03:00:00.000Z' },
      { sessionId: 'sess-thread-b', agentId: 'claude', title: 'thread B', pinned: false, updatedAt: '2026-08-16T03:01:00.000Z' },
    ]);
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/chat/sessions/sess-thread-a/messages')) {
        return jsonResponse({
          sessionId: 'sess-thread-a', agentId: 'claude', model: 'sonnet', messages: [],
        });
      }
      if (url.startsWith('/api/chat/sessions/sess-thread-b/messages')) {
        return jsonResponse({
          sessionId: 'sess-thread-b', agentId: 'claude', model: 'opus', messages: [],
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });

    expect(await screen.findByRole('tab', { name: 'thread A' })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByLabelText('モデル')).toHaveValue('sonnet');
    });

    await user.click(screen.getByRole('tab', { name: 'thread B' }));
    await waitFor(() => {
      expect(screen.getByLabelText('モデル')).toHaveValue('opus');
    });

    await user.click(screen.getByRole('tab', { name: 'thread A' }));
    await waitFor(() => {
      expect(screen.getByLabelText('モデル')).toHaveValue('sonnet');
    });
  });

  it('loads persisted session history from the server when the panel opens', async () => {
    writePersistedChatThread('proj-a', {
      sessionId: 'sess-restored',
      agentId: 'claude',
    });
    fetchChatThreadsMock.mockResolvedValue([
      { sessionId: 'sess-restored', agentId: 'claude', title: 'restored', pinned: false, updatedAt: '2026-08-16T03:00:00.000Z' },
    ]);
    fetchChatAgentsMock.mockResolvedValue([CLAUDE_AGENT]);
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (
        url.startsWith('/api/chat/sessions/sess-restored/messages') &&
        (init?.method ?? 'GET') === 'GET'
      ) {
        return jsonResponse({
          sessionId: 'sess-restored',
          agentId: 'claude',
          messages: [
            {
              role: 'user',
              content: 'previous question',
              createdAt: '2026-08-16T03:00:00.000Z',
            },
            {
              role: 'assistant',
              content: 'previous answer',
              createdAt: '2026-08-16T03:00:01.000Z',
            },
          ],
        });
      }
      if (url === '/api/chat/message' && init?.method === 'POST') {
        return jsonResponse({
          reply: 'AI reply',
          sessionId: 'sess-default',
          agentId: 'claude',
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });

    await waitFor(() => {
      expect(screen.getByText('previous question')).toBeInTheDocument();
      expect(screen.getByText('previous answer')).toBeInTheDocument();
    });
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes('/api/chat/sessions/sess-restored/messages'),
      ),
    ).toBe(true);
  });

  it('blocks sending an existing thread until history finishes loading', async () => {
    const user = userEvent.setup();
    writePersistedChatThread('proj-a', {
      sessionId: 'sess-history-pending',
      agentId: 'claude',
    });
    fetchChatThreadsMock.mockResolvedValue([
      {
        sessionId: 'sess-history-pending',
        agentId: 'claude',
        title: 'pending history',
        pinned: false,
        updatedAt: '2026-08-16T03:00:00.000Z',
      },
    ]);
    const messagesDeferred = createDeferred<Response>();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/chat/sessions/sess-history-pending/messages')) {
        return messagesDeferred.promise;
      }
      if (url === '/api/chat/message' && init?.method === 'POST') {
        return jsonResponse({
          reply: 'continued',
          sessionId: 'sess-history-pending',
          agentId: 'claude',
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });

    expect(await screen.findByText('履歴を読み込み中…')).toBeInTheDocument();
    const textarea = screen.getByLabelText('メッセージ');
    const submitButton = screen.getByRole('button', { name: '送信' });
    await user.type(textarea, 'continue this thread');
    expect(submitButton).toBeDisabled();
    fireEvent.submit(submitButton.closest('form')!);
    expect(getChatMessagePostCalls(fetchMock)).toHaveLength(0);

    messagesDeferred.resolve(
      jsonResponse({
        sessionId: 'sess-history-pending',
        agentId: 'claude',
        messages: [],
      }),
    );
    await waitFor(() => expect(submitButton).not.toBeDisabled());

    await user.click(submitButton);
    await waitFor(() => {
      expect(getChatMessagePostCalls(fetchMock)).toHaveLength(1);
    });
    expect(parseChatMessageBody(fetchMock).sessionId).toBe('sess-history-pending');
  });

  it('uses the persisted sessionId when existing thread history fails to load', async () => {
    const user = userEvent.setup();
    writePersistedChatThread('proj-a', {
      sessionId: 'sess-history-error',
      agentId: 'claude',
    });
    fetchChatThreadsMock.mockResolvedValue([
      {
        sessionId: 'sess-history-error',
        agentId: 'claude',
        title: 'history error',
        pinned: false,
        updatedAt: '2026-08-16T03:00:00.000Z',
      },
    ]);
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/chat/sessions/sess-history-error/messages')) {
        return jsonResponse({ error: 'history unavailable' }, 500);
      }
      if (url === '/api/chat/message' && init?.method === 'POST') {
        return jsonResponse({
          reply: 'continued after error',
          sessionId: 'sess-history-error',
          agentId: 'claude',
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });
    await waitFor(() => {
      expect(screen.queryByText('履歴を読み込み中…')).not.toBeInTheDocument();
    });

    await user.type(screen.getByLabelText('メッセージ'), 'retry this thread');
    await user.click(screen.getByRole('button', { name: '送信' }));
    await waitFor(() => {
      expect(getChatMessagePostCalls(fetchMock)).toHaveLength(1);
    });
    expect(parseChatMessageBody(fetchMock).sessionId).toBe('sess-history-error');
  });

  it('keeps the fallback sessionId on retry after a transient send failure (history 500 -> 409 -> retry)', async () => {
    // MF1 回帰: フォールバック (conversation 未定義 → currentSessionId) で送った
    // 1回目が 409 等の transient エラーになると、楽観的書き込みが sessionId 無しの
    // conversation エントリを作ってしまい、リトライが「clearSession 済み」と
    // 誤分類されて sessionId 無し POST でフォークしていた。楽観的書き込みで
    // 解決済み sessionId を会話に焼き込むことで、リトライも同一セッションに届く。
    const user = userEvent.setup();
    writePersistedChatThread('proj-a', {
      sessionId: 'sess-transient-retry',
      agentId: 'claude',
    });
    fetchChatThreadsMock.mockResolvedValue([
      {
        sessionId: 'sess-transient-retry',
        agentId: 'claude',
        title: 'transient retry',
        pinned: false,
        updatedAt: '2026-08-16T03:00:00.000Z',
      },
    ]);
    let postCount = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/chat/sessions/sess-transient-retry/messages')) {
        return jsonResponse({ error: 'history unavailable' }, 500);
      }
      if (url === '/api/chat/message' && init?.method === 'POST') {
        postCount += 1;
        if (postCount === 1) {
          return jsonResponse({ error: 'chat is busy for this project' }, 409);
        }
        return jsonResponse({
          reply: 'retried into same session',
          sessionId: 'sess-transient-retry',
          agentId: 'claude',
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });
    await waitFor(() => {
      expect(screen.queryByText('履歴を読み込み中…')).not.toBeInTheDocument();
    });

    await user.type(screen.getByLabelText('メッセージ'), 'first attempt');
    await user.click(screen.getByRole('button', { name: '送信' }));
    expect(
      await screen.findByText(CHAT_BUSY_HELP),
    ).toBeInTheDocument();
    expect(parseChatMessageBody(fetchMock, 0).sessionId).toBe('sess-transient-retry');

    await user.type(screen.getByLabelText('メッセージ'), 'second attempt');
    await user.click(screen.getByRole('button', { name: '送信' }));
    await screen.findByText('retried into same session');

    await waitFor(() => {
      expect(getChatMessagePostCalls(fetchMock)).toHaveLength(2);
    });
    expect(parseChatMessageBody(fetchMock, 1).sessionId).toBe('sess-transient-retry');
  });

  it('recovers into a fresh draft when history reports the session is gone (404)', async () => {
    // SF2a 回帰: 履歴 fetch が 404 / unknown chat session を返したとき、タブの
    // prune だけだと selectedThreadIds が死んだ id を指したまま残り、送信
    // フォールバックが既知の死亡 id で POST して 400 エラーになってしまう。
    // 選択も外してドラフトへ戻ることで、次の送信は sessionId 無しで新しい
    // セッションに silent に届く (サーバー側 eviction 後の自動回復)。
    const user = userEvent.setup();
    writePersistedChatThread('proj-a', {
      sessionId: 'sess-evicted',
      agentId: 'claude',
    });
    fetchChatThreadsMock.mockResolvedValue([
      {
        sessionId: 'sess-evicted',
        agentId: 'claude',
        title: 'evicted thread',
        pinned: false,
        updatedAt: '2026-08-16T03:00:00.000Z',
      },
    ]);
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/chat/sessions/sess-evicted/messages')) {
        return jsonResponse({ error: 'not found' }, 404);
      }
      if (url === '/api/chat/message' && init?.method === 'POST') {
        return jsonResponse({
          reply: 'fresh session reply',
          sessionId: 'sess-recovered',
          agentId: 'claude',
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });
    await waitFor(() => {
      expect(screen.queryByText('履歴を読み込み中…')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(
        screen.queryByRole('tab', { name: 'evicted thread' }),
      ).not.toBeInTheDocument();
    });

    await user.type(screen.getByLabelText('メッセージ'), 'start over');
    await user.click(screen.getByRole('button', { name: '送信' }));
    await screen.findByText('fresh session reply');

    await waitFor(() => {
      expect(getChatMessagePostCalls(fetchMock)).toHaveLength(1);
    });
    expect(parseChatMessageBody(fetchMock)).not.toHaveProperty('sessionId');
  });

  it('prunes the dead thread from threadLists and syncs the cleared selection to localStorage (bdboard-23u)', async () => {
    // bdboard-23u: 上のテストの SF2a 回帰に続く pbf デルタレビュー残 nit。
    // (1) threadLists からも死亡スレッドを prune しないと、「閉じたスレッドを
    //     開く」(threadLists 由来の reopen dropdown) から死亡スレッドを
    //     再選択でき、historyLoadedFor 済み扱いのため送信すると 400 になる。
    // (2) writePersistedChatThreadState を呼ばないと、localStorage に死亡した
    //     selectedSessionId が残り続ける (handleCloseThread との非一貫)。
    writePersistedChatThread('proj-a', {
      sessionId: 'sess-evicted-prune',
      agentId: 'claude',
    });
    fetchChatThreadsMock.mockResolvedValue([
      {
        sessionId: 'sess-evicted-prune',
        agentId: 'claude',
        title: 'evicted prune thread',
        pinned: false,
        updatedAt: '2026-08-16T03:00:00.000Z',
      },
    ]);
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/chat/sessions/sess-evicted-prune/messages')) {
        return jsonResponse({ error: 'not found' }, 404);
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });
    await waitFor(() => {
      expect(screen.queryByText('履歴を読み込み中…')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(
        screen.queryByRole('tab', { name: 'evicted prune thread' }),
      ).not.toBeInTheDocument();
    });

    // (1) threadLists からも prune 済みなので、候補が無くなり reopen dropdown
    // 自体が現れない。
    await waitFor(() => {
      expect(
        screen.queryByRole('combobox', { name: '閉じたスレッドを開く' }),
      ).not.toBeInTheDocument();
    });

    // (2) 開いているスレッドが無くなったので、writePersistedChatThreadState は
    // 永続化エントリごと削除する (activeSessionIds が空の書き込みは
    // chatThreadStorage の実装上、エントリ削除と等価)。
    expect(readPersistedChatThreads()['proj-a']).toBeUndefined();
  });

  it('advances the draft nonce during auto-recovery so a stale optimistic message does not resurface (bdboard-23u)', async () => {
    // bdboard-23u: このクリア処理が現在の draft nonce を再利用すると、
    // applyChatSuccess が re-key 元として消さずに残す旧・楽観的メッセージ
    // (同じ draftKey に残留) が、ドラフトへのフォールバックで再表示されて
    // しまう (最終タブ close と同根の既存の問題)。handleAgentChange と同じ
    // パターンで nonce を前進させることで、フォールバック先を新しい draftKey
    // にする。
    const user = userEvent.setup();
    writePersistedChatThread('proj-a', {
      sessionId: 'sess-parked',
      agentId: 'claude',
    });
    fetchChatThreadsMock.mockResolvedValue([
      {
        sessionId: 'sess-parked',
        agentId: 'claude',
        title: 'parked thread',
        pinned: false,
        updatedAt: '2026-08-16T03:00:00.000Z',
      },
      {
        sessionId: 'sess-evicted-orphan',
        agentId: 'claude',
        title: 'evicted orphan thread',
        pinned: false,
        updatedAt: '2026-08-16T03:00:00.000Z',
      },
    ]);
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/chat/sessions/sess-parked/messages')) {
        return jsonResponse({
          sessionId: 'sess-parked',
          agentId: 'claude',
          messages: [],
        });
      }
      if (url.startsWith('/api/chat/sessions/sess-evicted-orphan/messages')) {
        return jsonResponse({ error: 'not found' }, 404);
      }
      if (url === '/api/chat/message' && init?.method === 'POST') {
        return jsonResponse({
          reply: 'first reply',
          sessionId: 'sess-first',
          agentId: 'claude',
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });
    await waitFor(() => {
      expect(screen.queryByText('履歴を読み込み中…')).not.toBeInTheDocument();
    });

    // 唯一開いていた 'sess-parked' タブを閉じ、draft nonce 0 のドラフトへ
    // 落ちる (既存経路、今回の修正対象外)。
    await user.click(
      screen.getByRole('button', { name: 'スレッド「parked thread」を閉じる' }),
    );

    // nonce 0 のドラフトから送信し、新セッション 'sess-first' が確定する。
    // applyChatSuccess は旧 draftKey ('new:proj-a:0') のエントリを消さずに
    // 残すため、そこには「first message」の楽観的メッセージが孤児として残る。
    await user.type(screen.getByLabelText('メッセージ'), 'first message');
    await user.click(screen.getByRole('button', { name: '送信' }));
    await screen.findByText('first reply');

    // 「閉じたスレッドを開く」から、後で 404 する 'sess-evicted-orphan' を
    // 選択する。draft nonce はまだ 0 のまま進んでいない。
    await user.selectOptions(
      screen.getByRole('combobox', { name: '閉じたスレッドを開く' }),
      'sess-evicted-orphan',
    );

    // 404 による自動回復でドラフトへ戻る。修正前は同じ nonce 0 の draftKey
    // へ戻るため、上で送信した 'first message' が孤児として再表示されていた。
    await waitFor(() => {
      expect(
        screen.queryByRole('tab', { name: 'evicted orphan thread' }),
      ).not.toBeInTheDocument();
    });
    expect(
      within(screen.getByRole('log')).queryByText('first message'),
    ).not.toBeInTheDocument();
  });

  it('continues the same session after non-empty history is restored', async () => {
    // N1: 新ガード下の主経路 —「実際に履歴が復元された既存スレッド」からの送信が
    // 同一セッションの継続として届くこと (空履歴バリアントは上の blocking テスト)。
    const user = userEvent.setup();
    writePersistedChatThread('proj-a', {
      sessionId: 'sess-restored-history',
      agentId: 'claude',
    });
    fetchChatThreadsMock.mockResolvedValue([
      {
        sessionId: 'sess-restored-history',
        agentId: 'claude',
        title: 'restored history',
        pinned: false,
        updatedAt: '2026-08-16T03:00:00.000Z',
      },
    ]);
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/chat/sessions/sess-restored-history/messages')) {
        return jsonResponse({
          sessionId: 'sess-restored-history',
          agentId: 'claude',
          messages: [
            {
              role: 'user',
              content: '以前の質問',
              createdAt: '2026-08-16T02:00:00.000Z',
            },
            {
              role: 'assistant',
              content: '以前の回答',
              createdAt: '2026-08-16T02:00:05.000Z',
            },
          ],
        });
      }
      if (url === '/api/chat/message' && init?.method === 'POST') {
        return jsonResponse({
          reply: 'continued reply',
          sessionId: 'sess-restored-history',
          agentId: 'claude',
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });
    expect(await screen.findByText('以前の回答')).toBeInTheDocument();

    await user.type(screen.getByLabelText('メッセージ'), 'continue please');
    await user.click(screen.getByRole('button', { name: '送信' }));
    await screen.findByText('continued reply');

    await waitFor(() => {
      expect(getChatMessagePostCalls(fetchMock)).toHaveLength(1);
    });
    expect(parseChatMessageBody(fetchMock).sessionId).toBe('sess-restored-history');
  });

  it('reconstructs the failed-tools warning banner purely from restored history on reload (bdboard-ftn)', async () => {
    writePersistedChatThread('proj-a', {
      sessionId: 'sess-restored-failed-tools',
      agentId: 'claude',
    });
    fetchChatThreadsMock.mockResolvedValue([
      {
        sessionId: 'sess-restored-failed-tools',
        agentId: 'claude',
        title: 'restored',
        pinned: false,
        updatedAt: '2026-08-16T03:00:00.000Z',
      },
    ]);
    fetchChatAgentsMock.mockResolvedValue([CLAUDE_AGENT]);
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (
        url.startsWith('/api/chat/sessions/sess-restored-failed-tools/messages') &&
        (init?.method ?? 'GET') === 'GET'
      ) {
        return jsonResponse({
          sessionId: 'sess-restored-failed-tools',
          agentId: 'claude',
          messages: [
            {
              role: 'user',
              content: 'previous question',
              createdAt: '2026-08-16T03:00:00.000Z',
            },
            {
              role: 'assistant',
              content: 'previous answer',
              createdAt: '2026-08-16T03:00:01.000Z',
              failedTools: ['bd_ready'],
            },
          ],
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });

    await waitFor(() => {
      expect(screen.getByText('previous answer')).toBeInTheDocument();
    });
    expect(
      await screen.findByText('一部のツール呼び出しが実行できませんでした: bd_ready'),
    ).toBeInTheDocument();
  });

  it('reconstructs the agent-warnings banner purely from restored history on reload (bdboard-l1t.6 N-e)', async () => {
    writePersistedChatThread('proj-a', {
      sessionId: 'sess-restored-agent-warnings',
      agentId: 'agy',
    });
    fetchChatThreadsMock.mockResolvedValue([
      {
        sessionId: 'sess-restored-agent-warnings',
        agentId: 'agy',
        title: 'restored',
        pinned: false,
        updatedAt: '2026-08-16T03:00:00.000Z',
      },
    ]);
    fetchChatAgentsMock.mockResolvedValue([AGY_AGENT]);
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (
        url.startsWith('/api/chat/sessions/sess-restored-agent-warnings/messages') &&
        (init?.method ?? 'GET') === 'GET'
      ) {
        return jsonResponse({
          sessionId: 'sess-restored-agent-warnings',
          agentId: 'agy',
          messages: [
            {
              role: 'user',
              content: 'previous question',
              createdAt: '2026-08-16T03:00:00.000Z',
            },
            {
              role: 'assistant',
              content: 'previous partial answer',
              createdAt: '2026-08-16T03:00:01.000Z',
              agentWarnings: [
                'headless auto-deny: some tool call(s) were soft-denied mid-turn',
              ],
            },
          ],
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });

    await waitFor(() => {
      expect(screen.getByText('previous partial answer')).toBeInTheDocument();
    });
    expect(
      await screen.findByText(
        'エージェントの警告: headless auto-deny: some tool call(s) were soft-denied mid-turn',
      ),
    ).toBeInTheDocument();
  });

  it('does not leave the history spinner visible after switching projects during a pending fetch', async () => {
    const user = userEvent.setup();
    writePersistedChatThread('proj-a', {
      sessionId: 'sess-pending-a',
      agentId: 'claude',
    });
    fetchChatThreadsMock.mockImplementation((projectId) => Promise.resolve(
      projectId === 'proj-a'
        ? [{ sessionId: 'sess-pending-a', agentId: 'claude', title: 'pending', pinned: false, updatedAt: '2026-08-16T03:00:00.000Z' }]
        : [],
    ));
    fetchChatAgentsMock.mockResolvedValue([CLAUDE_AGENT]);

    const deferred = createDeferred<Response>();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (
        url.startsWith('/api/chat/sessions/sess-pending-a/messages') &&
        (init?.method ?? 'GET') === 'GET'
      ) {
        return deferred.promise;
      }
      if (url === '/api/chat/message' && init?.method === 'POST') {
        return jsonResponse({
          reply: 'AI reply',
          sessionId: 'sess-default',
          agentId: 'claude',
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A, PROJECT_B], { initialProjectId: 'proj-a' });

    expect(await screen.findByText('履歴を読み込み中…')).toBeInTheDocument();

    await user.selectOptions(
      screen.getByLabelText('対象プロジェクト'),
      'proj-b',
    );

    expect(screen.queryByText('履歴を読み込み中…')).not.toBeInTheDocument();
    expect(screen.getByText('まだメッセージはありません')).toBeInTheDocument();

    deferred.resolve(
      jsonResponse({
        sessionId: 'sess-pending-a',
        agentId: 'claude',
        messages: [
          {
            role: 'user',
            content: 'stale history',
            createdAt: '2026-08-16T03:00:00.000Z',
          },
        ],
      }),
    );

    await waitFor(() => {
      expect(screen.queryByText('履歴を読み込み中…')).not.toBeInTheDocument();
    });
    expect(screen.queryByText('stale history')).not.toBeInTheDocument();
  });

  it('does not apply stale history agentId to agent selection after switching projects during a pending fetch', async () => {
    const user = userEvent.setup();
    writePersistedChatThread('proj-a', {
      sessionId: 'sess-pending-a',
      agentId: 'claude',
    });
    fetchChatThreadsMock.mockImplementation((projectId) => Promise.resolve(
      projectId === 'proj-a'
        ? [{ sessionId: 'sess-pending-a', agentId: 'claude', title: 'pending', pinned: false, updatedAt: '2026-08-16T03:00:00.000Z' }]
        : [],
    ));
    fetchChatAgentsMock.mockResolvedValue([CLAUDE_AGENT, EXAMPLE_AGENT]);

    const deferred = createDeferred<Response>();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (
        url.startsWith('/api/chat/sessions/sess-pending-a/messages') &&
        (init?.method ?? 'GET') === 'GET'
      ) {
        return deferred.promise;
      }
      if (url === '/api/chat/message' && init?.method === 'POST') {
        return jsonResponse({
          reply: 'AI reply',
          sessionId: 'sess-default',
          agentId: 'claude',
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A, PROJECT_B], { initialProjectId: 'proj-a' });

    expect(await screen.findByText('履歴を読み込み中…')).toBeInTheDocument();

    await user.selectOptions(
      screen.getByLabelText('対象プロジェクト'),
      'proj-b',
    );

    const agentSelect = await screen.findByLabelText('チャットエージェント');
    await user.selectOptions(agentSelect, 'example-agent');
    expect(agentSelect).toHaveValue('example-agent');

    deferred.resolve(
      jsonResponse({
        sessionId: 'sess-pending-a',
        agentId: 'claude',
        messages: [
          {
            role: 'user',
            content: 'stale history',
            createdAt: '2026-08-16T03:00:00.000Z',
          },
        ],
      }),
    );

    await waitFor(() => {
      expect(screen.queryByText('履歴を読み込み中…')).not.toBeInTheDocument();
    });
    expect(agentSelect).toHaveValue('example-agent');
    expect(screen.queryByText('stale history')).not.toBeInTheDocument();
  });

  it('keeps agent selection and clears persisted thread when switching agents during a pending history fetch', async () => {
    const user = userEvent.setup();
    writePersistedChatThread('proj-a', {
      sessionId: 'sess-pending-agent',
      agentId: 'claude',
    });
    fetchChatThreadsMock.mockResolvedValue([
      { sessionId: 'sess-pending-agent', agentId: 'claude', title: 'pending', pinned: false, updatedAt: '2026-08-16T03:00:00.000Z' },
    ]);
    fetchChatAgentsMock.mockResolvedValue([CLAUDE_AGENT, EXAMPLE_AGENT]);

    const deferred = createDeferred<Response>();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (
        url.startsWith('/api/chat/sessions/sess-pending-agent/messages') &&
        (init?.method ?? 'GET') === 'GET'
      ) {
        return deferred.promise;
      }
      if (url === '/api/chat/message' && init?.method === 'POST') {
        return jsonResponse({
          reply: 'AI reply',
          sessionId: 'sess-default',
          agentId: 'claude',
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });
    const agentSelect = await screen.findByLabelText('チャットエージェント');
    expect(await screen.findByText('履歴を読み込み中…')).toBeInTheDocument();

    await user.selectOptions(agentSelect, 'example-agent');
    expect(agentSelect).toHaveValue('example-agent');
    expect(readPersistedChatThreads()).toEqual({});

    deferred.resolve(
      jsonResponse({
        sessionId: 'sess-pending-agent',
        agentId: 'claude',
        messages: [
          {
            role: 'user',
            content: 'history from claude session',
            createdAt: '2026-08-16T03:00:00.000Z',
          },
        ],
      }),
    );

    await waitFor(() => {
      expect(screen.queryByText('履歴を読み込み中…')).not.toBeInTheDocument();
    });
    expect(agentSelect).toHaveValue('example-agent');
    expect(screen.queryByText('history from claude session')).not.toBeInTheDocument();
    expect(readPersistedChatThreads()).toEqual({});
  });

  describe('resuming a discovered CLI session (bdboard-3tw.104.3 レビュー M1/M2/S3/S4)', () => {
    function mockAdoptResponse(
      fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
    ) {
      fetchMock.mockImplementation(fetchImpl);
    }

    it('seeds the conversation from seedMessages and skips the ChatMessageRepository fetch', async () => {
      const user = userEvent.setup();
      fetchChatAgentsMock.mockResolvedValue([CLAUDE_AGENT]);
      fetchDiscoveredChatSessionsMock.mockResolvedValue({
        sessions: [
          {
            sessionId: 'discovered-1',
            lastActivityAt: '2026-08-16T12:00:00.000Z',
            alreadyAdopted: false,
          },
        ],
      });
      mockAdoptResponse(async (url: string, init?: RequestInit) => {
        if (
          url === '/api/chat/projects/proj-a/discovered-sessions/discovered-1/adopt' &&
          init?.method === 'POST'
        ) {
          return jsonResponse({
            sessionId: 'discovered-1',
            agentId: 'claude',
            seedMessages: [
              { role: 'user', text: 'seeded question', timestamp: '2026-08-16T11:00:00.000Z' },
              { role: 'assistant', text: 'seeded answer', timestamp: '2026-08-16T11:00:01.000Z' },
            ],
          });
        }
        if (url === '/api/chat/message' && init?.method === 'POST') {
          return jsonResponse({ reply: 'AI reply', sessionId: 'discovered-1', agentId: 'claude' });
        }
        throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
      });

      renderChatPanel([PROJECT_A]);

      await user.click(screen.getByRole('button', { name: 'CLIセッションを再開' }));
      await user.click(await screen.findByRole('button', { name: 'セッション discovered-1 を再開' }));

      // 履歴シードは adopt レスポンス同梱の seedMessages から反映される (M1)。
      expect(await screen.findByText('seeded question')).toBeInTheDocument();
      expect(screen.getByText('seeded answer')).toBeInTheDocument();

      // selectedThreadIds が新セッションIDへ retarget され、タブが選択状態になる (S3)。
      const tabs = screen.getAllByRole('tab');
      expect(tabs).toHaveLength(1);
      expect(tabs[0]).toHaveAttribute('aria-selected', 'true');

      // openThreadIds に新セッションIDが加わり、writePersistedChatThreadState の
      // ペイロードが activeSessionIds/selectedSessionId とも正しい (S3/S4)。
      expect(readPersistedChatThreads()).toEqual({
        'proj-a': { activeSessionIds: ['discovered-1'], selectedSessionId: 'discovered-1' },
      });

      // historyLoadedFor が抑止され、通常の ChatMessageRepository 経由の履歴読み込み
      // (GET /api/chat/sessions/discovered-1/messages) は一度も呼ばれない (S3)。
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes('/api/chat/sessions/discovered-1/messages'),
        ),
      ).toBe(false);
    });

    it('falls back to an explanatory note when seedMessages is empty', async () => {
      const user = userEvent.setup();
      fetchChatAgentsMock.mockResolvedValue([CLAUDE_AGENT]);
      fetchDiscoveredChatSessionsMock.mockResolvedValue({
        sessions: [
          {
            sessionId: 'discovered-2',
            lastActivityAt: '2026-08-16T12:00:00.000Z',
            alreadyAdopted: false,
          },
        ],
      });
      mockAdoptResponse(async (url: string, init?: RequestInit) => {
        if (
          url === '/api/chat/projects/proj-a/discovered-sessions/discovered-2/adopt' &&
          init?.method === 'POST'
        ) {
          return jsonResponse({ sessionId: 'discovered-2', agentId: 'claude', seedMessages: [] });
        }
        throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
      });

      renderChatPanel([PROJECT_A]);

      await user.click(screen.getByRole('button', { name: 'CLIセッションを再開' }));
      await user.click(await screen.findByRole('button', { name: 'セッション discovered-2 を再開' }));

      expect(
        await screen.findByText(
          'このCLIセッションの直近の会話をここに表示できませんでした。続きから会話できます。',
        ),
      ).toBeInTheDocument();
    });

    it('does not let a late-resolving history fetch for the same sessionId overwrite a just-resumed conversation (bdboard-2n8 should-fix)', async () => {
      // resume 対象のセッションIDが、既に選択中で履歴フェッチが in-flight な
      // スレッドと同じ場合、currentConversationKey 自体は変わらない。
      // handleResumeDiscoveredSession が historyRequestIdRef を進めないと、
      // 後から解決するその古い履歴フェッチが resume 直後の seeded conversation /
      // agentId を上書きしてしまう。
      const user = userEvent.setup();
      writePersistedChatThread('proj-a', {
        sessionId: 'sess-dup',
        agentId: 'claude',
      });
      fetchChatThreadsMock.mockResolvedValue([
        {
          sessionId: 'sess-dup',
          agentId: 'claude',
          title: 'existing',
          pinned: false,
          updatedAt: '2026-08-16T03:00:00.000Z',
        },
      ]);
      fetchChatAgentsMock.mockResolvedValue([CLAUDE_AGENT, EXAMPLE_AGENT]);
      fetchDiscoveredChatSessionsMock.mockResolvedValue({
        sessions: [
          {
            sessionId: 'sess-dup',
            lastActivityAt: '2026-08-16T12:00:00.000Z',
            alreadyAdopted: true,
          },
        ],
      });

      const messagesDeferred = createDeferred<Response>();
      mockAdoptResponse(async (url: string, init?: RequestInit) => {
        if (
          url.startsWith('/api/chat/sessions/sess-dup/messages') &&
          (init?.method ?? 'GET') === 'GET'
        ) {
          return messagesDeferred.promise;
        }
        if (
          url === '/api/chat/projects/proj-a/discovered-sessions/sess-dup/adopt' &&
          init?.method === 'POST'
        ) {
          return jsonResponse({
            sessionId: 'sess-dup',
            agentId: 'example-agent',
            seedMessages: [
              { role: 'user', text: 'resumed question', timestamp: '2026-08-16T11:00:00.000Z' },
            ],
          });
        }
        throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
      });

      renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });

      await waitFor(() => {
        expect(
          fetchMock.mock.calls.some(
            ([url, init]) =>
              String(url).startsWith('/api/chat/sessions/sess-dup/messages') &&
              ((init as RequestInit | undefined)?.method ?? 'GET') === 'GET',
          ),
        ).toBe(true);
      });
      expect(await screen.findByText('履歴を読み込み中…')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'CLIセッションを再開' }));
      await user.click(await screen.findByRole('button', { name: 'セッション sess-dup を再開' }));

      expect(await screen.findByText('resumed question')).toBeInTheDocument();
      expect(screen.getByLabelText('チャットエージェント')).toHaveValue('example-agent');

      // 元の(古い)履歴フェッチが今さら解決し、別内容・別エージェントを返す。
      messagesDeferred.resolve(
        jsonResponse({
          sessionId: 'sess-dup',
          agentId: 'claude',
          messages: [
            { role: 'user', content: 'stale history', createdAt: '2026-08-16T03:00:00.000Z' },
          ],
        }),
      );

      // resolve 後の状態が安定するまで少し待ってから確認する(見えない失敗を
      // waitFor の即時解決で見逃さないため)。
      await waitFor(() => {
        expect(screen.queryByText('履歴を読み込み中…')).not.toBeInTheDocument();
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(screen.getByText('resumed question')).toBeInTheDocument();
      expect(screen.queryByText('stale history')).not.toBeInTheDocument();
      expect(screen.getByLabelText('チャットエージェント')).toHaveValue('example-agent');
    });
  });

  describe('quick commands', () => {
    it('renders quick command chips above the message input', () => {
      renderChatPanel([PROJECT_A], { leaveSettingsCollapsed: true });
      expect(screen.getByRole('group', { name: 'クイックコマンド' })).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'ready一覧を入力欄に挿入' }),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'チケット相談を入力欄に挿入' })).toBeInTheDocument();
    });

    it('prefills the input (without sending) when a quick command chip is tapped', async () => {
      const user = userEvent.setup();
      renderChatPanel([PROJECT_A], { leaveSettingsCollapsed: true });
      await user.click(screen.getByRole('button', { name: 'ready一覧を入力欄に挿入' }));

      const textarea = screen.getByLabelText<HTMLTextAreaElement>('メッセージ');
      const expected = '着手可能(ready)なチケットを一覧し、優先度が高い順に要約してください。';
      expect(textarea).toHaveValue(expected);
      await waitFor(() => {
        expect(textarea.selectionStart).toBe(expected.length);
        expect(textarea.selectionEnd).toBe(expected.length);
      });
      // 誤タップでそのまま送信されないことを確認する(bdboard-3tw.133)。
      expect(getChatMessagePostCalls(fetchMock)).toHaveLength(0);
    });

    it('prefills the input when the free-text quick command chip is tapped', async () => {
      const user = userEvent.setup();
      renderChatPanel([PROJECT_A], { leaveSettingsCollapsed: true });
      await user.click(screen.getByRole('button', { name: 'チケット相談を入力欄に挿入' }));

      const textarea = screen.getByLabelText<HTMLTextAreaElement>('メッセージ');
      expect(textarea).toHaveValue('次のチケットについて: ');
      await waitFor(() => {
        expect(textarea.selectionStart).toBe('次のチケットについて: '.length);
        expect(textarea.selectionEnd).toBe('次のチケットについて: '.length);
      });
      expect(getChatMessagePostCalls(fetchMock)).toHaveLength(0);
    });

    it('disables quick command chips while sending', async () => {
      const user = userEvent.setup();
      const deferred = createDeferred<Response>();
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === '/api/chat/message' && init?.method === 'POST') {
          return deferred.promise;
        }
        throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
      });

      renderChatPanel([PROJECT_A], { leaveSettingsCollapsed: true });
      await user.type(screen.getByLabelText('メッセージ'), 'hold');
      await user.click(screen.getByRole('button', { name: '送信' }));

      expect(
        screen.getByRole('button', { name: 'ready一覧を入力欄に挿入' }),
      ).toBeDisabled();
    });
  });
});
