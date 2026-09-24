// bdboard-sso1.83 第15a段の「先に足すもの」: ChatPanel に残っていたセッションの
// 出入りを書き込む3つのハンドラ(turn-status 回収の hydrate = applyRecoveredTurn、
// CLI セッションの再開 = handleResumeDiscoveredSession、履歴 404 の prune =
// handleHistorySessionGone)を関心別フックへ移す前に、既存テストが見ていない分岐を
// 今の main に対して固定する。
// - 回収: 選択が無ければ回収したセッションを開いて選び、エージェントとモデルも
//   そのセッションのものにする。選択があればそれを奪わず、開いている一覧の末尾に足す。
// - 再開: 既に開いているセッションを再開しても一覧に二重に足さない。別のセッションを
//   再開すると末尾に足して選ぶ。再開の後にスレッド一覧を取り直し、その失敗は表に出さない。
// vi.mock はファイル単位でホイストされるため、他の ChatPanel.*.test.tsx と同じ
// vi.mock('../api', ...) ブロックと beforeEach/afterEach を複製している。

import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatAgentDto, ChatThreadDto, ChatTurnStatusDto } from '../api';
import { readPersistedChatThreads, writePersistedChatThreadState } from '../chatThreadStorage';
import { installFakeHistory } from '../test/fakeHistory';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    fetchChatAgents: vi.fn(() => Promise.resolve<ChatAgentDto[]>([])),
    fetchChatThreads: vi.fn(() => Promise.resolve<ChatThreadDto[]>([])),
    fetchChatTurnStatus: vi.fn(() => Promise.resolve<ChatTurnStatusDto>({ state: 'idle' })),
    acknowledgeChatTurn: vi.fn(() => Promise.resolve()),
    fetchDiscoveredChatSessions: vi.fn(() => Promise.resolve({ sessions: [] })),
    fetchPlatformSupport: vi.fn(() => Promise.resolve({ platform: 'darwin', limitations: [] })),
  };
});

import {
  fetchChatAgents,
  fetchChatThreads,
  fetchChatTurnStatus,
  acknowledgeChatTurn,
  fetchDiscoveredChatSessions,
  fetchPlatformSupport,
} from '../api';
import { resetPlatformSupportCache } from './PlatformLimitationNotice';
import {
  PROJECT_A,
  CLAUDE_AGENT,
  getThreadDrawer,
  jsonResponse,
  openThreadDrawer,
  renderChatPanel,
} from './ChatPanel-test-support';

const fetchChatAgentsMock = vi.mocked(fetchChatAgents);
const fetchChatThreadsMock = vi.mocked(fetchChatThreads);
const fetchChatTurnStatusMock = vi.mocked(fetchChatTurnStatus);
const acknowledgeChatTurnMock = vi.mocked(acknowledgeChatTurn);
const fetchDiscoveredChatSessionsMock = vi.mocked(fetchDiscoveredChatSessions);
const fetchPlatformSupportMock = vi.mocked(fetchPlatformSupport);

const MULTI_MODEL_AGENT: ChatAgentDto = {
  ...CLAUDE_AGENT,
  id: 'multi',
  label: 'Multi',
  models: [
    { id: 'm1', label: 'Model One' },
    { id: 'm2', label: 'Model Two' },
  ],
};

const THREAD_1: ChatThreadDto = {
  sessionId: 'sess-1',
  agentId: 'claude',
  title: 'first thread',
  pinned: false,
  updatedAt: '2026-01-01T00:00:00Z',
};

const DETACHED_THREAD: ChatThreadDto = {
  sessionId: 'sess-detached',
  agentId: 'multi',
  title: 'detached question',
  pinned: false,
  updatedAt: '2026-08-18T12:00:00.000Z',
};

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => handler(url, init));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function unexpected(url: string, init?: RequestInit): never {
  throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
}

