// bdboard-sso1.83 第14段(会話キー再割り当てクラスタ)の「先に足すもの」: 登録簿
// (applyToDraftPayloadStores/migrateDraftPayloadKey/purgeDraftPayloadKeys)や
// startNewDraftThread 系をフックへ移す前に、今の main の挙動をこのファイルで固定する。
// - 14a: 登録簿の関数は E6(コールド解決)と E9(ticket-context)の依存配列に入って
//   いる。参照が毎レンダー変わると、両 effect が入力のたびに再実行される。effect の
//   再実行そのものは画面に出にくいので、両 effect が必ず読む `projects.some` の
//   呼び出し回数で「入力しても再実行されない」ことを見る。
// - T10 の追加パターン(設計書 §2 第14段): ticket 起動とコールドな projects の
//   API 呼び出し順の指紋。並び自体が正しいという主張ではなく、現状を固定する。
// vi.mock はファイル単位でホイストされるため、他の ChatPanel.*.test.tsx と同じ
// vi.mock('../api', ...) ブロックと beforeEach/afterEach を複製している。

import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatAgentDto, ChatThreadDto, ChatTurnStatusDto, ProjectDto } from '../api';
import { installFakeHistory } from '../test/fakeHistory';
import { ChatPanel } from './ChatPanel';

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
  fetchPlatformSupport,
} from '../api';
import { resetPlatformSupportCache } from './PlatformLimitationNotice';
import {
  PROJECT_A,
  CLAUDE_AGENT,
  createDeferred,
  jsonResponse,
  renderChatPanel,
} from './ChatPanel-test-support';

const fetchChatAgentsMock = vi.mocked(fetchChatAgents);
const fetchChatThreadsMock = vi.mocked(fetchChatThreads);
const fetchChatTurnStatusMock = vi.mocked(fetchChatTurnStatus);
const acknowledgeChatTurnMock = vi.mocked(acknowledgeChatTurn);
const fetchPlatformSupportMock = vi.mocked(fetchPlatformSupport);

const THREAD_1: ChatThreadDto = {
  sessionId: 'sess-1',
  agentId: 'claude',
  title: 'first thread',
  pinned: false,
  updatedAt: '2026-01-01T00:00:00Z',
};

/** 空の projects 配列の `.some` だけを数える(他の配列メソッドは素通し)。 */
function makeColdProjectsWithSomeSpy() {
  const projects: ProjectDto[] = [];
  const someSpy = vi.spyOn(projects, 'some');
  return { projects, someSpy };
}

