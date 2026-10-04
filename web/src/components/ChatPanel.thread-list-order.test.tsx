// bdboard-z9mn: スレッド一覧を書く処理(E7 = chat/useThreadListSync.ts の初回取得、採用の取り直し =
// chat/useChatSessionLifecycle.ts の handleResumeDiscoveredSession、turn-status 回収の hydrate =
// applyRecoveredTurn)を、プロジェクトごとの fetch 開始順序番号(chat/threadListFetchOrder.ts)で
// 一本化したときの結果を、ChatPanel 越しに固定する。開始が新しい fetch の一覧が先に当たっていれば、
// 後から届く古い一覧はそれを上書きしない。以前は取り直し・回収のどれもが無条件に置き換えていたので、
// - 回収の fetch が採用より前に始まり、採用の取り直しより後に届くと、採用したタブが (無題) に戻った
// - 採用が 2 回続くと、1 回目の取り直しが 2 回目の後に届いて、2 回目のタブが (無題) に戻った
// - 古い一覧が届くとリネームが巻き戻った
// - 初回の一覧が in-flight の間にドラフトから送信が成功すると、古い一覧が新しい会話を一覧と open から落とした
// vi.mock はファイル単位でホイストされるため、他の ChatPanel.*.test.tsx と同じ
// vi.mock('../api', ...) ブロックと beforeEach/afterEach を複製している。

import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
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
    updateChatThread: vi.fn(),
    fetchDiscoveredChatSessions: vi.fn(() => Promise.resolve({ sessions: [] })),
    fetchPlatformSupport: vi.fn(() => Promise.resolve({ platform: 'darwin', limitations: [] })),
  };
});

import {
  fetchChatAgents,
  fetchChatThreads,
  fetchChatTurnStatus,
  acknowledgeChatTurn,
  updateChatThread,
  fetchDiscoveredChatSessions,
  fetchPlatformSupport,
} from '../api';
import { resetPlatformSupportCache } from './PlatformLimitationNotice';
import {
  PROJECT_A,
  CLAUDE_AGENT,
  EXAMPLE_AGENT,
  createDeferred,
  getThreadDrawer,
  jsonResponse,
  openThreadDrawer,
  openThreadDrawerItemMenu,
  renderChatPanel,
} from './ChatPanel-test-support';

const fetchChatAgentsMock = vi.mocked(fetchChatAgents);
const fetchChatThreadsMock = vi.mocked(fetchChatThreads);
const fetchChatTurnStatusMock = vi.mocked(fetchChatTurnStatus);
const acknowledgeChatTurnMock = vi.mocked(acknowledgeChatTurn);
const updateChatThreadMock = vi.mocked(updateChatThread);
const fetchDiscoveredChatSessionsMock = vi.mocked(fetchDiscoveredChatSessions);
const fetchPlatformSupportMock = vi.mocked(fetchPlatformSupport);

function thread(sessionId: string, title: string): ChatThreadDto {
  return { sessionId, agentId: 'claude', title, pinned: false, updatedAt: '2026-01-01T00:00:00Z' };
}

const THREAD_1 = thread('sess-1', 'first thread');
const RECOVERED_THREAD = thread('sess-rec', 'recovered thread');
const ADOPTED_1 = thread('discovered-1', 'resumed title 1');
const ADOPTED_2 = thread('discovered-2', 'resumed title 2');

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => handler(url, init));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function adoptResponse(sessionId: string, seedText: string) {
  return jsonResponse({
    sessionId,
    agentId: 'claude',
    seedMessages: [{ role: 'user', text: seedText, timestamp: '2026-08-16T11:00:00.000Z' }],
  });
}

function recoveredMessagesResponse() {
  return jsonResponse({
    sessionId: 'sess-rec',
    agentId: 'claude',
    messages: [
      { role: 'user', content: 'recovered question', createdAt: '2026-08-18T11:59:00.000Z' },
      { role: 'assistant', content: 'recovered reply', createdAt: '2026-08-18T12:00:00.000Z' },
    ],
  });
}

