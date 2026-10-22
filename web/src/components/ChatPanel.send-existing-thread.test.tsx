// bdboard-b1rz: 既存スレッドへ送信したとき、一覧の行が題名とピン留めを失わないことを ChatPanel 越しに固定する。
// 既存行があるときの足し込み(chat/threads.ts の appendSentThread)は、付けた名前とピンを残して updatedAt だけ進める。
// ただしサーバーでは題名が「付けた名前 ?? 最初のユーザー発言」(application/chat/list-chat-threads.ts)なので、
// 題名が null の既存行(= 名前も保存済みメッセージも無い。CLI セッションを採用した直後がそう)へのテキスト送信は
// それが最初の発言で、行の題名は送った文になる。残すだけにすると、次の一覧取得まで (無題) のままになる。
// 画像だけの送信では、サーバーが保存する IMAGE_ONLY の文言が一覧の題名になることも固定する。
// vi.mock はファイル単位でホイストされるため、他の ChatPanel.*.test.tsx と同じ vi.mock('../api', ...) ブロックと
// beforeEach/afterEach を複製している。

import { cleanup, screen } from '@testing-library/react';
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
  CODEX_IMAGE_AGENT,
  jsonResponse,
  pasteFiles,
  makeImageFile,
  selectThreadFromDrawer,
  renderChatPanel,
} from './ChatPanel-test-support';

const fetchChatAgentsMock = vi.mocked(fetchChatAgents);
const fetchChatThreadsMock = vi.mocked(fetchChatThreads);
const fetchChatTurnStatusMock = vi.mocked(fetchChatTurnStatus);
const acknowledgeChatTurnMock = vi.mocked(acknowledgeChatTurn);
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

  // サーバーの次の一覧と一致することを固定する。通常の UI 経路では修正前から通る。
  it('画像だけを送った題名なしスレッドは空白にならず、IMAGE_ONLY の文言が見出しになる', async () => {
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([CODEX_IMAGE_AGENT]);
    fetchChatThreadsMock.mockResolvedValue([
      { sessionId: 'sess-null', agentId: 'codex', title: null, pinned: false, updatedAt: '2026-08-16T12:00:00.000Z' },
    ]);
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/chat/sessions/sess-null/messages') {
        return Promise.resolve(jsonResponse({ sessionId: 'sess-null', agentId: 'codex', messages: [] }));
      }
      if (url === '/api/chat/message' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ reply: 'AI reply', sessionId: 'sess-null', agentId: 'codex' }));
      }
      return Promise.reject(new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    const { container } = renderChatPanel([PROJECT_A]);
    await selectThreadFromDrawer(container, user, '(無題)');
    pasteFiles(screen.getByLabelText('メッセージ'), [makeImageFile('only.png', 'image/png', 'png')]);
    await screen.findByAltText('送信前の添付画像: only.png');
    await user.click(screen.getByRole('button', { name: '送信' }));
    await screen.findByText('AI reply');

    const title = container.querySelector('.chat-thread-switcher-title');
    expect(title).toHaveTextContent('添付画像の内容を説明してください。');
    expect(title).not.toBeEmptyDOMElement();
    expect(JSON.parse(fetchMock.mock.calls.find(([url, init]) => url === '/api/chat/message' && init?.method === 'POST')?.[1]?.body as string))
      .toMatchObject({ sessionId: 'sess-null', agentId: 'codex', message: '添付画像の内容を説明してください。' });
  });
});
