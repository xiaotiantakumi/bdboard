// bdboard-lsv2: turn-status 回収(E8、chat/useTurnStatusRecovery.ts)の hydrate と、
// 履歴ローダー(E12、chat/useChatHistoryLoader.ts)の in-flight の履歴 fetch が重なった
// ときの結果を固定する。以前は hydrate が fetch の前に履歴の request-id を進めて
// loading を外していたため、hydrate の fetch が失敗すると、その間に E12 が読み込んで
// いた別スレッドの履歴応答と historyLoadedFor の書き込みが捨てられたまま conversations
// も変わらず、送信ボタンが無効のまま戻らなかった。request-id は当てる直前に進めるので、
// 失敗した hydrate は E12 の応答を捨てない。一方、回収したスレッド自身の古い履歴応答は、
// hydrate の前に届いても後に届いても回収結果を上書きしない(回収結果の保護は変わらない)。
// vi.mock はファイル単位でホイストされるため、他の ChatPanel.*.test.tsx と同じ
// vi.mock('../api', ...) ブロックと beforeEach/afterEach を複製している。

import { act, cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatAgentDto, ChatThreadDto, ChatTurnStatusDto } from '../api';
import { writePersistedChatThreadState } from '../chatThreadStorage';
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
import { PROJECT_A, CLAUDE_AGENT, createDeferred, jsonResponse, renderChatPanel } from './ChatPanel-test-support';

const fetchChatAgentsMock = vi.mocked(fetchChatAgents);
const fetchChatThreadsMock = vi.mocked(fetchChatThreads);
const fetchChatTurnStatusMock = vi.mocked(fetchChatTurnStatus);
const acknowledgeChatTurnMock = vi.mocked(acknowledgeChatTurn);
const fetchDiscoveredChatSessionsMock = vi.mocked(fetchDiscoveredChatSessions);
const fetchPlatformSupportMock = vi.mocked(fetchPlatformSupport);

function thread(sessionId: string, title: string): ChatThreadDto {
  return { sessionId, agentId: 'claude', title, pinned: false, updatedAt: '2026-01-01T00:00:00Z' };
}

const THREAD_1 = thread('sess-1', 'first thread');
const RECOVERED_THREAD = thread('sess-rec', 'recovered thread');
const COMPLETED: ChatTurnStatusDto = {
  state: 'completed',
  sessionId: 'sess-rec',
  agentId: 'claude',
  completedAt: '2026-08-18T12:00:00.000Z',
};

function messagesResponse(sessionId: string, contents: readonly string[]) {
  return jsonResponse({
    sessionId,
    agentId: 'claude',
    messages: contents.map((content, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content,
      createdAt: `2026-08-18T11:5${index}:00.000Z`,
    })),
  });
}

/**
 * 1回目の turn-status を保留し、E12 が履歴 fetch を始めてから解く(hydrate が E12 の
 * in-flight の要求に重なる順を確実に作る)。解いた後は ACK されるまで completed を返す。
 */
function holdFirstTurnStatus() {
  const first = createDeferred<ChatTurnStatusDto>();
  let calls = 0;
  let acked = false;
  acknowledgeChatTurnMock.mockImplementation(() => {
    acked = true;
    return Promise.resolve();
  });
  fetchChatTurnStatusMock.mockImplementation(() => {
    calls += 1;
    if (calls === 1) return first.promise;
    return Promise.resolve<ChatTurnStatusDto>(acked ? { state: 'idle' } : COMPLETED);
  });
  return first;
}

