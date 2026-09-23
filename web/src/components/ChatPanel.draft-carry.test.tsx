// bdboard-sso1.83 第5段: ChatPanel.test.tsx から move-only で切り出したファイル
// (ChatPanel.draft-carry.test.tsx)。手本: sso1.85 の HygienePanel 分割。テスト本体・期待値・文言は
// 1文字も変えていない。共有の fixture/render ヘルパーは ChatPanel-test-support.tsx
// から import する。vi.mock はファイル単位でホイストされるため、元ファイルの
// vi.mock('../api', ...) ブロックと beforeEach/afterEach をこのファイルにも複製している。

import { StrictMode } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatAgentDto, ChatThreadDto, ChatTurnStatusDto } from '../api';
import { installFakeHistory } from '../test/fakeHistory';
import { writePersistedChatThread } from '../chatThreadStorage';
import { ChatPanel } from './ChatPanel';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    fetchChatAgents: vi.fn(() => Promise.resolve<ChatAgentDto[]>([])),
    fetchChatThreads: vi.fn(() => Promise.resolve<ChatThreadDto[]>([])),
    fetchChatTurnStatus: vi.fn(() => Promise.resolve<ChatTurnStatusDto>({ state: 'idle' })),
    acknowledgeChatTurn: vi.fn(() => Promise.resolve()),
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
    fetchPlatformSupport: vi.fn(() => Promise.resolve({ platform: 'darwin', limitations: [] })),
  };
});

import {
  fetchChatAgents,
  fetchChatThreads,
  fetchChatTurnStatus,
  acknowledgeChatTurn,
  deleteChatThread,
  updateChatThread,
  fetchPlatformSupport,
} from '../api';
import { resetPlatformSupportCache } from './PlatformLimitationNotice';

const fetchChatAgentsMock = vi.mocked(fetchChatAgents);
const fetchChatThreadsMock = vi.mocked(fetchChatThreads);
const fetchChatTurnStatusMock = vi.mocked(fetchChatTurnStatus);
const acknowledgeChatTurnMock = vi.mocked(acknowledgeChatTurn);
const deleteChatThreadMock = vi.mocked(deleteChatThread);
const updateChatThreadMock = vi.mocked(updateChatThread);
const fetchPlatformSupportMock = vi.mocked(fetchPlatformSupport);
const defaultWindowInnerWidth = window.innerWidth;

import {
  makeProjectDto,
  PROJECT_A,
  PROJECT_B,
  CLAUDE_AGENT,
  EXAMPLE_AGENT,
  createDeferred,
  jsonResponse,
  openChatSettings,
  openThreadDrawer,
  getThreadDrawer,
  selectThreadFromDrawer,
  openThreadDrawerItemMenu,
  renderChatPanel,
} from './ChatPanel-test-support';

