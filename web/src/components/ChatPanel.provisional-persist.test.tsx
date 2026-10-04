// bdboard-521p: 仮のエントリ(bdboard-rt6i。chat/provisionalEntry.ts)の印と、その間に閉じたスレッドの id は、
// 保存エントリ(chatThreadStorage.ts の provisional / provisionalClosedSessionIds)にも持たせる。メモリだけだと、
// リロードやチャットパネルを閉じる(AppChatOverlay が ChatPanel をアンマウントする)で消え、E7 が着地しないまま
// 残った仮の [N] が次の訪問で利用者の再訪問記録として読まれて、サーバー一覧への広げが起きなかった。
// ここでは ChatPanel を描画し、アンマウント → 再描画(読めるのは localStorage だけ)の後でも広げが起きることを固定する。
// vi.mock はファイル単位でホイストされるため、他の ChatPanel.*.test.tsx と同じ vi.mock('../api', ...) ブロックと
// beforeEach/afterEach を複製している。

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatAgentDto, ChatThreadDto, ChatTurnStatusDto } from '../api';
import { readPersistedChatThreads } from '../chatThreadStorage';
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
  fetchDiscoveredChatSessions,
  fetchPlatformSupport,
} from '../api';
import { AppChatOverlay } from './app/AppChatOverlay';
import { resetPlatformSupportCache } from './PlatformLimitationNotice';
import {
  PROJECT_A,
  CLAUDE_AGENT,
  EXAMPLE_AGENT,
  createDeferred,
  getThreadDrawer,
  jsonResponse,
  openChatSettings,
  openThreadDrawer,
  openThreadDrawerItemMenu,
  renderChatPanel,
} from './ChatPanel-test-support';

const fetchChatAgentsMock = vi.mocked(fetchChatAgents);
const fetchChatThreadsMock = vi.mocked(fetchChatThreads);
const fetchChatTurnStatusMock = vi.mocked(fetchChatTurnStatus);
const acknowledgeChatTurnMock = vi.mocked(acknowledgeChatTurn);
const fetchDiscoveredChatSessionsMock = vi.mocked(fetchDiscoveredChatSessions);
const fetchPlatformSupportMock = vi.mocked(fetchPlatformSupport);

const KEY = 'bdboard.chat.thread.v2';

function thread(sessionId: string, title: string): ChatThreadDto {
  return { sessionId, agentId: 'claude', title, pinned: false, updatedAt: '2026-01-01T00:00:00Z' };
}

const SERVER_A = thread('sess-a', 'server thread a');
const SERVER_B = thread('sess-b', 'server thread b');
const N1 = thread('sess-n1', 'hello one');
const N2 = thread('sess-n2', 'hello two');

/** POST /api/chat/message に、呼び出し順に sessionIds の sessionId を返す。スレッドの履歴 GET は空の履歴で答える。 */
function stubSends(sessionIds: readonly string[], agentId = 'claude') {
  let posts = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/chat/message' && init?.method === 'POST') {
        const sessionId = sessionIds[Math.min(posts, sessionIds.length - 1)];
        posts += 1;
        return jsonResponse({ reply: `AI reply ${posts}`, sessionId, agentId });
      }
      const history = /^\/api\/chat\/sessions\/([^/]+)\/messages/.exec(url);
      if (history !== null) return jsonResponse({ sessionId: history[1], agentId: 'claude', messages: [] });
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    }),
  );
}

/** fetchChatThreads の呼び出し順(1 回目 = E7)ごとに、一覧か保留(Deferred)か失敗(Error)を割り当てる。最後の値は繰り返す。 */
function scriptThreadLists(
  script: ReadonlyArray<ChatThreadDto[] | Error | ReturnType<typeof createDeferred<ChatThreadDto[]>>>,
) {
  let calls = 0;
  fetchChatThreadsMock.mockImplementation(() => {
    const entry = script[Math.min(calls, script.length - 1)];
    calls += 1;
    if (entry instanceof Error) return Promise.reject(entry);
    return Array.isArray(entry) ? Promise.resolve(entry) : entry.promise;
  });
}

function switcherTitle(container: HTMLElement) {
  return container.querySelector('.chat-thread-switcher-title');
}

