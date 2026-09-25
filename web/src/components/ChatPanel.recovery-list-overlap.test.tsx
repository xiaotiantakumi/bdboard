// bdboard-tsen: turn-status 回収(E8、chat/useTurnStatusRecovery.ts)の hydrate と、
// スレッド一覧の初回取得(E7、chat/useThreadListSync.ts)が重なったときの結果を固定する。
// 以前は hydrate が fetch の前にスレッド一覧の request-id を進めていたため、E7 の応答が
// 丸ごと捨てられ、E7 だけが担う (1) 永続化済みの open/選択の復元と (2) チケット起動の
// pending ドラフトの消化が行われなかった(回収したセッションだけが開き、永続化もそれで
// 上書きされた)。どちらの順に届いても、E7 → 回収 の順に届いたときと同じ open/選択に
// なり、pending ドラフトは消化されること。
// vi.mock はファイル単位でホイストされるため、他の ChatPanel.*.test.tsx と同じ
// vi.mock('../api', ...) ブロックと beforeEach/afterEach を複製している。

import { act, cleanup, screen, waitFor } from '@testing-library/react';
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
const THREAD_2 = thread('sess-2', 'second thread');
const RECOVERED_THREAD = thread('sess-rec', 'recovered thread');

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

function secondThreadMessagesResponse() {
  return jsonResponse({
    sessionId: 'sess-2',
    agentId: 'claude',
    messages: [{ role: 'user', content: 'second thread question', createdAt: '2026-01-01T00:00:00Z' }],
  });
}

