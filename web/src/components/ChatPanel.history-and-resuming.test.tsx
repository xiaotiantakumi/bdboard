// bdboard-sso1.83 第5段: ChatPanel.test.tsx から move-only で切り出したファイル
// (ChatPanel.history-and-resuming.test.tsx)。手本: sso1.85 の HygienePanel 分割。テスト本体・期待値・文言は
// 1文字も変えていない。共有の fixture/render ヘルパーは ChatPanel-test-support.tsx
// から import する。vi.mock はファイル単位でホイストされるため、元ファイルの
// vi.mock('../api', ...) ブロックと beforeEach/afterEach をこのファイルにも複製している。

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatAgentDto, ChatThreadDto, ChatTurnStatusDto } from '../api';
import { installFakeHistory } from '../test/fakeHistory';
import {
  writePersistedChatThread,
  readPersistedChatThreads,
} from '../chatThreadStorage';
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
  fetchDiscoveredChatSessions,
  fetchPlatformSupport,
} from '../api';
import { resetPlatformSupportCache } from './PlatformLimitationNotice';

const fetchChatAgentsMock = vi.mocked(fetchChatAgents);
const fetchChatThreadsMock = vi.mocked(fetchChatThreads);
const fetchChatTurnStatusMock = vi.mocked(fetchChatTurnStatus);
const acknowledgeChatTurnMock = vi.mocked(acknowledgeChatTurn);
const deleteChatThreadMock = vi.mocked(deleteChatThread);
const updateChatThreadMock = vi.mocked(updateChatThread);
const fetchDiscoveredChatSessionsMock = vi.mocked(fetchDiscoveredChatSessions);
const fetchPlatformSupportMock = vi.mocked(fetchPlatformSupport);
const defaultWindowInnerWidth = window.innerWidth;

import {
  PROJECT_A,
  PROJECT_B,
  CLAUDE_AGENT,
  EXAMPLE_AGENT,
  AGY_AGENT,
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

    const { container } = renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });
    await waitFor(() => {
      expect(screen.queryByText('履歴を読み込み中…')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      openThreadDrawer(container);
      expect(
        within(getThreadDrawer(container)).queryByRole('button', { name: 'evicted thread' }),
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

    const { container } = renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });
    await waitFor(() => {
      expect(screen.queryByText('履歴を読み込み中…')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      openThreadDrawer(container);
      expect(
        within(getThreadDrawer(container)).queryByRole('button', { name: 'evicted prune thread' }),
      ).not.toBeInTheDocument();
    });

    // (1) threadLists からも prune 済みなので、候補が無くなり reopen dropdown
    // 自体が現れない。
    await waitFor(() => {
      openThreadDrawer(container);
      expect(
        within(getThreadDrawer(container)).queryByText('閉じたスレッド'),
      ).not.toBeInTheDocument();
    });

    // (2) 開いているスレッドが無くなったので、選択はクリアされ空の
    // activeSessionIds が永続化される。bdboard-ij6e 以降、activeSessionIds が
    // 空でもエントリ自体は削除しない(削除するのは state === undefined の
    // 明示的なクリアだけ) — 削除してしまうと次回訪問時に
    // threadViewRestore.ts が「エントリが無い = 初回訪問」と誤認し、
    // 意図的に0件にしたはずの open が全スレッド再オープンに化けてしまう。
    expect(readPersistedChatThreads()['proj-a']).toEqual({
      activeSessionIds: [],
      selectedSessionId: undefined,
    });
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

    const { container } = renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });
    await waitFor(() => {
      expect(screen.queryByText('履歴を読み込み中…')).not.toBeInTheDocument();
    });

    // 唯一開いていた 'sess-parked' タブを閉じ、draft nonce 0 のドラフトへ
    // 落ちる (既存経路、今回の修正対象外)。
    const menu = await openThreadDrawerItemMenu(container, user, 'parked thread');
    await user.click(within(menu).getByRole('menuitem', { name: /タブから閉じる/ }));

    // nonce 0 のドラフトから送信し、新セッション 'sess-first' が確定する。
    // applyChatSuccess は旧 draftKey ('new:proj-a:0') のエントリを消さずに
    // 残すため、そこには「first message」の楽観的メッセージが孤児として残る。
    await user.type(screen.getByLabelText('メッセージ'), 'first message');
    await user.click(screen.getByRole('button', { name: '送信' }));
    await screen.findByText('first reply');

    // 閉じたスレッド一覧から、後で 404 する 'evicted orphan thread' を
    // 選択する。draft nonce はまだ 0 のまま進んでいない。
    await selectThreadFromDrawer(container, user, 'evicted orphan thread');

    // 404 による自動回復でドラフトへ戻る。修正前は同じ nonce 0 の draftKey
    // へ戻るため、上で送信した 'first message' が孤児として再表示されていた。
    await waitFor(() => {
      openThreadDrawer(container);
      expect(
        within(getThreadDrawer(container)).queryByRole('button', { name: 'evicted orphan thread' }),
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

      const { container } = renderChatPanel([PROJECT_A]);

      openThreadDrawer(container);
      await user.click(within(getThreadDrawer(container)).getByRole('button', { name: 'CLIセッションを再開' }));
      await user.click(await screen.findByRole('button', { name: 'セッション discovered-1 を再開' }));

      // 履歴シードは adopt レスポンス同梱の seedMessages から反映される (M1)。
      expect(await screen.findByText('seeded question')).toBeInTheDocument();
      expect(screen.getByText('seeded answer')).toBeInTheDocument();

      // selectedThreadIds が新セッションIDへ retarget され、開いているスレッドが
      // 1件・選択中であることがスイッチャーの件数表示に反映される (S3)。
      expect(container.querySelector('.chat-thread-switcher-count')).toHaveTextContent('スレッド 1');

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

      const { container } = renderChatPanel([PROJECT_A]);

      openThreadDrawer(container);
      await user.click(within(getThreadDrawer(container)).getByRole('button', { name: 'CLIセッションを再開' }));
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

      const { container } = renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });

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

      openThreadDrawer(container);
      await user.click(within(getThreadDrawer(container)).getByRole('button', { name: 'CLIセッションを再開' }));
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
});