function switcherCount(container: HTMLElement) {
  return container.querySelector('.chat-thread-switcher-count');
}

async function settleEffects() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function send(user: ReturnType<typeof userEvent.setup>, text: string, reply: number) {
  await user.type(screen.getByLabelText('メッセージ'), text);
  await user.click(screen.getByRole('button', { name: '送信' }));
  await screen.findByText(`AI reply ${reply}`);
}

/** ドラフトから 'hello one' を送り、新規スレッドで 'hello two' を送る(送信 N1 → 送信 N2)。 */
async function sendTwo(user: ReturnType<typeof userEvent.setup>) {
  await send(user, 'hello one', 1);
  await user.click(screen.getByRole('button', { name: '新しい空のスレッドを開始' }));
  await send(user, 'hello two', 2);
}

async function closeFromDrawer(container: HTMLElement, user: ReturnType<typeof userEvent.setup>, title: string) {
  const menu = await openThreadDrawerItemMenu(container, user, title);
  await user.click(within(menu).getByRole('menuitem', { name: /タブから閉じる/ }));
}

/** ドロワーの「閉じたスレッド」から title のスレッドを選ぶ = reopenClosedThread。 */
async function reopenFromDrawer(container: HTMLElement, user: ReturnType<typeof userEvent.setup>, title: string) {
  openThreadDrawer(container);
  await user.click(await within(getThreadDrawer(container)).findByRole('button', { name: title }));
}

function overlay(open: boolean) {
  return (
    <AppChatOverlay
      open={open}
      projects={[PROJECT_A]}
      initialProjectId="proj-a"
      initialInput={undefined}
      ticketContextToken={undefined}
      onProjectIdChange={vi.fn()}
      isTicketOnBoard={() => false}
      onOpenTicket={vi.fn()}
      onClose={vi.fn()}
    />
  );
}