/** sess-rec の completed を、ACK されるまで返す。 */
function mockRecoveredTurnUntilAcked() {
  let acked = false;
  acknowledgeChatTurnMock.mockImplementation(() => {
    acked = true;
    return Promise.resolve();
  });
  fetchChatTurnStatusMock.mockImplementation(() =>
    Promise.resolve<ChatTurnStatusDto>(
      acked
        ? { state: 'idle' }
        : { state: 'completed', sessionId: 'sess-rec', agentId: 'claude', completedAt: '2026-08-18T12:00:00.000Z' },
    ),
  );
}

/**
 * fetchChatThreads の呼び出し順(1 回目 = E7、2 回目以降 = 回収の hydrate か採用の取り直し)ごとに、
 * 即解決する一覧か、手で解決する保留(Deferred)を割り当てる。
 */
function scriptThreadLists(script: ReadonlyArray<ChatThreadDto[] | ReturnType<typeof createDeferred<ChatThreadDto[]>>>) {
  let calls = 0;
  fetchChatThreadsMock.mockImplementation(() => {
    const entry = script[Math.min(calls, script.length - 1)];
    calls += 1;
    return Array.isArray(entry) ? Promise.resolve(entry) : entry.promise;
  });
}

async function resolveDeferred<T>(deferred: ReturnType<typeof createDeferred<T>>, value: T) {
  await act(async () => {
    deferred.resolve(value);
    await deferred.promise;
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function resumeDiscoveredSession(
  container: HTMLElement,
  user: ReturnType<typeof userEvent.setup>,
  sessionId: string,
) {
  openThreadDrawer(container);
  const drawer = getThreadDrawer(container);
  // 一度開いた「CLIセッション」の一覧が開いたままのことがあるので、無ければ開く。
  if (screen.queryByRole('button', { name: `セッション ${sessionId} を再開` }) === null) {
    await user.click(within(drawer).getByRole('button', { name: 'CLIセッションを再開' }));
  }
  await user.click(await screen.findByRole('button', { name: `セッション ${sessionId} を再開` }));
}

function switcherTitle(container: HTMLElement) {
  return container.querySelector('.chat-thread-switcher-title');
}

function switcherCount(container: HTMLElement) {
  return container.querySelector('.chat-thread-switcher-count');
}

describe('ChatPanel: thread-list writers are ordered by fetch start (bdboard-z9mn)', () => {
  beforeEach(() => {
    installFakeHistory({});
    localStorage.clear();
    resetPlatformSupportCache();
    fetchPlatformSupportMock.mockResolvedValue({ platform: 'darwin', limitations: [] });
    fetchChatAgentsMock.mockResolvedValue([CLAUDE_AGENT]);
    fetchChatThreadsMock.mockResolvedValue([]);
    fetchChatTurnStatusMock.mockResolvedValue({ state: 'idle' });
    acknowledgeChatTurnMock.mockResolvedValue();
    fetchDiscoveredChatSessionsMock.mockResolvedValue({
      sessions: [
        { sessionId: 'discovered-1', lastActivityAt: '2026-08-16T12:00:00.000Z', alreadyAdopted: false },
        { sessionId: 'discovered-2', lastActivityAt: '2026-08-16T12:05:00.000Z', alreadyAdopted: false },
      ],
    });
    stubFetch((url, init) => {
      if (url.startsWith('/api/chat/sessions/sess-1/messages')) {
        return jsonResponse({ sessionId: 'sess-1', agentId: 'claude', messages: [] });
      }
      if (url.startsWith('/api/chat/sessions/sess-rec/messages')) return recoveredMessagesResponse();
      if (url === '/api/chat/projects/proj-a/discovered-sessions/discovered-1/adopt' && init?.method === 'POST') {
        return adoptResponse('discovered-1', 'resumed one');
      }
      if (url === '/api/chat/projects/proj-a/discovered-sessions/discovered-2/adopt' && init?.method === 'POST') {
        return adoptResponse('discovered-2', 'resumed two');
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });
  });

  afterEach(() => {
    // bdboard-1ga8 と同じ作法: モックを reset する前にアンマウントし、E8 の呼び出しが
    // 次のテストへ持ち越されないようにする。
    try {
      cleanup();
    } finally {
      vi.unstubAllGlobals();
      vi.resetAllMocks();
      vi.restoreAllMocks();
    }
  });

  it('keeps the resumed tab title when a recovery list that started before the resume lands after the resume refresh', async () => {
    const user = userEvent.setup();
    writePersistedChatThreadState('proj-a', { activeSessionIds: ['sess-1'], selectedSessionId: 'sess-1' });
    mockRecoveredTurnUntilAcked();
    // 1 回目 = E7(すぐ届く)、2 回目 = 回収の hydrate(保留。採用より前に始まる)、
    // 3 回目 = 採用の取り直し(すぐ届く。回収したセッションも含む新しい一覧)。
    const hydrateList = createDeferred<ChatThreadDto[]>();
    scriptThreadLists([[THREAD_1], hydrateList, [THREAD_1, ADOPTED_1, RECOVERED_THREAD]]);

    const { container } = renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });
    await waitFor(() => expect(fetchChatThreadsMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(switcherTitle(container)).toHaveTextContent('first thread'));

    await resumeDiscoveredSession(container, user, 'discovered-1');
    await waitFor(() => expect(fetchChatThreadsMock).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(switcherTitle(container)).toHaveTextContent('resumed title 1'));

    // 採用より前に始まった回収の一覧(採用したセッションを含まない)が、採用の取り直しより後に届く。
    await resolveDeferred(hydrateList, [THREAD_1, RECOVERED_THREAD]);

    // 回収は止まらない(ACK まで進む)。採用したタブは (無題) に戻らない。
    await waitFor(() => expect(acknowledgeChatTurnMock).toHaveBeenCalledWith('proj-a', 'sess-rec'));
    expect(switcherTitle(container)).toHaveTextContent('resumed title 1');
    expect(switcherCount(container)).toHaveTextContent('スレッド 3');
    expect(readPersistedChatThreads()['proj-a']?.activeSessionIds).toEqual(
      expect.arrayContaining(['sess-1', 'discovered-1', 'sess-rec']),
    );
  });

  it('keeps the second resumed tab title when the first resume refresh lands after the second one', async () => {
    const user = userEvent.setup();
    writePersistedChatThreadState('proj-a', { activeSessionIds: ['sess-1'], selectedSessionId: 'sess-1' });
    // 1 回目 = E7、2 回目 = 1 回目の採用の取り直し(保留)、3 回目 = 2 回目の採用の取り直し(すぐ届く)。
    const firstRefresh = createDeferred<ChatThreadDto[]>();
    scriptThreadLists([[THREAD_1], firstRefresh, [THREAD_1, ADOPTED_1, ADOPTED_2]]);

    const { container } = renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });
    await waitFor(() => expect(switcherTitle(container)).toHaveTextContent('first thread'));

    await resumeDiscoveredSession(container, user, 'discovered-1');
    await waitFor(() => expect(fetchChatThreadsMock).toHaveBeenCalledTimes(2));
    await resumeDiscoveredSession(container, user, 'discovered-2');
    await waitFor(() => expect(fetchChatThreadsMock).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(switcherTitle(container)).toHaveTextContent('resumed title 2'));

    // 1 回目の取り直し(2 回目の採用より前に始まったので、2 回目のセッションを含まない)が遅れて届く。
    await resolveDeferred(firstRefresh, [THREAD_1, ADOPTED_1]);

    expect(switcherTitle(container)).toHaveTextContent('resumed title 2');
    expect(switcherCount(container)).toHaveTextContent('スレッド 3');
  });

  it('keeps a rename when a list that started before the rename lands after it', async () => {
    const user = userEvent.setup();
    writePersistedChatThreadState('proj-a', { activeSessionIds: ['sess-1'], selectedSessionId: 'sess-1' });
    mockRecoveredTurnUntilAcked();
    updateChatThreadMock.mockImplementation(async (sessionId, _projectId, patch) => ({
      ...thread(sessionId, patch.title ?? 'first thread'),
      updatedAt: '2026-01-02T01:00:00Z',
    }));
    // 1 回目 = E7(すぐ届く)、2 回目 = 回収の hydrate(保留。リネームより前に始まる)。
    const hydrateList = createDeferred<ChatThreadDto[]>();
    scriptThreadLists([[THREAD_1], hydrateList]);

    const { container } = renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });
    await waitFor(() => expect(fetchChatThreadsMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(switcherTitle(container)).toHaveTextContent('first thread'));

    const menu = await openThreadDrawerItemMenu(container, user, 'first thread');
    await user.click(within(menu).getByRole('menuitem', { name: 'リネーム' }));
    const renameInput = screen.getByLabelText('スレッド「first thread」の新しいタイトル');
    await user.clear(renameInput);
    await user.type(renameInput, 'renamed thread');
    fireEvent.blur(renameInput);
    await waitFor(() => expect(switcherTitle(container)).toHaveTextContent('renamed thread'));

    // リネームより前に始まった回収の一覧(古いタイトル)が、リネームの後に届く。
    await resolveDeferred(hydrateList, [THREAD_1, RECOVERED_THREAD]);

    await waitFor(() => expect(acknowledgeChatTurnMock).toHaveBeenCalledWith('proj-a', 'sess-rec'));
    expect(switcherTitle(container)).toHaveTextContent('renamed thread');
    expect(switcherCount(container)).toHaveTextContent('スレッド 2');
    // 回収で新しく載ったエントリは、古い一覧でも取り込まれる(リネームしたエントリだけを置き換える)。
    openThreadDrawer(container);
    expect(within(getThreadDrawer(container)).getByRole('button', { name: 'recovered thread' })).toBeInTheDocument();
  });

  it('keeps a session sent from the draft open and listed when the first list started before the send and lands after it', async () => {
    const user = userEvent.setup();
    const firstList = createDeferred<ChatThreadDto[]>();
    scriptThreadLists([firstList]);
    stubFetch((url, init) => {
      if (url === '/api/chat/message' && init?.method === 'POST') {
        return jsonResponse({ reply: 'AI reply', sessionId: 'sess-new', agentId: 'claude' });
      }
      if (url.startsWith('/api/chat/sessions/sess-a/messages')) {
        return jsonResponse({ sessionId: 'sess-a', agentId: 'claude', messages: [] });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    const { container } = renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });
    await waitFor(() => expect(fetchChatThreadsMock).toHaveBeenCalledTimes(1));
    // 永続化エントリの無い初回訪問。初回の一覧が in-flight のまま、ドラフトから送信する。
    await user.type(screen.getByLabelText('メッセージ'), 'hello from draft');
    await user.click(screen.getByRole('button', { name: '送信' }));
    await screen.findByText('AI reply');
    await waitFor(() => expect(switcherTitle(container)).toHaveTextContent('hello from draft'));

    // 送信より前に始まった初回の一覧(新しい会話を含まない)が届く。
    await resolveDeferred(firstList, [thread('sess-a', 'server thread a'), thread('sess-b', 'server thread b')]);

    // 送信した会話は open と一覧に残り、選択も外れない。
    expect(switcherTitle(container)).toHaveTextContent('hello from draft');
    openThreadDrawer(container);
    const drawer = getThreadDrawer(container);
    expect(within(drawer).getByRole('button', { name: 'hello from draft' })).toBeInTheDocument();
    // 一覧は応答のエントリも取り込む。
    expect(within(drawer).getByRole('button', { name: 'server thread a' })).toBeInTheDocument();
    // bdboard-0206: open は永続化の [sess-new] だけに潰れず、サーバー一覧 [A,B] と送信した会話の和になる。
    // 永続化もメモリと揃う(でないとリロードで A/B が黙って閉じられる)。
    expect(switcherCount(container)).toHaveTextContent('スレッド 3');
    expect(readPersistedChatThreads()['proj-a']).toEqual({
      activeSessionIds: ['sess-a', 'sess-b', 'sess-new'],
      selectedSessionId: 'sess-new',
    });
  });

  it('opens the server list together with a session resumed before the first list lands (bdboard-0206)', async () => {
    const user = userEvent.setup();
    const firstList = createDeferred<ChatThreadDto[]>();
    // 1 回目 = E7(保留。採用より前に始まる)、2 回目 = 採用の取り直し(すぐ届く。採用したセッションも含む)。
    scriptThreadLists([firstList, [thread('sess-a', 'server thread a'), thread('sess-b', 'server thread b'), ADOPTED_1]]);

    const { container } = renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });
    await waitFor(() => expect(fetchChatThreadsMock).toHaveBeenCalledTimes(1));
    // 永続化エントリの無い初回訪問。初回の一覧が in-flight のまま、CLI セッションを採用する(最初の永続化エントリを書く)。
    await resumeDiscoveredSession(container, user, 'discovered-1');
    await waitFor(() => expect(fetchChatThreadsMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(switcherTitle(container)).toHaveTextContent('resumed title 1'));
    expect(switcherCount(container)).toHaveTextContent('スレッド 1');

    // 採用より前に始まった初回の一覧(採用したセッションを含まない)が、採用の取り直しより後に届く。
    await resolveDeferred(firstList, [thread('sess-a', 'server thread a'), thread('sess-b', 'server thread b')]);

    // 採用したタブは選択されたまま (無題) に戻らず、サーバー一覧のスレッドも開く。
    expect(switcherTitle(container)).toHaveTextContent('resumed title 1');
    expect(switcherCount(container)).toHaveTextContent('スレッド 3');
    expect(readPersistedChatThreads()['proj-a']).toEqual({
      activeSessionIds: ['sess-a', 'sess-b', 'discovered-1'],
      selectedSessionId: 'discovered-1',
    });
  });

  it('opens the server list together with a session resumed when the first list lands before the resume refresh (bdboard-0206)', async () => {
    const user = userEvent.setup();
    const firstList = createDeferred<ChatThreadDto[]>();
    const refresh = createDeferred<ChatThreadDto[]>();
    scriptThreadLists([firstList, refresh]);

    const { container } = renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });
    await waitFor(() => expect(fetchChatThreadsMock).toHaveBeenCalledTimes(1));
    await resumeDiscoveredSession(container, user, 'discovered-1');
    await waitFor(() => expect(fetchChatThreadsMock).toHaveBeenCalledTimes(2));

    // 採用の取り直しが届く前に、初回の一覧が届く。
    await resolveDeferred(firstList, [thread('sess-a', 'server thread a'), thread('sess-b', 'server thread b')]);
    expect(switcherCount(container)).toHaveTextContent('スレッド 3');

    // そのあと取り直しが届いても、開いたスレッドは減らない。
    await resolveDeferred(refresh, [thread('sess-a', 'server thread a'), thread('sess-b', 'server thread b'), ADOPTED_1]);
    expect(switcherTitle(container)).toHaveTextContent('resumed title 1');
    expect(switcherCount(container)).toHaveTextContent('スレッド 3');
    expect(readPersistedChatThreads()['proj-a']?.activeSessionIds).toEqual(['sess-a', 'sess-b', 'discovered-1']);
  });
});