describe('ChatPanel', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    installFakeHistory({});
    localStorage.clear();
    resetPlatformSupportCache();
    fetchPlatformSupportMock.mockResolvedValue({ platform: 'darwin', limitations: [] });
    fetchChatAgentsMock.mockResolvedValue([]);
    fetchChatThreadsMock.mockResolvedValue([]);
    fetchChatTurnStatusMock.mockResolvedValue({ state: 'idle' });
    acknowledgeChatTurnMock.mockResolvedValue();
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
    vi.resetAllMocks();
    vi.restoreAllMocks();
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

  it('leaves the project unselected when the ticket project is missing from the list (deadlock regression)', async () => {
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
      expect(screen.getByLabelText('対象プロジェクト')).toHaveValue('');
    });
    expect(fetchChatThreadsMock).not.toHaveBeenCalledWith(PROJECT_A.id);
    expect(screen.getByLabelText('メッセージ')).toHaveValue('proj-missing のチケットについて: ');
  });

  it('shows project select and hint when only one unrelated project arrives for a missing ticket project (major-1 regression)', async () => {
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([CLAUDE_AGENT]);
    const rendered = renderChatPanel([], {
      initialProjectId: 'proj-missing',
      initialInput: 'proj-missing のチケットについて: ',
      ticketContextToken: 1,
    });

    rendered.rerender(
      <ChatPanel
        projects={[PROJECT_A]}
        initialProjectId="proj-missing"
        initialInput="proj-missing のチケットについて: "
        ticketContextToken={1}
        isTicketOnBoard={rendered.isTicketOnBoard}
        onOpenTicket={rendered.onOpenTicket}
        onClose={rendered.onClose}
      />,
    );

    expect(screen.getByLabelText('対象プロジェクト')).toHaveValue('');
    expect(
      screen.getByText('送信先のプロジェクトを選んでください。選ぶまで送信できません。'),
    ).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('対象プロジェクト'), PROJECT_A.id);
    expect(screen.getByRole('button', { name: '送信' })).toBeEnabled();
  });

  it('shows a notice when the ticket project is missing and no project is selected', async () => {
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
      expect(notice).toHaveTextContent('見つかりません');
    });
    expect(
      screen.getByText('送信先のプロジェクトを選んでください。選ぶまで送信できません。'),
    ).toBeInTheDocument();
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
      ).toHaveTextContent('見つかりません');
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
    expect(screen.getByLabelText('対象プロジェクト')).toHaveValue('');
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

    const { container } = renderChatPanel([PROJECT_A], {
      initialProjectId: 'proj-a',
      initialInput: 'bdboard-x.1 について: ',
      ticketContextToken: 1,
    });

    openThreadDrawer(container);
    expect(
      await within(getThreadDrawer(container)).findByRole('button', { name: '既存スレッド' }),
    ).toBeInTheDocument();
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

    const { container } = renderChatPanel([PROJECT_A]);
    openThreadDrawer(container);
    expect(
      await within(getThreadDrawer(container)).findByRole('button', { name: '既存スレッド' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '新しい空のスレッドを開始' }));
    await user.type(screen.getByLabelText('メッセージ'), '書きかけのドラフト');
    await selectThreadFromDrawer(container, user, '既存スレッド');
    expect(screen.getByLabelText('メッセージ')).toHaveValue('');

    const menu = await openThreadDrawerItemMenu(container, user, '既存スレッド');
    await user.click(within(menu).getByRole('menuitem', { name: /タブから閉じる/ }));
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

    const { container } = renderChatPanel([PROJECT_A]);
    openThreadDrawer(container);
    await within(getThreadDrawer(container)).findByRole('button', { name: 'first thread' });
    await user.type(screen.getByLabelText('メッセージ'), 'first draft');
    await selectThreadFromDrawer(container, user, 'second thread');
    await user.type(screen.getByLabelText('メッセージ'), 'second draft');
    await user.click(screen.getByRole('button', { name: '送信' }));

    await screen.findByText('送信成功');
    expect(screen.getByLabelText('メッセージ')).toHaveValue('');
    await selectThreadFromDrawer(container, user, 'first thread');
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

    const { container } = renderChatPanel([PROJECT_A]);
    await user.type(screen.getByLabelText('メッセージ'), 'first message');
    await user.click(screen.getByRole('button', { name: '送信' }));
    await screen.findByText('reply');
    expect(screen.getByLabelText('メッセージ')).toHaveValue('');

    const menu = await openThreadDrawerItemMenu(container, user, 'first message');
    await user.click(within(menu).getByRole('menuitem', { name: /タブから閉じる/ }));
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
    const { container } = rendered;
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

    openThreadDrawer(container);
    expect(
      await within(getThreadDrawer(container)).findByRole('button', { name: '既存スレッド' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('保持される履歴')).not.toBeInTheDocument();
    await selectThreadFromDrawer(container, userEvent.setup(), '既存スレッド');
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
    const { container } = rendered;
    openThreadDrawer(container);
    expect(
      await within(getThreadDrawer(container)).findByRole('button', { name: '既存スレッド' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('メッセージ')).toHaveValue('最初のチケット: ');

    // N6: 1回目のドラフトから既存スレッドへ手動で切り替え、選択状態を作ってから
    // 2回目のチケット起動を投げる。これにより「2回目のトークンが既存スレッドの
    // 選択を確実に上書きする」ことを、単なる新規ドラフトの初期状態(元々
    // 未選択)ではなく、実際に選択済みだった状態からの遷移として検証できる。
    await selectThreadFromDrawer(container, user, '既存スレッド');
    openThreadDrawer(container);
    expect(
      within(getThreadDrawer(container)).getByRole('button', { name: '既存スレッド' }),
    ).toHaveAttribute('aria-current', 'true');

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
    openThreadDrawer(container);
    expect(
      within(getThreadDrawer(container)).getByRole('button', { name: '既存スレッド' }),
    ).not.toHaveAttribute('aria-current');
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
    const { container } = rendered;
    openThreadDrawer(container);
    expect(
      await within(getThreadDrawer(container)).findByRole('button', { name: 'B既存スレッド' }),
    ).toBeInTheDocument();

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
    openThreadDrawer(container);
    expect(
      await within(getThreadDrawer(container)).findByRole('button', { name: 'B既存スレッド' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('B既存の履歴')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(
        within(getThreadDrawer(container)).getByRole('button', { name: 'B既存スレッド' }),
      ).not.toHaveAttribute('aria-current');
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
    const { container } = rendered;
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

    openThreadDrawer(container);
    await within(getThreadDrawer(container)).findByRole('button', { name: 'B既存スレッド' });
    await waitFor(() => {
      expect(
        within(getThreadDrawer(container)).getByRole('button', { name: 'B既存スレッド' }),
      ).toHaveAttribute('aria-current', 'true');
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
    const { container } = renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });
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

    openThreadDrawer(container);
    await within(getThreadDrawer(container)).findByRole('button', { name: '既存スレッド' });
    await waitFor(() => {
      expect(
        within(getThreadDrawer(container)).getByRole('button', { name: '既存スレッド' }),
      ).not.toHaveAttribute('aria-current');
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

    const { container } = renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });

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

    openThreadDrawer(container);
    await within(getThreadDrawer(container)).findByRole('button', { name: '既存スレッド' });
    await waitFor(() => {
      expect(
        within(getThreadDrawer(container)).getByRole('button', { name: '既存スレッド' }),
      ).toHaveAttribute('aria-current', 'true');
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

    const { container } = renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });
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

    openThreadDrawer(container);
    await within(getThreadDrawer(container)).findByRole('button', { name: '既存スレッド' });
    await waitFor(() => {
      expect(
        within(getThreadDrawer(container)).getByRole('button', { name: '既存スレッド' }),
      ).not.toHaveAttribute('aria-current');
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

    const { container } = renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });
    await user.click(screen.getByRole('button', { name: '新しい空のスレッドを開始' }));
    expect(screen.getByLabelText('メッセージ')).toHaveValue('');

    deferred.reject(new Error('boom'));

    await waitFor(() => {
      expect(screen.getByText('スレッド一覧の取得に失敗しました。')).toBeInTheDocument();
    });
    openThreadDrawer(container);
    const draftButton = within(getThreadDrawer(container)).getByRole('button', { name: '(無題)' });
    expect(draftButton).not.toHaveAttribute('aria-current');
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
    const { container } = rendered;

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

    openThreadDrawer(container);
    await within(getThreadDrawer(container)).findByRole('button', { name: '既存スレッド' });
    await waitFor(() => {
      expect(
        within(getThreadDrawer(container)).getByRole('button', { name: '既存スレッド' }),
      ).not.toHaveAttribute('aria-current');
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

    const { container } = renderChatPanel([PROJECT_A, PROJECT_B], { initialProjectId: 'proj-a' });

    // A の最初の fetch が(既存スレッドで)解決してから、明示的に「新規
    // スレッド」を押す — in-flight 中ではなく、既に fetch が片付いた後の
    // 明示操作であることが sticky 判定を確認するうえで重要。
    openThreadDrawer(container);
    await within(getThreadDrawer(container)).findByRole('button', { name: '既存スレッド' });
    await user.click(screen.getByRole('button', { name: '新しい空のスレッドを開始' }));
    expect(screen.getByLabelText('メッセージ')).toHaveValue('');

    // スレッドを選び直さないまま B へ離脱する。
    await user.selectOptions(screen.getByLabelText('対象プロジェクト'), 'proj-b');

    // A へ戻る → 新しい fetch(A) が発火し、既存スレッドで解決する。
    await user.selectOptions(screen.getByLabelText('対象プロジェクト'), 'proj-a');

    openThreadDrawer(container);
    await within(getThreadDrawer(container)).findByRole('button', { name: '既存スレッド' });
    await waitFor(() => {
      expect(
        within(getThreadDrawer(container)).getByRole('button', { name: '既存スレッド' }),
      ).not.toHaveAttribute('aria-current');
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

    openThreadDrawer(view.container);
    expect(
      await within(getThreadDrawer(view.container)).findByRole('button', { name: '既存スレッド' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('メッセージ')).toHaveValue('bdboard-x.1 について: ');
    expect(screen.queryByText('既存の履歴')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(
        within(getThreadDrawer(view.container)).getByRole('button', { name: '既存スレッド' }),
      ).not.toHaveAttribute('aria-current');
    });
  });
});