function historyFetchCount(fetchMock: ReturnType<typeof vi.fn>, sessionId: string) {
  return fetchMock.mock.calls.filter(([url]) => String(url).startsWith(`/api/chat/sessions/${sessionId}/messages`))
    .length;
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('ChatPanel: recovery hydrate overlapping an in-flight history load (bdboard-lsv2)', () => {
  beforeEach(() => {
    installFakeHistory({});
    localStorage.clear();
    resetPlatformSupportCache();
    fetchPlatformSupportMock.mockResolvedValue({ platform: 'darwin', limitations: [] });
    fetchChatAgentsMock.mockResolvedValue([CLAUDE_AGENT]);
    fetchChatThreadsMock.mockResolvedValue([]);
    fetchChatTurnStatusMock.mockResolvedValue({ state: 'idle' });
    acknowledgeChatTurnMock.mockResolvedValue();
    fetchDiscoveredChatSessionsMock.mockResolvedValue({ sessions: [] });
  });

  afterEach(() => {
    // bdboard-1ga8 と同じ作法: モックを reset する前にアンマウントし、E8 のポーリングや
    // 再試行のタイマーが次のテストへ持ち越されないようにする。
    try {
      cleanup();
    } finally {
      vi.unstubAllGlobals();
      vi.resetAllMocks();
      vi.restoreAllMocks();
    }
  });

  it('keeps the history of the open thread and re-enables the submit button when the hydrate fetch fails', async () => {
    const user = userEvent.setup();
    writePersistedChatThreadState('proj-a', { activeSessionIds: ['sess-1'], selectedSessionId: 'sess-1' });
    const firstStatus = holdFirstTurnStatus();
    // 1回目(E7 の初回取得)だけ成功し、hydrate の一覧取得は失敗し続ける。
    let listCalls = 0;
    fetchChatThreadsMock.mockImplementation(() => {
      listCalls += 1;
      return listCalls === 1 ? Promise.resolve([THREAD_1]) : Promise.reject(new Error('hydrate list failed'));
    });
    const sess1History = createDeferred<Response>();
    const fetchMock = vi.fn((url: string) => {
      if (url.startsWith('/api/chat/sessions/sess-1/messages')) return sess1History.promise;
      if (url.startsWith('/api/chat/sessions/sess-rec/messages')) return Promise.reject(new Error('hydrate failed'));
      return Promise.reject(new Error(`Unexpected fetch: GET ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });
    await waitFor(() => expect(historyFetchCount(fetchMock, 'sess-1')).toBe(1));
    // E12 が sess-1 の履歴を読み込み中に、回収の hydrate が始まって失敗する。
    await act(async () => {
      firstStatus.resolve(COMPLETED);
      await firstStatus.promise;
    });
    await waitFor(() => expect(fetchChatThreadsMock).toHaveBeenCalledTimes(2));
    await settle();
    expect(acknowledgeChatTurnMock).not.toHaveBeenCalled();

    await act(async () => {
      sess1History.resolve(messagesResponse('sess-1', ['first thread question', 'first thread answer']));
      await sess1History.promise;
    });

    expect(await screen.findByText('first thread question')).toBeInTheDocument();
    await user.type(screen.getByLabelText('メッセージ'), 'follow-up');
    await waitFor(() => expect(screen.getByRole('button', { name: '送信' })).not.toBeDisabled());
    // 履歴は取り直していない(E12 の最初の応答がそのまま当たった)。
    expect(historyFetchCount(fetchMock, 'sess-1')).toBe(1);
  });

  it('does not let the recovered thread\'s own older history response overwrite the hydrate when it lands afterwards', async () => {
    writePersistedChatThreadState('proj-a', { activeSessionIds: ['sess-rec'], selectedSessionId: 'sess-rec' });
    const firstStatus = holdFirstTurnStatus();
    fetchChatThreadsMock.mockResolvedValue([RECOVERED_THREAD]);
    const staleHistory = createDeferred<Response>();
    let recCalls = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url.startsWith('/api/chat/sessions/sess-rec/messages')) {
        recCalls += 1;
        // 1回目は E12 の履歴読み込み(古い内容で保留)、2回目は hydrate。
        return recCalls === 1
          ? staleHistory.promise
          : Promise.resolve(messagesResponse('sess-rec', ['recovered question', 'recovered reply']));
      }
      return Promise.reject(new Error(`Unexpected fetch: GET ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });
    await waitFor(() => expect(recCalls).toBe(1));
    await act(async () => {
      firstStatus.resolve(COMPLETED);
      await firstStatus.promise;
    });
    await waitFor(() => expect(acknowledgeChatTurnMock).toHaveBeenCalledWith('proj-a', 'sess-rec'));
    expect(await screen.findByText('recovered reply')).toBeInTheDocument();

    await act(async () => {
      staleHistory.resolve(messagesResponse('sess-rec', ['stale question']));
      await staleHistory.promise;
    });
    await settle();

    expect(screen.getByText('recovered reply')).toBeInTheDocument();
    expect(screen.queryByText('stale question')).not.toBeInTheDocument();
  });

  it('overwrites the recovered thread\'s own older history response that lands while the hydrate is still fetching', async () => {
    writePersistedChatThreadState('proj-a', { activeSessionIds: ['sess-rec'], selectedSessionId: 'sess-rec' });
    const firstStatus = holdFirstTurnStatus();
    const hydrateList = createDeferred<ChatThreadDto[]>();
    let listCalls = 0;
    fetchChatThreadsMock.mockImplementation(() => {
      listCalls += 1;
      return listCalls === 1 ? Promise.resolve([RECOVERED_THREAD]) : hydrateList.promise;
    });
    const staleHistory = createDeferred<Response>();
    let recCalls = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url.startsWith('/api/chat/sessions/sess-rec/messages')) {
        recCalls += 1;
        return recCalls === 1
          ? staleHistory.promise
          : Promise.resolve(messagesResponse('sess-rec', ['recovered question', 'recovered reply']));
      }
      return Promise.reject(new Error(`Unexpected fetch: GET ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });
    await waitFor(() => expect(recCalls).toBe(1));
    await act(async () => {
      firstStatus.resolve(COMPLETED);
      await firstStatus.promise;
    });
    await waitFor(() => expect(fetchChatThreadsMock).toHaveBeenCalledTimes(2));
    // hydrate の一覧取得が保留されている間に、E12 の古い履歴応答が届く。
    await act(async () => {
      staleHistory.resolve(messagesResponse('sess-rec', ['stale question']));
      await staleHistory.promise;
    });
    await settle();
    await act(async () => {
      hydrateList.resolve([RECOVERED_THREAD]);
      await hydrateList.promise;
    });
    await waitFor(() => expect(acknowledgeChatTurnMock).toHaveBeenCalledWith('proj-a', 'sess-rec'));
    await settle();

    expect(screen.getByText('recovered reply')).toBeInTheDocument();
    expect(screen.queryByText('stale question')).not.toBeInTheDocument();
  });
});
