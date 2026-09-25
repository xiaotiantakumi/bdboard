// bdboard-sso1.83 第5段: ChatPanel.test.tsx から move-only で切り出したファイル
// (ChatPanel.thread-ops-and-messages.test.tsx)。手本: sso1.85 の HygienePanel 分割。テスト本体・期待値・文言は
// 1文字も変えていない。共有の fixture/render ヘルパーは ChatPanel-test-support.tsx
// から import する。vi.mock はファイル単位でホイストされるため、元ファイルの
// vi.mock('../api', ...) ブロックと beforeEach/afterEach をこのファイルにも複製している。

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatAgentDto, ChatThreadDto, ChatTurnStatusDto } from '../api';
import { installFakeHistory } from '../test/fakeHistory';
import { CHAT_BUSY_HELP } from '../writeAccessMessage';

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
  PROJECT_A,
  PROJECT_B,
  createDeferred,
  jsonResponse,
  getChatMessagePostCalls,
  parseChatMessageBody,
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
    // bdboard-1ga8 と同じ作法: モックを reset する前にアンマウントし、E8 のポーリングが
    // 次のテストへ持ち越されないようにする。
    try {
      cleanup();
    } finally {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: defaultWindowInnerWidth,
      });
      vi.unstubAllGlobals();
      vi.resetAllMocks();
      vi.restoreAllMocks();
    }
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
    const { container } = renderChatPanel([PROJECT_A]);

    expect(await screen.findByText('one')).toBeInTheDocument();
    await selectThreadFromDrawer(container, user, 'second thread');
    expect(await screen.findByText('two')).toBeInTheDocument();

    let menu = await openThreadDrawerItemMenu(container, user, 'second thread');
    await user.click(within(menu).getByRole('menuitem', { name: /タブから閉じる/ }));
    openThreadDrawer(container);
    // タブから閉じても削除はされない。「開いているスレッド」からは外れ、
    // 「閉じたスレッド」の行として引き続き見える(chat-thread-drawer-item-closed)。
    expect(
      within(getThreadDrawer(container)).getByText('second thread').closest('.chat-thread-drawer-item'),
    ).toHaveClass('chat-thread-drawer-item-closed');
    expect(deleteChatThreadMock).not.toHaveBeenCalled();

    menu = await openThreadDrawerItemMenu(container, user, 'first thread');
    await user.click(within(menu).getByRole('menuitem', { name: '削除' }));
    expect(deleteChatThreadMock).not.toHaveBeenCalled();

    menu = await openThreadDrawerItemMenu(container, user, 'first thread');
    await user.click(within(menu).getByRole('menuitem', { name: '本当に削除' }));
    await waitFor(() => expect(deleteChatThreadMock).toHaveBeenCalledWith('sess-1', 'proj-a'));
    openThreadDrawer(container);
    expect(within(getThreadDrawer(container)).queryByRole('button', { name: 'first thread' })).not.toBeInTheDocument();
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
    const { container } = renderChatPanel([PROJECT_A]);

    let menu = await openThreadDrawerItemMenu(container, user, 'first thread');
    await user.click(within(menu).getByRole('menuitem', { name: 'リネーム' }));

    const renameInput = screen.getByLabelText('スレッド「first thread」の新しいタイトル');
    await user.clear(renameInput);
    await user.type(renameInput, 'renamed thread');
    fireEvent.blur(renameInput);

    await waitFor(() =>
      expect(updateChatThreadMock).toHaveBeenCalledWith('sess-1', 'proj-a', { title: 'renamed thread' }),
    );
    openThreadDrawer(container);
    expect(
      await within(getThreadDrawer(container)).findByRole('button', { name: 'renamed thread' }),
    ).toBeInTheDocument();

    menu = await openThreadDrawerItemMenu(container, user, 'renamed thread');
    await user.click(within(menu).getByRole('menuitem', { name: 'リネーム' }));
    const clearInput = screen.getByLabelText('スレッド「renamed thread」の新しいタイトル');
    await user.clear(clearInput);
    fireEvent.blur(clearInput);

    await waitFor(() =>
      expect(updateChatThreadMock).toHaveBeenCalledWith('sess-1', 'proj-a', { title: null }),
    );
  });

  it('cancels an inline thread rename via Escape without saving (bdboard-sso1.83)', async () => {
    const user = userEvent.setup();
    fetchChatThreadsMock.mockResolvedValue([
      { sessionId: 'sess-1', agentId: 'claude', title: 'first thread', pinned: false, updatedAt: '2026-01-02T00:00:00Z' },
    ]);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/chat/sessions/sess-1/messages')) {
        return jsonResponse({ sessionId: 'sess-1', agentId: 'claude', messages: [] });
      }
      throw new Error(`Unexpected fetch: GET ${url}`);
    });
    const { container } = renderChatPanel([PROJECT_A]);

    const menu = await openThreadDrawerItemMenu(container, user, 'first thread');
    await user.click(within(menu).getByRole('menuitem', { name: 'リネーム' }));

    const renameInput = screen.getByLabelText('スレッド「first thread」の新しいタイトル');
    await user.clear(renameInput);
    await user.type(renameInput, 'discarded edit');
    fireEvent.keyDown(renameInput, { key: 'Escape' });

    // Escape はリネームモードを閉じるだけで保存しない。
    expect(updateChatThreadMock).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('スレッド「first thread」の新しいタイトル')).not.toBeInTheDocument();
    openThreadDrawer(container);
    expect(
      await within(getThreadDrawer(container)).findByRole('button', { name: 'first thread' }),
    ).toBeInTheDocument();
  });

  it('does not confirm an inline thread rename on an IME composing Enter, but does confirm on blur (bdboard-sso1.83 特性テスト T1)', async () => {
    // T1: リネーム入力で isComposing 中の Enter は確定しない。blur で確定する
    // (第6段 ChatThreadDrawerOpenRow 抽出の前提)。
    const user = userEvent.setup();
    fetchChatThreadsMock.mockResolvedValue([
      { sessionId: 'sess-1', agentId: 'claude', title: 'first thread', pinned: false, updatedAt: '2026-01-02T00:00:00Z' },
    ]);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/chat/sessions/sess-1/messages')) {
        return jsonResponse({ sessionId: 'sess-1', agentId: 'claude', messages: [] });
      }
      throw new Error(`Unexpected fetch: GET ${url}`);
    });
    const { container } = renderChatPanel([PROJECT_A]);

    const menu = await openThreadDrawerItemMenu(container, user, 'first thread');
    await user.click(within(menu).getByRole('menuitem', { name: 'リネーム' }));

    const renameInput = screen.getByLabelText('スレッド「first thread」の新しいタイトル');
    await user.clear(renameInput);
    await user.type(renameInput, 'ime confirmed thread');
    fireEvent.keyDown(renameInput, { key: 'Enter', isComposing: true });

    // IME 変換確定の Enter では保存されず、入力モードのままである。
    expect(updateChatThreadMock).not.toHaveBeenCalled();
    expect(screen.getByLabelText('スレッド「first thread」の新しいタイトル')).toBeInTheDocument();

    fireEvent.blur(renameInput);

    await waitFor(() =>
      expect(updateChatThreadMock).toHaveBeenCalledWith('sess-1', 'proj-a', { title: 'ime confirmed thread' }),
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
    const { container } = renderChatPanel([PROJECT_A]);

    let menu = await openThreadDrawerItemMenu(container, user, 'first thread');
    await user.click(within(menu).getByRole('menuitem', { name: 'ピン留め' }));
    await waitFor(() =>
      expect(updateChatThreadMock).toHaveBeenCalledWith('sess-1', 'proj-a', { pinned: true }),
    );
    menu = await openThreadDrawerItemMenu(container, user, 'first thread');
    expect(within(menu).getByRole('menuitem', { name: 'ピン留め解除' })).toBeInTheDocument();

    await user.click(within(menu).getByRole('menuitem', { name: 'ピン留め解除' }));
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
    const { container } = renderChatPanel([PROJECT_A]);

    const menu = await openThreadDrawerItemMenu(container, user, 'first thread');
    await user.click(within(menu).getByRole('menuitem', { name: 'ピン留め' }));

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

    renderChatPanel([PROJECT_A, PROJECT_B], { initialProjectId: PROJECT_A.id });

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
    expect(
      screen.getByText(/考え中…\d+秒（最大3分かかることがあります）/),
    ).toBeInTheDocument();

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
});
