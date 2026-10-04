// bdboard-b1rz: 既存スレッドへ送信したとき、一覧の行が題名とピン留めを失わないことを ChatPanel 越しに固定する。
// 既存行があるときの足し込み(chat/threads.ts の appendSentThread)は、付けた名前とピンを残して updatedAt だけ進める。
// ただしサーバーでは題名が「付けた名前 ?? 最初のユーザー発言」(application/chat/list-chat-threads.ts)なので、
// 題名が null の既存行(= 名前も保存済みメッセージも無い。CLI セッションを採用した直後がそう)への送信は
// それが最初の発言で、行の題名は送った文になる。残すだけにすると、次の一覧取得まで (無題) のままになる。
// vi.mock はファイル単位でホイストされるため、他の ChatPanel.*.test.tsx と同じ vi.mock('../api', ...) ブロックと
// beforeEach/afterEach を複製している。

import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatAgentDto, ChatThreadDto, ChatTurnStatusDto } from '../api';
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
  jsonResponse,
  getThreadDrawer,
  openThreadDrawer,
  renderChatPanel,
} from './ChatPanel-test-support';

const fetchChatAgentsMock = vi.mocked(fetchChatAgents);
const fetchChatThreadsMock = vi.mocked(fetchChatThreads);
const fetchChatTurnStatusMock = vi.mocked(fetchChatTurnStatus);
const acknowledgeChatTurnMock = vi.mocked(acknowledgeChatTurn);
const fetchDiscoveredChatSessionsMock = vi.mocked(fetchDiscoveredChatSessions);
const fetchPlatformSupportMock = vi.mocked(fetchPlatformSupport);

describe('ChatPanel: sending into an existing thread (bdboard-b1rz)', () => {
  beforeEach(() => {
    installFakeHistory({});
    localStorage.clear();
    resetPlatformSupportCache();
    fetchPlatformSupportMock.mockResolvedValue({ platform: 'darwin', limitations: [] });
    fetchChatAgentsMock.mockResolvedValue([CLAUDE_AGENT]);
    fetchChatTurnStatusMock.mockResolvedValue({ state: 'idle' });
    acknowledgeChatTurnMock.mockResolvedValue();
  });

  afterEach(() => {
    // bdboard-1ga8 と同じ作法: モックを reset する前にアンマウントし、E8 の呼び出しが次のテストへ持ち越されないようにする。
    try {
      cleanup();
    } finally {
      vi.unstubAllGlobals();
      vi.resetAllMocks();
      vi.restoreAllMocks();
    }
  });

  it('titles an adopted (untitled) thread with the sent text on its first send', async () => {
    const user = userEvent.setup();
    // 実サーバーと同じ: 採用直後の取り直し一覧では、採用したセッションは保存済みメッセージが無いので title: null。
    let adopted = false;
    fetchChatThreadsMock.mockImplementation(() =>
      Promise.resolve<ChatThreadDto[]>(
        adopted
          ? [{ sessionId: 'discovered-1', agentId: 'claude', title: null, pinned: false, updatedAt: '2026-08-16T12:00:00.000Z' }]
          : [],
      ),
    );
    fetchDiscoveredChatSessionsMock.mockResolvedValue({
      sessions: [{ sessionId: 'discovered-1', lastActivityAt: '2026-08-16T12:00:00.000Z', alreadyAdopted: false }],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        if (url === '/api/chat/projects/proj-a/discovered-sessions/discovered-1/adopt' && init?.method === 'POST') {
          adopted = true;
          return Promise.resolve(jsonResponse({ sessionId: 'discovered-1', agentId: 'claude', seedMessages: [] }));
        }
        if (url === '/api/chat/message' && init?.method === 'POST') {
          return Promise.resolve(jsonResponse({ reply: 'AI reply', sessionId: 'discovered-1', agentId: 'claude' }));
        }
        return Promise.reject(new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`));
      }),
    );

    const { container } = renderChatPanel([PROJECT_A]);
    openThreadDrawer(container);
    await user.click(within(getThreadDrawer(container)).getByRole('button', { name: 'CLIセッションを再開' }));
    await user.click(await screen.findByRole('button', { name: 'セッション discovered-1 を再開' }));
    await waitFor(() => expect(fetchChatThreadsMock.mock.calls.length).toBeGreaterThanOrEqual(2));
    const switcherTitle = () => container.querySelector('.chat-thread-switcher-title');
    await waitFor(() => expect(switcherTitle()).toHaveTextContent('(無題)'));

    await user.type(screen.getByLabelText('メッセージ'), 'my first question');
    await user.click(screen.getByRole('button', { name: '送信' }));
    expect(await screen.findByText('AI reply')).toBeInTheDocument();

    // サーバーの次の一覧ではこのセッションの題名は最初の発言になる。再取得を待たずに、見出しもそれになる。
    expect(switcherTitle()).toHaveTextContent('my first question');
  });
});