function detachedMessagesResponse() {
  return jsonResponse({
    sessionId: 'sess-detached',
    agentId: 'multi',
    model: 'm2',
    messages: [
      { role: 'user', content: 'detached question', createdAt: '2026-08-18T11:59:00.000Z' },
      { role: 'assistant', content: 'recovered reply', createdAt: '2026-08-18T12:00:00.000Z' },
    ],
  });
}

/** 1回目は processing、以降は completed(sess-detached)を返し、ACK の後は idle に落とす。 */
function mockProcessingThenCompleted() {
  let acked = false;
  acknowledgeChatTurnMock.mockImplementation(() => {
    acked = true;
    return Promise.resolve();
  });
  fetchChatTurnStatusMock
    .mockResolvedValueOnce({ state: 'processing', message: 'detached question', agentId: 'multi' })
    .mockImplementation(() =>
      Promise.resolve<ChatTurnStatusDto>(
        acked
          ? { state: 'idle' }
          : {
              state: 'completed',
              sessionId: 'sess-detached',
              agentId: 'multi',
              completedAt: '2026-08-18T12:00:00.000Z',
            },
      ),
    );
}

async function resumeDiscoveredSession(
  container: HTMLElement,
  user: ReturnType<typeof userEvent.setup>,
  sessionId: string,
) {
  openThreadDrawer(container);
  await user.click(within(getThreadDrawer(container)).getByRole('button', { name: 'CLIセッションを再開' }));
  await user.click(await screen.findByRole('button', { name: `セッション ${sessionId} を再開` }));
}