describe('ChatPanel: the provisional-entry mark is stored, so reload and closing the panel do not lose it (bdboard-521p)', () => {
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

  describe('after a reload (a fresh mount that reads only the storage)', () => {
    it('opens the server list with the provisional [N] when the first list never landed', async () => {
      const user = userEvent.setup();
      scriptThreadLists([createDeferred<ChatThreadDto[]>()]);
      stubSends(['sess-new']);

      renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });
      await waitFor(() => expect(fetchChatThreadsMock).toHaveBeenCalledTimes(1));
      // 永続化エントリの無い初回訪問。初回の一覧が着地しないまま送信する(最初の永続化エントリ [sess-new] = 仮のエントリ)。
      await send(user, 'hello one', 1);
      expect(readPersistedChatThreads()['proj-a']).toEqual({
        activeSessionIds: ['sess-new'], selectedSessionId: 'sess-new', provisional: true,
      });

      // リロード: メモリの印は消える。残るのは localStorage だけ。
      cleanup();
      scriptThreadLists([[SERVER_A, SERVER_B, thread('sess-new', 'hello one')]]);
      const { container } = renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });
      await waitFor(() => expect(switcherCount(container)).toHaveTextContent('スレッド 3'));
      await settleEffects();

      // 仮の [sess-new] を再訪問の記録として扱わない: サーバー一覧と合わせて開き、選択は送信した会話のまま。
      expect(switcherTitle(container)).toHaveTextContent('hello one');
      // 広げて永続化を書き直したので、印は下りている(次の訪問で広げ直さない)。
      expect(readPersistedChatThreads()['proj-a']).toEqual({
        activeSessionIds: ['sess-a', 'sess-b', 'sess-new'], selectedSessionId: 'sess-new',
      });
      expect(localStorage.getItem(KEY)).not.toContain('provisional');
    });

    it('keeps a thread closed before the reload out of the opened server list', async () => {
      const user = userEvent.setup();
      scriptThreadLists([createDeferred<ChatThreadDto[]>()]);
      stubSends(['sess-n1', 'sess-n2']);

      const { container } = renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });
      await waitFor(() => expect(fetchChatThreadsMock).toHaveBeenCalledTimes(1));
      await sendTwo(user);
      await closeFromDrawer(container, user, 'hello one');
      expect(readPersistedChatThreads()['proj-a']).toEqual({
        activeSessionIds: ['sess-n2'],
        selectedSessionId: 'sess-n2',
        provisional: true,
        provisionalClosedSessionIds: ['sess-n1'],
      });

      cleanup();
      scriptThreadLists([[SERVER_A, SERVER_B, N1, N2]]);
      const reloaded = renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });
      await waitFor(() => expect(switcherCount(reloaded.container)).toHaveTextContent('スレッド 3'));
      await settleEffects();

      // 閉じた N1 は開き直さない。サーバー一覧(A/B)と、残した N2 で開く。
      expect(switcherTitle(reloaded.container)).toHaveTextContent('hello two');
      expect(readPersistedChatThreads()['proj-a']).toEqual({
        activeSessionIds: ['sess-a', 'sess-b', 'sess-n2'], selectedSessionId: 'sess-n2',
      });
    });

    it('opens a thread the user closed and then reopened before the reload', async () => {
      const user = userEvent.setup();
      scriptThreadLists([createDeferred<ChatThreadDto[]>()]);
      stubSends(['sess-n1', 'sess-n2']);

      const { container } = renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });
      await waitFor(() => expect(fetchChatThreadsMock).toHaveBeenCalledTimes(1));
      await sendTwo(user);
      await closeFromDrawer(container, user, 'hello one');
      await reopenFromDrawer(container, user, 'hello one');
      // 開き直した N1 は保存エントリの閉じた id から外れている。
      expect(readPersistedChatThreads()['proj-a']).toEqual({
        activeSessionIds: ['sess-n2', 'sess-n1'], selectedSessionId: 'sess-n1', provisional: true,
      });

      cleanup();
      scriptThreadLists([[SERVER_A, SERVER_B, N1, N2]]);
      const reloaded = renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });
      await waitFor(() => expect(switcherCount(reloaded.container)).toHaveTextContent('スレッド 4'));
      await settleEffects();

      expect(switcherTitle(reloaded.container)).toHaveTextContent('hello one');
      expect(readPersistedChatThreads()['proj-a']).toEqual({
        activeSessionIds: ['sess-a', 'sess-b', 'sess-n1', 'sess-n2'], selectedSessionId: 'sess-n1',
      });
    });

    it('opens the server list when the first list failed and a send wrote the first entry after the failure', async () => {
      const user = userEvent.setup();
      // 1 回目の E7 は失敗する(「復元済み」は立つが、サーバー一覧とは合わせていない)。
      scriptThreadLists([new Error('list down')]);
      stubSends(['sess-new']);

      renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });
      await waitFor(() => expect(fetchChatThreadsMock).toHaveBeenCalledTimes(1));
      await settleEffects();
      expect(readPersistedChatThreads()['proj-a']).toBeUndefined();
      await send(user, 'hello one', 1);
      // 失敗のあとに書かれた最初のエントリも仮のエントリ。
      expect(readPersistedChatThreads()['proj-a']).toEqual({
        activeSessionIds: ['sess-new'], selectedSessionId: 'sess-new', provisional: true,
      });

      cleanup();
      scriptThreadLists([[SERVER_A, SERVER_B, thread('sess-new', 'hello one')]]);
      const reloaded = renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });
      await waitFor(() => expect(switcherCount(reloaded.container)).toHaveTextContent('スレッド 3'));
      await settleEffects();
      expect(readPersistedChatThreads()['proj-a']).toEqual({
        activeSessionIds: ['sess-a', 'sess-b', 'sess-new'], selectedSessionId: 'sess-new',
      });
    });

    it('opens the server list on the next visit when the first list failed with no entry and no send, then a turn-status recovery landed', async () => {
      // 初回の一覧(E7)が失敗する(エントリは無いまま。「復元済み」は立つが、サーバー一覧とは合わせていない)。
      // 送信は無い。そのあと turn-status 回収が届く(サーバーの一覧は A/B と回収したセッションを持つ)。
      scriptThreadLists([new Error('list down'), [SERVER_A, SERVER_B, thread('sess-rec', 'recovered thread')]]);
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
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string, init?: RequestInit) => {
          if (url.startsWith('/api/chat/sessions/sess-rec/messages')) {
            return Promise.resolve(
              jsonResponse({
                sessionId: 'sess-rec',
                agentId: 'claude',
                messages: [
                  { role: 'user', content: 'recovered question', createdAt: '2026-08-18T11:59:00.000Z' },
                  { role: 'assistant', content: 'recovered reply', createdAt: '2026-08-18T12:00:00.000Z' },
                ],
              }),
            );
          }
          return Promise.reject(new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`));
        }),
      );

      const first = renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });
      await waitFor(() => expect(fetchChatThreadsMock).toHaveBeenCalledTimes(1));
      await settleEffects();
      expect(readPersistedChatThreads()['proj-a']).toBeUndefined();

      await act(async () => {
        statusGate.resolve();
        await statusGate.promise;
      });
      await waitFor(() => expect(acknowledgeChatTurnMock).toHaveBeenCalledWith('proj-a', 'sess-rec'));
      await settleEffects();

      // 回収は「復元済み」を鵜呑みにせず、一覧から復元する: 回収したセッション 1 つだけを利用者の記録として保存しない。
      expect(switcherCount(first.container)).toHaveTextContent('スレッド 3');
      // 選択は初回訪問の規則(永続化に選択が無ければ一覧の先頭)のまま。
      expect(readPersistedChatThreads()['proj-a']).toEqual({
        activeSessionIds: ['sess-a', 'sess-b', 'sess-rec'], selectedSessionId: 'sess-a',
      });
      expect(localStorage.getItem(KEY)).not.toContain('provisional');

      // 次の訪問: サーバー一覧が開く(保存が [sess-rec] だけなら、ここは 1 件になる)。
      cleanup();
      scriptThreadLists([[SERVER_A, SERVER_B, thread('sess-rec', 'recovered thread')]]);
      fetchChatTurnStatusMock.mockResolvedValue({ state: 'idle' });
      const next = renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });
      await waitFor(() => expect(switcherCount(next.container)).toHaveTextContent('スレッド 3'));
      await settleEffects();
      expect(readPersistedChatThreads()['proj-a']).toEqual({
        activeSessionIds: ['sess-a', 'sess-b', 'sess-rec'], selectedSessionId: 'sess-a',
      });
    });

    it('does not open the server list over the explicit empty an agent change wrote after a provisional send', async () => {
      const user = userEvent.setup();
      scriptThreadLists([createDeferred<ChatThreadDto[]>()]);
      stubSends(['sess-new'], 'example-agent');

      renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });
      await waitFor(() => expect(fetchChatThreadsMock).toHaveBeenCalledTimes(1));
      await send(user, 'hello one', 1);
      expect(readPersistedChatThreads()['proj-a']?.provisional).toBe(true);
      // 利用者がエージェントを切り替える: open は空に確定し、印は下りる(保存エントリからも)。
      await user.selectOptions(await screen.findByLabelText('チャットエージェント'), 'example-agent');
      expect(readPersistedChatThreads()['proj-a']).toEqual({ activeSessionIds: [] });

      cleanup();
      scriptThreadLists([[SERVER_A, SERVER_B]]);
      renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });
      await waitFor(() => expect(fetchChatThreadsMock).toHaveBeenCalledTimes(2));
      await settleEffects();

      // 空は利用者の記録のまま。A/B を開かない。
      expect(readPersistedChatThreads()['proj-a']).toEqual({ activeSessionIds: [] });
    });

    it('reads an old-format stored entry unchanged: the entry is the user record and the server list is not opened over it', async () => {
      // bdboard-521p 以前に書かれた形のリテラル(印のフィールドが無い)。
      localStorage.setItem(KEY, '{"proj-a":{"activeSessionIds":["sess-a"],"selectedSessionId":"sess-a"}}');
      scriptThreadLists([[SERVER_A, SERVER_B]]);
      stubSends(['sess-new']);

      const { container } = renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });
      await waitFor(() => expect(switcherTitle(container)).toHaveTextContent('server thread a'));
      await settleEffects();

      expect(switcherCount(container)).toHaveTextContent('スレッド 1');
      expect(JSON.parse(localStorage.getItem(KEY) ?? '{}')).toEqual({
        'proj-a': { activeSessionIds: ['sess-a'], selectedSessionId: 'sess-a' },
      });
    });
  });

  describe('after closing and reopening the chat panel (AppChatOverlay unmounts ChatPanel)', () => {
    it('opens the server list with the provisional [N] when the first list did not land before the panel was closed', async () => {
      const user = userEvent.setup();
      scriptThreadLists([createDeferred<ChatThreadDto[]>()]);
      stubSends(['sess-new']);

      const view = render(overlay(true));
      openChatSettings(view.container);
      await waitFor(() => expect(fetchChatThreadsMock).toHaveBeenCalledTimes(1));
      await send(user, 'hello one', 1);
      expect(readPersistedChatThreads()['proj-a']?.provisional).toBe(true);

      // パネルを閉じる(ChatPanel がアンマウントされる)。もう一度開く。
      view.rerender(overlay(false));
      expect(view.container.querySelector('.chat-thread-switcher-title')).toBeNull();
      scriptThreadLists([[SERVER_A, SERVER_B, thread('sess-new', 'hello one')]]);
      view.rerender(overlay(true));
      await waitFor(() => expect(switcherCount(view.container)).toHaveTextContent('スレッド 3'));
      await settleEffects();

      expect(switcherTitle(view.container)).toHaveTextContent('hello one');
      expect(readPersistedChatThreads()['proj-a']).toEqual({
        activeSessionIds: ['sess-a', 'sess-b', 'sess-new'], selectedSessionId: 'sess-new',
      });
    });

    it('keeps a thread closed before the panel was closed out of the opened server list', async () => {
      const user = userEvent.setup();
      scriptThreadLists([createDeferred<ChatThreadDto[]>()]);
      stubSends(['sess-n1', 'sess-n2']);

      const view = render(overlay(true));
      openChatSettings(view.container);
      await waitFor(() => expect(fetchChatThreadsMock).toHaveBeenCalledTimes(1));
      await sendTwo(user);
      await closeFromDrawer(view.container, user, 'hello one');

      view.rerender(overlay(false));
      scriptThreadLists([[SERVER_A, SERVER_B, N1, N2]]);
      view.rerender(overlay(true));
      await waitFor(() => expect(switcherCount(view.container)).toHaveTextContent('スレッド 3'));
      await settleEffects();

      expect(switcherTitle(view.container)).toHaveTextContent('hello two');
      expect(readPersistedChatThreads()['proj-a']).toEqual({
        activeSessionIds: ['sess-a', 'sess-b', 'sess-n2'], selectedSessionId: 'sess-n2',
      });
    });

    it('keeps the mark through a panel reopen whose own first list fails, and a later visit that reaches the server opens the list', async () => {
      const user = userEvent.setup();
      scriptThreadLists([createDeferred<ChatThreadDto[]>()]);
      stubSends(['sess-new']);

      const view = render(overlay(true));
      openChatSettings(view.container);
      await waitFor(() => expect(fetchChatThreadsMock).toHaveBeenCalledTimes(1));
      await send(user, 'hello one', 1);

      view.rerender(overlay(false));
      scriptThreadLists([new Error('list down')]);
      view.rerender(overlay(true));
      await waitFor(() => expect(fetchChatThreadsMock).toHaveBeenCalledTimes(2));
      await settleEffects();
      // 2 回目の訪問の一覧も失敗した: 仮のエントリは仮のまま。
      expect(readPersistedChatThreads()['proj-a']).toEqual({
        activeSessionIds: ['sess-new'], selectedSessionId: 'sess-new', provisional: true,
      });

      view.rerender(overlay(false));
      scriptThreadLists([[SERVER_A, SERVER_B, thread('sess-new', 'hello one')]]);
      view.rerender(overlay(true));
      await waitFor(() => expect(switcherCount(view.container)).toHaveTextContent('スレッド 3'));
      await settleEffects();
      expect(readPersistedChatThreads()['proj-a']).toEqual({
        activeSessionIds: ['sess-a', 'sess-b', 'sess-new'], selectedSessionId: 'sess-new',
      });
    });
  });
});