describe('ChatPanel conversation-key reassignment characterization (bdboard-sso1.83 第14段の前提)', () => {
  beforeEach(() => {
    installFakeHistory({});
    localStorage.clear();
    resetPlatformSupportCache();
    fetchPlatformSupportMock.mockResolvedValue({ platform: 'darwin', limitations: [] });
    fetchChatAgentsMock.mockResolvedValue([]);
    fetchChatThreadsMock.mockResolvedValue([]);
    fetchChatTurnStatusMock.mockResolvedValue({ state: 'idle' });
    acknowledgeChatTurnMock.mockResolvedValue();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) =>
        Promise.reject(new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`)),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
    vi.restoreAllMocks();
  });

  describe('14a: the registry functions stay stable, so E6/E9 do not re-run on typing', () => {
    it('does not re-run the cold-resolution effect (E6) while typing a cold draft', async () => {
      // E6 は ticketContextToken が無く selectedProjectId==='' の間、実行のたびに
      // resolveInitialProjectId(projects, initialProjectId) → projects.some を呼ぶ。
      // deps の adoptProjectFromColdKeyspace は migrateDraftPayloadKey 経由で登録簿に
      // 依存するので、登録簿が不安定なら入力のたびに E6 が再実行されて数が増える。
      const { projects, someSpy } = makeColdProjectsWithSomeSpy();
      const user = userEvent.setup();
      renderChatPanel(projects, { initialProjectId: 'proj-b' });
      const textarea = screen.getByLabelText('メッセージ');
      await waitFor(() => expect(someSpy).toHaveBeenCalled());
      const baseline = someSpy.mock.calls.length;

      await user.type(textarea, 'cold draft');

      expect(textarea).toHaveValue('cold draft');
      expect(someSpy.mock.calls.length).toBe(baseline);
    });

    it('does not re-run the ticket-context effect (E9) while typing in the cold ticket window', async () => {
      // E9 は projects 未到着(S1)の間、実行のたびに requestedProjectFound の判定で
      // projects.some を呼んでから return する。deps の purgeDraftPayloadKeys が
      // 不安定なら入力のたびに E9 が再実行されて数が増える。
      const { projects, someSpy } = makeColdProjectsWithSomeSpy();
      const user = userEvent.setup();
      renderChatPanel(projects, {
        initialProjectId: 'proj-a',
        initialInput: 'proj-a のチケットについて: ',
        ticketContextToken: 1,
      });
      const textarea = screen.getByLabelText('メッセージ');
      await waitFor(() => expect(someSpy).toHaveBeenCalled());
      const baseline = someSpy.mock.calls.length;

      await user.type(textarea, 'x');

      expect(textarea).toHaveValue('proj-a のチケットについて: x');
      expect(someSpy.mock.calls.length).toBe(baseline);
    });
  });

  describe('14b: handleHistorySessionGone stays stable, so E12 keeps its in-flight history fetch', () => {
    it('does not discard and re-issue the history fetch while typing on the loading thread', async () => {
      // handleHistorySessionGone は useChatHistoryLoader(E12)へ onSessionGone として
      // 渡り、E12 の依存配列に入っている。参照が入力のたびに変わると、E12 の
      // cleanup が historyRequestIdRef を進めて走っている fetch を捨て、同じ
      // セッションの履歴を取り直す。第14b段で 23u の nonce 前進をフック側の関数に
      // 置き換えても、この参照が安定していることを固定する。
      const messages = createDeferred<Response>();
      let messageFetches = 0;
      fetchChatAgentsMock.mockResolvedValue([CLAUDE_AGENT]);
      fetchChatThreadsMock.mockResolvedValue([THREAD_1]);
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string) => {
          if (url.includes('/api/chat/sessions/sess-1/messages')) {
            messageFetches += 1;
            return messages.promise;
          }
          return Promise.reject(new Error(`Unexpected fetch: GET ${url}`));
        }),
      );
      const user = userEvent.setup();
      renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });
      await waitFor(() => expect(messageFetches).toBe(1));

      await user.type(screen.getByLabelText('メッセージ'), 'abc');
      expect(screen.getByLabelText('メッセージ')).toHaveValue('abc');
      expect(messageFetches).toBe(1);

      messages.resolve(jsonResponse({ sessionId: 'sess-1', agentId: 'claude', messages: [] }));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(messageFetches).toBe(1);
      expect(screen.getByLabelText('メッセージ')).toHaveValue('abc');
    });
  });

  describe('T10 additions: API call-order fingerprint for ticket launch and cold projects', () => {
    // waitFor は条件が揃った最初の瞬間に通るので、「この後に余計な呼び出しが
    // 来ない」ことは言えない。残りの effect とマイクロタスクを流してから、
    // 同じ並びをもう一度確かめる。
    async function settle() {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    function recordCalls() {
      const callOrder: string[] = [];
      fetchChatThreadsMock.mockImplementation((projectId: string) => {
        callOrder.push(`threads:${projectId}`);
        return Promise.resolve([THREAD_1]);
      });
      fetchChatTurnStatusMock.mockImplementation((projectId: string) => {
        callOrder.push(`turn-status:${projectId}`);
        return Promise.resolve({ state: 'idle' });
      });
      fetchChatAgentsMock.mockImplementation(() => {
        callOrder.push('agents');
        return Promise.resolve([CLAUDE_AGENT]);
      });
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string) => {
          if (url.includes('/api/chat/sessions/sess-1/messages')) {
            callOrder.push('messages:sess-1');
            return Promise.resolve(jsonResponse({ sessionId: 'sess-1', agentId: 'claude', messages: [] }));
          }
          return Promise.reject(new Error(`Unexpected fetch: GET ${url}`));
        }),
      );
      return callOrder;
    }

    it('fingerprints a warm ticket launch (the new draft wins, so no history fetch)', async () => {
      const callOrder = recordCalls();
      renderChatPanel([PROJECT_A], {
        initialProjectId: 'proj-a',
        initialInput: 'チケット: ',
        ticketContextToken: 1,
      });

      await waitFor(() => {
        expect(screen.getByLabelText('メッセージ')).toHaveValue('チケット: ');
        expect(callOrder).toEqual(['threads:proj-a', 'turn-status:proj-a', 'agents']);
      });
      await settle();
      expect(callOrder).toEqual(['threads:proj-a', 'turn-status:proj-a', 'agents']);
    });

    it('fingerprints a regular mount whose projects arrive later (cold window → E6 adopt)', async () => {
      const callOrder = recordCalls();
      const rendered = renderChatPanel([], { initialProjectId: 'proj-a' });
      await waitFor(() => expect(callOrder).toEqual(['agents']));

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
        expect(callOrder).toEqual(['agents', 'threads:proj-a', 'turn-status:proj-a', 'messages:sess-1']);
      });
      await settle();
      expect(callOrder).toEqual(['agents', 'threads:proj-a', 'turn-status:proj-a', 'messages:sess-1']);
    });

    it('fingerprints a ticket launch whose projects arrive later (cold window → E9 purge + pending draft)', async () => {
      const callOrder = recordCalls();
      const rendered = renderChatPanel([], {
        initialProjectId: 'proj-a',
        initialInput: 'チケット: ',
        ticketContextToken: 1,
      });
      await waitFor(() => expect(callOrder).toEqual(['agents']));

      rendered.rerender(
        <ChatPanel
          projects={[PROJECT_A]}
          initialProjectId="proj-a"
          initialInput="チケット: "
          ticketContextToken={1}
          isTicketOnBoard={rendered.isTicketOnBoard}
          onOpenTicket={rendered.onOpenTicket}
          onClose={rendered.onClose}
        />,
      );

      await waitFor(() => {
        expect(screen.getByLabelText('メッセージ')).toHaveValue('チケット: ');
        expect(callOrder).toEqual(['agents', 'threads:proj-a', 'turn-status:proj-a']);
      });
      await settle();
      expect(screen.getByLabelText('メッセージ')).toHaveValue('チケット: ');
      expect(callOrder).toEqual(['agents', 'threads:proj-a', 'turn-status:proj-a']);
    });
  });
});