describe('ChatPanel session lifecycle characterization (bdboard-sso1.83 第15a段の前提)', () => {
  beforeEach(() => {
    installFakeHistory({});
    localStorage.clear();
    resetPlatformSupportCache();
    fetchPlatformSupportMock.mockResolvedValue({ platform: 'darwin', limitations: [] });
    fetchChatAgentsMock.mockResolvedValue([]);
    fetchChatThreadsMock.mockResolvedValue([]);
    fetchChatTurnStatusMock.mockResolvedValue({ state: 'idle' });
    acknowledgeChatTurnMock.mockResolvedValue();
    fetchDiscoveredChatSessionsMock.mockResolvedValue({ sessions: [] });
    stubFetch(unexpected);
  });

  afterEach(() => {
    // bdboard-1ga8: モックを reset する前に RTL の cleanup(アンマウント)を済ませる。
    // RTL の自動 cleanup はルートの afterEach なので、この describe の afterEach より
    // 後に走る。アンマウントは保留中の passive effect を先に flush するため、前の
    // テストの turn-status 回収(E8)などが reset の後に fetchChatTurnStatus 等を
    // 呼び、その呼び出し記録が次のテストへ持ち越されていた(次のテストの呼び出し回数が
    // 1 つ多く見える)。
    cleanup();
    vi.unstubAllGlobals();
    vi.resetAllMocks();
    vi.restoreAllMocks();
  });

  describe('turn-status recovery hydrate (applyRecoveredTurn)', () => {
    it('opens and selects the recovered session, and adopts its agent and model, when nothing is selected', async () => {
      fetchChatAgentsMock.mockResolvedValue([CLAUDE_AGENT, MULTI_MODEL_AGENT]);
      mockProcessingThenCompleted();
      fetchChatThreadsMock.mockResolvedValueOnce([]).mockResolvedValue([DETACHED_THREAD]);
      stubFetch((url, init) =>
        url.startsWith('/api/chat/sessions/sess-detached/messages')
          ? detachedMessagesResponse()
          : unexpected(url, init),
      );

      const { container } = renderChatPanel([PROJECT_A]);

      expect(await screen.findByText('recovered reply', {}, { timeout: 2_500 })).toBeInTheDocument();
      expect(container.querySelector('.chat-thread-switcher-title')).toHaveTextContent('detached question');
      expect(container.querySelector('.chat-thread-switcher-count')).toHaveTextContent('スレッド 1');
      expect(readPersistedChatThreads()).toEqual({
        'proj-a': { activeSessionIds: ['sess-detached'], selectedSessionId: 'sess-detached' },
      });
      await waitFor(() => {
        expect(screen.getByLabelText('チャットエージェント')).toHaveValue('multi');
      });
      await waitFor(() => {
        expect(screen.getByLabelText('モデル')).toHaveValue('m2');
      });
    });

    it('keeps the current selection and appends the recovered session to the open list', async () => {
      writePersistedChatThreadState('proj-a', {
        activeSessionIds: ['sess-1'],
        selectedSessionId: 'sess-1',
      });
      fetchChatAgentsMock.mockResolvedValue([CLAUDE_AGENT, MULTI_MODEL_AGENT]);
      mockProcessingThenCompleted();
      fetchChatThreadsMock.mockResolvedValueOnce([THREAD_1]).mockResolvedValue([THREAD_1, DETACHED_THREAD]);
      stubFetch((url, init) => {
        if (url.startsWith('/api/chat/sessions/sess-1/messages')) {
          return jsonResponse({
            sessionId: 'sess-1',
            agentId: 'claude',
            messages: [{ role: 'user', content: 'first thread question', createdAt: '2026-01-01T00:00:00Z' }],
          });
        }
        if (url.startsWith('/api/chat/sessions/sess-detached/messages')) {
          return detachedMessagesResponse();
        }
        return unexpected(url, init);
      });

      const { container } = renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });

      expect(await screen.findByText('first thread question')).toBeInTheDocument();
      await waitFor(
        () => {
          expect(readPersistedChatThreads()).toEqual({
            'proj-a': { activeSessionIds: ['sess-1', 'sess-detached'], selectedSessionId: 'sess-1' },
          });
        },
        { timeout: 2_500 },
      );
      expect(container.querySelector('.chat-thread-switcher-title')).toHaveTextContent('first thread');
      expect(container.querySelector('.chat-thread-switcher-count')).toHaveTextContent('スレッド 2');
      expect(screen.getByLabelText('チャットエージェント')).toHaveValue('claude');
      expect(screen.queryByText('recovered reply')).not.toBeInTheDocument();
    });
  });

  describe('resuming a discovered CLI session (handleResumeDiscoveredSession)', () => {
    function adoptResponse(sessionId: string, seedText: string) {
      return jsonResponse({
        sessionId,
        agentId: 'claude',
        seedMessages: [{ role: 'user', text: seedText, timestamp: '2026-08-16T11:00:00.000Z' }],
      });
    }

    it('does not add an already-open session to the open list twice', async () => {
      const user = userEvent.setup();
      writePersistedChatThreadState('proj-a', {
        activeSessionIds: ['sess-1'],
        selectedSessionId: 'sess-1',
      });
      fetchChatAgentsMock.mockResolvedValue([CLAUDE_AGENT]);
      fetchChatThreadsMock.mockResolvedValue([THREAD_1]);
      fetchDiscoveredChatSessionsMock.mockResolvedValue({
        sessions: [{ sessionId: 'sess-1', lastActivityAt: '2026-08-16T12:00:00.000Z', alreadyAdopted: true }],
      });
      stubFetch((url, init) => {
        if (url.startsWith('/api/chat/sessions/sess-1/messages')) {
          return jsonResponse({ sessionId: 'sess-1', agentId: 'claude', messages: [] });
        }
        if (url === '/api/chat/projects/proj-a/discovered-sessions/sess-1/adopt' && init?.method === 'POST') {
          return adoptResponse('sess-1', 'resumed same session');
        }
        return unexpected(url, init);
      });

      const { container } = renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });
      await waitFor(() => {
        expect(screen.queryByText('履歴を読み込み中…')).not.toBeInTheDocument();
      });
      await resumeDiscoveredSession(container, user, 'sess-1');

      expect(await screen.findByText('resumed same session')).toBeInTheDocument();
      expect(container.querySelector('.chat-thread-switcher-count')).toHaveTextContent('スレッド 1');
      expect(readPersistedChatThreads()).toEqual({
        'proj-a': { activeSessionIds: ['sess-1'], selectedSessionId: 'sess-1' },
      });
    });

    it('appends a newly resumed session after the open ones, selects it, and refreshes the thread list', async () => {
      const user = userEvent.setup();
      writePersistedChatThreadState('proj-a', {
        activeSessionIds: ['sess-1'],
        selectedSessionId: 'sess-1',
      });
      fetchChatAgentsMock.mockResolvedValue([CLAUDE_AGENT]);
      fetchChatThreadsMock.mockResolvedValueOnce([THREAD_1]).mockResolvedValue([
        THREAD_1,
        { ...THREAD_1, sessionId: 'discovered-1', title: 'resumed title' },
      ]);
      fetchDiscoveredChatSessionsMock.mockResolvedValue({
        sessions: [{ sessionId: 'discovered-1', lastActivityAt: '2026-08-16T12:00:00.000Z', alreadyAdopted: false }],
      });
      stubFetch((url, init) => {
        if (url.startsWith('/api/chat/sessions/sess-1/messages')) {
          return jsonResponse({ sessionId: 'sess-1', agentId: 'claude', messages: [] });
        }
        if (url === '/api/chat/projects/proj-a/discovered-sessions/discovered-1/adopt' && init?.method === 'POST') {
          return adoptResponse('discovered-1', 'resumed other session');
        }
        return unexpected(url, init);
      });

      const { container } = renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });
      await waitFor(() => {
        expect(screen.queryByText('履歴を読み込み中…')).not.toBeInTheDocument();
      });
      expect(fetchChatThreadsMock).toHaveBeenCalledTimes(1);
      await resumeDiscoveredSession(container, user, 'discovered-1');

      expect(await screen.findByText('resumed other session')).toBeInTheDocument();
      expect(container.querySelector('.chat-thread-switcher-count')).toHaveTextContent('スレッド 2');
      expect(readPersistedChatThreads()).toEqual({
        'proj-a': { activeSessionIds: ['sess-1', 'discovered-1'], selectedSessionId: 'discovered-1' },
      });
      await waitFor(() => {
        expect(container.querySelector('.chat-thread-switcher-title')).toHaveTextContent('resumed title');
      });
      expect(fetchChatThreadsMock).toHaveBeenCalledTimes(2);
      expect(fetchChatThreadsMock).toHaveBeenLastCalledWith('proj-a');
    });

    it('keeps the resumed conversation and shows no error when the thread-list refresh fails', async () => {
      const user = userEvent.setup();
      fetchChatAgentsMock.mockResolvedValue([CLAUDE_AGENT]);
      fetchChatThreadsMock.mockResolvedValueOnce([]).mockRejectedValue(new Error('threads down'));
      fetchDiscoveredChatSessionsMock.mockResolvedValue({
        sessions: [{ sessionId: 'discovered-1', lastActivityAt: '2026-08-16T12:00:00.000Z', alreadyAdopted: false }],
      });
      stubFetch((url, init) =>
        url === '/api/chat/projects/proj-a/discovered-sessions/discovered-1/adopt' && init?.method === 'POST'
          ? adoptResponse('discovered-1', 'resumed despite list failure')
          : unexpected(url, init),
      );

      const { container } = renderChatPanel([PROJECT_A]);
      await waitFor(() => expect(fetchChatThreadsMock).toHaveBeenCalledTimes(1));
      await resumeDiscoveredSession(container, user, 'discovered-1');

      expect(await screen.findByText('resumed despite list failure')).toBeInTheDocument();
      await waitFor(() => expect(fetchChatThreadsMock).toHaveBeenCalledTimes(2));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(screen.queryByText('スレッド一覧の取得に失敗しました。')).not.toBeInTheDocument();
      expect(container.querySelector('.chat-thread-switcher-title')).toHaveTextContent('(無題)');
      expect(container.querySelector('.chat-thread-switcher-count')).toHaveTextContent('スレッド 1');
    });
  });
});