/** ACK されるまで sess-rec の completed を返し、ACK の後は idle に落とす。 */
function mockCompletedUntilAcked() {
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

/** 1回目(E7 の初回取得)だけ保留し、2回目以降(回収の hydrate)は回収後の一覧を返す。 */
function holdInitialThreadList() {
  const initial = createDeferred<ChatThreadDto[]>();
  let calls = 0;
  fetchChatThreadsMock.mockImplementation(() => {
    calls += 1;
    return calls === 1 ? initial.promise : Promise.resolve([THREAD_1, THREAD_2, RECOVERED_THREAD]);
  });
  return initial;
}

/**
 * 永続化の open 集合と選択を比べる。順序は見ない: 選んだスレッドの履歴を読み込むと
 * writePersistedChatThread がそのスレッドを末尾へ移すため、回収と履歴読込のどちらが
 * 先に終わるかで並びが変わる(この修正とは無関係の既存の挙動)。
 */
function expectPersistedOpenAndSelected(open: string[], selected: string) {
  const persisted = readPersistedChatThreads()['proj-a'];
  expect([...(persisted?.activeSessionIds ?? [])].sort()).toEqual([...open].sort());
  expect(persisted?.selectedSessionId).toBe(selected);
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('ChatPanel: recovery hydrate overlapping the initial thread-list fetch (bdboard-tsen)', () => {
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

  it('restores the persisted open threads and selection when the hydrate lands before the initial list', async () => {
    writePersistedChatThreadState('proj-a', { activeSessionIds: ['sess-1', 'sess-2'], selectedSessionId: 'sess-2' });
    mockCompletedUntilAcked();
    const initial = holdInitialThreadList();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.startsWith('/api/chat/sessions/sess-rec/messages')) return Promise.resolve(recoveredMessagesResponse());
        if (url.startsWith('/api/chat/sessions/sess-2/messages')) return Promise.resolve(secondThreadMessagesResponse());
        return Promise.reject(new Error(`Unexpected fetch: GET ${url}`));
      }),
    );

    const { container } = renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });
    // ACK は applyRecoveredTurn の後。ここで回収は当たり、初回の一覧はまだ届いていない。
    await waitFor(() => expect(acknowledgeChatTurnMock).toHaveBeenCalledWith('proj-a', 'sess-rec'));
    expect(fetchChatThreadsMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      initial.resolve([THREAD_1, THREAD_2]);
      await initial.promise;
    });
    await settle();

    expectPersistedOpenAndSelected(['sess-1', 'sess-2', 'sess-rec'], 'sess-2');
    expect(container.querySelector('.chat-thread-switcher-title')).toHaveTextContent('second thread');
    expect(container.querySelector('.chat-thread-switcher-count')).toHaveTextContent('スレッド 3');
    expect(await screen.findByText('second thread question')).toBeInTheDocument();
  });

  it('keeps the initial list response that lands while the hydrate is still fetching', async () => {
    writePersistedChatThreadState('proj-a', { activeSessionIds: ['sess-1', 'sess-2'], selectedSessionId: 'sess-2' });
    mockCompletedUntilAcked();
    const initial = holdInitialThreadList();
    const recoveredMessages = createDeferred<Response>();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.startsWith('/api/chat/sessions/sess-rec/messages')) return recoveredMessages.promise;
        if (url.startsWith('/api/chat/sessions/sess-2/messages')) return secondThreadMessagesResponse();
        throw new Error(`Unexpected fetch: GET ${url}`);
      }),
    );

    const { container } = renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });
    // hydrate が一覧と履歴の fetch を始めた後に、初回の一覧が届く。
    await waitFor(() => expect(fetchChatThreadsMock).toHaveBeenCalledTimes(2));
    await act(async () => {
      initial.resolve([THREAD_1, THREAD_2]);
      await initial.promise;
    });
    await settle();
    await act(async () => {
      recoveredMessages.resolve(recoveredMessagesResponse());
      await recoveredMessages.promise;
    });
    await waitFor(() => expect(acknowledgeChatTurnMock).toHaveBeenCalledWith('proj-a', 'sess-rec'));
    await settle();

    expectPersistedOpenAndSelected(['sess-1', 'sess-2', 'sess-rec'], 'sess-2');
    expect(container.querySelector('.chat-thread-switcher-title')).toHaveTextContent('second thread');
    expect(container.querySelector('.chat-thread-switcher-count')).toHaveTextContent('スレッド 3');
  });

  it('still starts the ticket-launch draft when the hydrate lands before the initial list', async () => {
    mockCompletedUntilAcked();
    const initial = holdInitialThreadList();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.startsWith('/api/chat/sessions/sess-rec/messages')) return Promise.resolve(recoveredMessagesResponse());
        if (url.startsWith('/api/chat/sessions/sess-1/messages')) {
          return Promise.resolve(jsonResponse({ sessionId: 'sess-1', agentId: 'claude', messages: [] }));
        }
        return Promise.reject(new Error(`Unexpected fetch: GET ${url}`));
      }),
    );

    const { container } = renderChatPanel([PROJECT_A], {
      initialProjectId: 'proj-a',
      initialInput: 'proj-a のチケットについて: ',
      ticketContextToken: 1,
    });
    await waitFor(() => expect(acknowledgeChatTurnMock).toHaveBeenCalledWith('proj-a', 'sess-rec'));

    await act(async () => {
      initial.resolve([THREAD_1, THREAD_2]);
      await initial.promise;
    });
    await settle();

    // E7 が pending を消化して新しいドラフトを起こし、チケットのプリフィルがそこへ入る。
    expect(screen.getByLabelText('メッセージ')).toHaveValue('proj-a のチケットについて: ');
    expect(container.querySelector('.chat-thread-switcher-title')).not.toHaveTextContent('recovered thread');
    // 回収したセッションは開いている一覧に残る(ドラフトは永続化しない)。
    expect(readPersistedChatThreads()['proj-a']?.activeSessionIds).toContain('sess-rec');
  });

  it('keeps the ticket-launch draft selected when the recovery hydrate lands after the initial list already started it (bdboard-cemi)', async () => {
    mockCompletedUntilAcked();
    // E7(初回の一覧取得)はすぐ解決するが、まだ回収セッションを含まない
    // (サーバー側の一覧に載るのは turn 完了後)。hydrate 自身の2回目の
    // fetchChatThreads 呼び出しでは含まれる。
    let listCalls = 0;
    fetchChatThreadsMock.mockImplementation(() =>
      Promise.resolve(listCalls++ === 0 ? [THREAD_1, THREAD_2] : [THREAD_1, THREAD_2, RECOVERED_THREAD]),
    );
    const recoveredMessages = createDeferred<Response>();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.startsWith('/api/chat/sessions/sess-rec/messages')) return recoveredMessages.promise;
        return Promise.reject(new Error(`Unexpected fetch: GET ${url}`));
      }),
    );

    const { container } = renderChatPanel([PROJECT_A], {
      initialProjectId: 'proj-a',
      initialInput: 'proj-a のチケットについて: ',
      ticketContextToken: 1,
    });

    // bdboard-yv45: メッセージ欄の値は initialInput から初回レンダーで直接埋まるため、
    // それだけを待っても E7(初回一覧取得)のレンダーが終わった証明にならない。
    // draftNoncesRef / selectedThreadIdsRef (useConversationKey.ts) と openThreadIdsRef
    // (useChatThreadLists.ts) は effect ではなくレンダー本体で直接 `ref.current = state`
    // する mirror パターンなので、対応する state を更新したレンダーが一度でも走れば
    // 直後には最新化されている。問題は「その render がまだ走っていない」窓:
    // E7 の .then はここで一覧適用(setOpenThreadIds)とペンディングだったチケット
    // ドラフトの開始(setDraftNonces/setSelectedThreadIds)を同じコールバック内で
    // まとめて積むため、両方とも次の同一レンダーで一括して ref に反映される。
    // 「スレッド 2」(THREAD_1 + THREAD_2、openThreads.length 由来)の出現を待つのは、
    // まさにこのレンダーが完了した合図として使える(このテストで一覧件数が 2 になる
    // 経路は E7 の成功パスしか無い)。ここを省いて先に回収レスポンスを流すと、
    // useChatSessionLifecycle.ts の applyRecoveredTurn が古い(ドラフト開始前の)
    // draftNoncesRef/openThreadIdsRef を読んでしまい、isExplicitDraftStillSelected が
    // false と誤判定される → 復元経路(restoreThreadView)が古い openThreadIdsRef から
    // 選択を作り直し、実際には sess-1 (最初のスレッド)へ選択が倒れてチケットドラフトが
    // 無言で消える、という実プロダクションコードのレース (bdboard-d29q で draftNoncesRef/selectedThreadIdsRef 分を、bdboard-d7on で openThreadIdsRef 分を修正済み) が
    // CPU 負荷が高い環境で稀に再現していた。
    await waitFor(() =>
      expect(container.querySelector('.chat-thread-switcher-count')).toHaveTextContent('スレッド 2'),
    );
    expect(screen.getByLabelText('メッセージ')).toHaveValue('proj-a のチケットについて: ');

    await act(async () => {
      recoveredMessages.resolve(recoveredMessagesResponse());
      await recoveredMessages.promise;
    });
    await waitFor(() => expect(acknowledgeChatTurnMock).toHaveBeenCalledWith('proj-a', 'sess-rec'));
    await settle();

    expect(screen.getByLabelText('メッセージ')).toHaveValue('proj-a のチケットについて: ');
    expect(container.querySelector('.chat-thread-switcher-title')).not.toHaveTextContent('recovered thread');
    expect(readPersistedChatThreads()['proj-a']?.activeSessionIds).toContain('sess-rec');
  });
});