describe('ChatPanel: the provisional first entry is told apart from the user\'s own open/close record (bdboard-rt6i)', () => {
  beforeEach(() => {
    installFakeHistory({});
    localStorage.clear();
    resetPlatformSupportCache();
    fetchPlatformSupportMock.mockResolvedValue({ platform: 'darwin', limitations: [] });
    fetchChatAgentsMock.mockResolvedValue([CLAUDE_AGENT, EXAMPLE_AGENT]);
    fetchChatThreadsMock.mockResolvedValue([]);
    fetchChatTurnStatusMock.mockResolvedValue({ state: 'idle' });
    acknowledgeChatTurnMock.mockResolvedValue();
    fetchDiscoveredChatSessionsMock.mockResolvedValue({ sessions: [] });
  });

  afterEach(() => {
    try {
      cleanup();
    } finally {
      vi.unstubAllGlobals();
      vi.resetAllMocks();
      vi.restoreAllMocks();
    }
  });

  const SERVER_A = thread('sess-a', 'server thread a');
  const SERVER_B = thread('sess-b', 'server thread b');

  /** POST /api/chat/message に、呼び出し順に sessionIds の sessionId を返す(最後の値は繰り返す)。 */
  function stubSends(sessionIds: readonly string[], agentId = 'claude') {
    let posts = 0;
    stubFetch((url, init) => {
      if (url === '/api/chat/message' && init?.method === 'POST') {
        const sessionId = sessionIds[Math.min(posts, sessionIds.length - 1)];
        posts += 1;
        return jsonResponse({ reply: `AI reply ${posts}`, sessionId, agentId });
      }
      if (url.startsWith('/api/chat/sessions/sess-rec/messages')) return recoveredMessagesResponse();
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });
  }

  it('opens the server list when a turn-status recovery lands after a send wrote the first entry during the first list (gap 1)', async () => {
    const user = userEvent.setup();
    const firstList = createDeferred<ChatThreadDto[]>();
    // 1 回目 = E7(保留)、2 回目 = 回収の hydrate(すぐ届く。サーバーは送信した会話と回収したセッションも持つ)。
    scriptThreadLists([firstList, [SERVER_A, SERVER_B, thread('sess-new', 'hello from draft'), RECOVERED_THREAD]]);
    // 回収の completed は、送信が済むまで(statusGate)返さない。sess-rec の ACK までは completed を返し続ける。
    const statusGate = createDeferred<void>();
    let recoveredAcked = false;
    acknowledgeChatTurnMock.mockImplementation((_projectId, sessionId) => {
      if (sessionId === 'sess-rec') recoveredAcked = true;
      return Promise.resolve();
    });
    fetchChatTurnStatusMock.mockImplementation(async () => {
      await statusGate.promise;
      return recoveredAcked
        ? { state: 'idle' }
        : { state: 'completed', sessionId: 'sess-rec', agentId: 'claude', completedAt: '2026-08-18T12:00:00.000Z' };
    });
    stubSends(['sess-new']);

    const { container } = renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });
    await waitFor(() => expect(fetchChatThreadsMock).toHaveBeenCalledTimes(1));
    // 永続化エントリの無い初回訪問。初回の一覧が in-flight のまま、ドラフトから送信する(最初の永続化エントリ [sess-new])。
    await user.type(screen.getByLabelText('メッセージ'), 'hello from draft');
    await user.click(screen.getByRole('button', { name: '送信' }));
    await screen.findByText('AI reply 1');
    expect(readPersistedChatThreads()['proj-a']).toEqual({ activeSessionIds: ['sess-new'], selectedSessionId: 'sess-new' });

    // そのあと turn-status 回収の hydrate が走る(E7 の応答より先)。
    await act(async () => {
      statusGate.resolve();
      await statusGate.promise;
    });
    await waitFor(() => expect(acknowledgeChatTurnMock).toHaveBeenCalledWith('proj-a', 'sess-rec'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // 仮の [sess-new] を再訪の記録として扱わない: サーバー一覧と、送信した会話・回収したセッションの和で開く。
    expect(switcherCount(container)).toHaveTextContent('スレッド 4');
    expect(switcherTitle(container)).toHaveTextContent('hello from draft');
    expect(readPersistedChatThreads()['proj-a']).toEqual({
      activeSessionIds: ['sess-a', 'sess-b', 'sess-new', 'sess-rec'],
      selectedSessionId: 'sess-new',
    });

    // 回収に追い越された E7 の応答は、何も当てない。
    await resolveDeferred(firstList, [SERVER_A, SERVER_B]);
    expect(switcherCount(container)).toHaveTextContent('スレッド 4');
  });

  it('keeps the open set the user emptied with an agent change when a send lands before the first list (gap 2)', async () => {
    const user = userEvent.setup();
    const firstList = createDeferred<ChatThreadDto[]>();
    scriptThreadLists([firstList]);
    stubSends(['sess-new'], 'example-agent');

    const { container } = renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });
    await waitFor(() => expect(fetchChatThreadsMock).toHaveBeenCalledTimes(1));
    // 永続化エントリの無い初回訪問。初回の一覧が in-flight のまま、エージェントを切り替える(open は空に確定)。
    await user.selectOptions(await screen.findByLabelText('チャットエージェント'), 'example-agent');
    expect(readPersistedChatThreads()['proj-a']).toEqual({ activeSessionIds: [] });
    await user.type(screen.getByLabelText('メッセージ'), 'hello after switch');
    await user.click(screen.getByRole('button', { name: '送信' }));
    await screen.findByText('AI reply 1');
    expect(readPersistedChatThreads()['proj-a']).toEqual({ activeSessionIds: ['sess-new'], selectedSessionId: 'sess-new' });

    await resolveDeferred(firstList, [SERVER_A, SERVER_B]);

    // 利用者が明示した「空」から始めた open は、サーバー一覧で広げない(切替で閉じた A/B は閉じたまま)。
    expect(switcherCount(container)).toHaveTextContent('スレッド 1');
    expect(switcherTitle(container)).toHaveTextContent('hello after switch');
    expect(readPersistedChatThreads()['proj-a']).toEqual({ activeSessionIds: ['sess-new'], selectedSessionId: 'sess-new' });
  });

  it('does not reopen a thread the user closed after two sends during the first list (gap 3, N1 -> N2 -> close N1)', async () => {
    const user = userEvent.setup();
    const firstList = createDeferred<ChatThreadDto[]>();
    scriptThreadLists([firstList]);
    stubSends(['sess-n1', 'sess-n2']);

    const { container } = renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });
    await waitFor(() => expect(fetchChatThreadsMock).toHaveBeenCalledTimes(1));
    await user.type(screen.getByLabelText('メッセージ'), 'hello one');
    await user.click(screen.getByRole('button', { name: '送信' }));
    await screen.findByText('AI reply 1');
    await user.click(screen.getByRole('button', { name: '新しい空のスレッドを開始' }));
    await user.type(screen.getByLabelText('メッセージ'), 'hello two');
    await user.click(screen.getByRole('button', { name: '送信' }));
    await screen.findByText('AI reply 2');
    expect(switcherCount(container)).toHaveTextContent('スレッド 2');

    // 1 つ目のスレッドを閉じる(明示の操作)。永続化は [sess-n2] になる。
    const menu = await openThreadDrawerItemMenu(container, user, 'hello one');
    await user.click(within(menu).getByRole('menuitem', { name: /タブから閉じる/ }));
    expect(readPersistedChatThreads()['proj-a']?.activeSessionIds).toEqual(['sess-n2']);

    await resolveDeferred(firstList, [SERVER_A, SERVER_B]);

    // 閉じた sess-n1 は、一覧に upsert として重なっていても開き直さない。永続化は利用者の記録のまま。
    expect(switcherCount(container)).toHaveTextContent('スレッド 1');
    expect(switcherTitle(container)).toHaveTextContent('hello two');
    expect(readPersistedChatThreads()['proj-a']).toEqual({ activeSessionIds: ['sess-n2'], selectedSessionId: 'sess-n2' });
  });
});
