// bdboard-sso1.83 第5段: ChatPanel.test.tsx から move-only で切り出したファイル
// (ChatPanel.stream-abort.test.tsx)。手本: sso1.85 の HygienePanel 分割。テスト本体・期待値・文言は
// 1文字も変えていない。共有の fixture/render ヘルパーは ChatPanel-test-support.tsx
// から import する。vi.mock はファイル単位でホイストされるため、元ファイルの
// vi.mock('../api', ...) ブロックと beforeEach/afterEach をこのファイルにも複製している。

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatAgentDto, ChatThreadDto, ChatTurnStatusDto } from '../api';
import { installFakeHistory } from '../test/fakeHistory';
import { readPersistedChatThreads } from '../chatThreadStorage';
import { ChatPanel } from './ChatPanel';

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
  CLAUDE_AGENT,
  STREAMING_AGENT,
  createDeferred,
  jsonResponse,
  getChatMessagePostCalls,
  parseChatMessageBody,
  openThreadDrawer,
  getThreadDrawer,
  selectThreadFromDrawer,
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
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: defaultWindowInnerWidth,
    });
    vi.unstubAllGlobals();
    vi.resetAllMocks();
    vi.restoreAllMocks();
  });

  describe('streaming abort on unmount / conversation switch (bdboard-7st)', () => {
    function makeGatedStreamingFetchMock(
      fetchMock: ReturnType<typeof vi.fn>,
      options: { capturedSignal?: { current: AbortSignal | undefined } } = {},
    ) {
      let releaseRemainingChunks: () => void = () => {};
      const remainingChunksGate = new Promise<void>((resolve) => {
        releaseRemainingChunks = resolve;
      });
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === '/api/chat/message/stream' && init?.method === 'POST') {
          if (options.capturedSignal !== undefined) {
            options.capturedSignal.current = init.signal ?? undefined;
          }
          return new Response(
            new ReadableStream({
              async start(controller) {
                controller.enqueue(
                  new TextEncoder().encode('event: delta\ndata: {"text":"partial "}\n\n'),
                );
                init.signal?.addEventListener('abort', () => {
                  controller.error(
                    new DOMException('The operation was aborted.', 'AbortError'),
                  );
                });
                await remainingChunksGate;
                controller.enqueue(
                  new TextEncoder().encode(
                    'event: done\ndata: {"reply":"partial reply","sessionId":"sess-stream","agentId":"claude"}\n\n',
                  ),
                );
                controller.close();
              },
            }),
          );
        }
        throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
      });
      return { releaseRemainingChunks };
    }

    it('aborts the fetch signal on unmount while streaming', async () => {
      const user = userEvent.setup();
      fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
      const capturedSignal: { current: AbortSignal | undefined } = { current: undefined };
      makeGatedStreamingFetchMock(fetchMock, { capturedSignal });

      const view = renderChatPanel([PROJECT_A]);
      await screen.findByLabelText('チャットエージェント');
      await user.type(screen.getByLabelText('メッセージ'), 'stream then unmount');
      await user.click(screen.getByRole('button', { name: '送信' }));

      const messages = screen.getByRole('log');
      await waitFor(() => {
        const streamingText = messages.querySelector('.chat-message-streaming .chat-message-text');
        expect(streamingText).not.toBeNull();
        expect(streamingText?.textContent).toBe('partial ');
      });
      expect(capturedSignal.current).toBeDefined();

      view.unmount();
      await waitFor(() => {
        expect(capturedSignal.current?.aborted).toBe(true);
      });
    });

    it('aborts the fetch signal when switching threads while streaming', async () => {
      const user = userEvent.setup();
      fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
      fetchChatThreadsMock.mockResolvedValue([
        {
          sessionId: 'sess-1',
          agentId: 'claude',
          title: 'first thread',
          pinned: false,
          updatedAt: '2026-01-02T00:00:00Z',
        },
        {
          sessionId: 'sess-2',
          agentId: 'claude',
          title: 'second thread',
          pinned: false,
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ]);
      const capturedSignal: { current: AbortSignal | undefined } = { current: undefined };
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes('/api/chat/sessions/sess-1/messages')) {
          return jsonResponse({ sessionId: 'sess-1', agentId: 'claude', messages: [] });
        }
        if (url.includes('/api/chat/sessions/sess-2/messages')) {
          return jsonResponse({ sessionId: 'sess-2', agentId: 'claude', messages: [] });
        }
        if (url === '/api/chat/message/stream' && init?.method === 'POST') {
          capturedSignal.current = init.signal ?? undefined;
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode('event: delta\ndata: {"text":"partial "}\n\n'),
                );
                init.signal?.addEventListener('abort', () => {
                  controller.error(
                    new DOMException('The operation was aborted.', 'AbortError'),
                  );
                });
              },
            }),
          );
        }
        throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
      });

      const { container } = renderChatPanel([PROJECT_A]);
      openThreadDrawer(container);
      expect(
        await within(getThreadDrawer(container)).findByRole('button', { name: 'first thread' }),
      ).toBeInTheDocument();

      await user.type(screen.getByLabelText('メッセージ'), 'message for first');
      await user.click(screen.getByRole('button', { name: '送信' }));

      const messages = screen.getByRole('log');
      await waitFor(() => {
        expect(messages.querySelector('.chat-message-streaming')).not.toBeNull();
      });
      expect(capturedSignal.current).toBeDefined();

      await selectThreadFromDrawer(container, user, 'second thread');

      await waitFor(() => {
        expect(capturedSignal.current?.aborted).toBe(true);
      });
      expect(messages.querySelector('.chat-message-streaming')).toBeNull();
    });

    it('recovers a detached reply after switching threads within the same project', async () => {
      const user = userEvent.setup();
      fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
      const threads: ChatThreadDto[] = [
        {
          sessionId: 'sess-1',
          agentId: 'claude',
          title: 'first thread',
          pinned: false,
          updatedAt: '2026-01-02T00:00:00Z',
        },
        {
          sessionId: 'sess-2',
          agentId: 'claude',
          title: 'second thread',
          pinned: false,
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ];
      fetchChatThreadsMock.mockResolvedValue(threads);
      fetchChatTurnStatusMock
        .mockResolvedValueOnce({ state: 'idle' })
        .mockResolvedValueOnce({ state: 'processing' })
        .mockResolvedValue({
          state: 'completed',
          sessionId: 'sess-1',
          agentId: 'claude',
          completedAt: '2026-08-18T12:00:00.000Z',
        });
      let sess1HistoryCalls = 0;
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes('/api/chat/sessions/sess-1/messages')) {
          sess1HistoryCalls += 1;
          return jsonResponse({
            sessionId: 'sess-1',
            agentId: 'claude',
            messages:
              sess1HistoryCalls === 1
                ? []
                : [
                    {
                      role: 'user',
                      content: 'finish after switch',
                      createdAt: '2026-08-18T11:59:00.000Z',
                    },
                    {
                      role: 'assistant',
                      content: 'recovered detached reply',
                      createdAt: '2026-08-18T12:00:00.000Z',
                    },
                  ],
          });
        }
        if (url.includes('/api/chat/sessions/sess-2/messages')) {
          return jsonResponse({ sessionId: 'sess-2', agentId: 'claude', messages: [] });
        }
        if (url === '/api/chat/message/stream' && init?.method === 'POST') {
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    'event: delta\ndata: {"text":"partial "}\n\n',
                  ),
                );
                init.signal?.addEventListener('abort', () => {
                  controller.error(
                    new DOMException('The operation was aborted.', 'AbortError'),
                  );
                });
              },
            }),
          );
        }
        throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
      });

      const { container } = renderChatPanel([PROJECT_A]);
      openThreadDrawer(container);
      expect(
        await within(getThreadDrawer(container)).findByRole('button', { name: 'first thread' }),
      ).toBeInTheDocument();
      await user.type(screen.getByLabelText('メッセージ'), 'finish after switch');
      await user.click(screen.getByRole('button', { name: '送信' }));
      await waitFor(() => {
        expect(screen.getByRole('log').querySelector('.chat-message-streaming')).not.toBeNull();
      });

      await selectThreadFromDrawer(container, user, 'second thread');
      expect(
        await screen.findByText('返信をバックグラウンドで処理中…'),
      ).toBeInTheDocument();
      expect(
        await screen.findByText(
          'バックグラウンドの返信が完了しました。',
          {},
          { timeout: 2_500 },
        ),
      ).toBeInTheDocument();

      await selectThreadFromDrawer(container, user, 'first thread');
      expect(
        await screen.findByText('recovered detached reply'),
      ).toBeInTheDocument();
      expect(sess1HistoryCalls).toBeGreaterThanOrEqual(2);
    });

    it('keeps polling and recovers a detached reply after turn-status fails once during abort recovery (bdboard-3tw.164)', async () => {
      const user = userEvent.setup();
      fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
      const threads: ChatThreadDto[] = [
        {
          sessionId: 'sess-1',
          agentId: 'claude',
          title: 'first thread',
          pinned: false,
          updatedAt: '2026-01-02T00:00:00Z',
        },
        {
          sessionId: 'sess-2',
          agentId: 'claude',
          title: 'second thread',
          pinned: false,
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ];
      fetchChatThreadsMock.mockResolvedValue(threads);
      // スレッド切替による abort 回収の1回目の turn-status 取得がネットワーク
      // エラーで失敗する (bdboard-3tw.164)。以前はここでポーリングが止まり、完走した
      // ターンが取りこぼされていた。
      fetchChatTurnStatusMock
        .mockResolvedValueOnce({ state: 'idle' })
        .mockRejectedValueOnce(new TypeError('network hiccup'))
        .mockResolvedValueOnce({ state: 'processing' })
        .mockResolvedValue({
          state: 'completed',
          sessionId: 'sess-1',
          agentId: 'claude',
          completedAt: '2026-08-18T12:00:00.000Z',
        });
      let sess1HistoryCalls = 0;
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes('/api/chat/sessions/sess-1/messages')) {
          sess1HistoryCalls += 1;
          return jsonResponse({
            sessionId: 'sess-1',
            agentId: 'claude',
            messages:
              sess1HistoryCalls === 1
                ? []
                : [
                    {
                      role: 'user',
                      content: 'finish after switch',
                      createdAt: '2026-08-18T11:59:00.000Z',
                    },
                    {
                      role: 'assistant',
                      content: 'recovered after a retry',
                      createdAt: '2026-08-18T12:00:00.000Z',
                    },
                  ],
          });
        }
        if (url.includes('/api/chat/sessions/sess-2/messages')) {
          return jsonResponse({ sessionId: 'sess-2', agentId: 'claude', messages: [] });
        }
        if (url === '/api/chat/message/stream' && init?.method === 'POST') {
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    'event: delta\ndata: {"text":"partial "}\n\n',
                  ),
                );
                init.signal?.addEventListener('abort', () => {
                  controller.error(
                    new DOMException('The operation was aborted.', 'AbortError'),
                  );
                });
              },
            }),
          );
        }
        throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
      });

      const { container } = renderChatPanel([PROJECT_A]);
      openThreadDrawer(container);
      expect(
        await within(getThreadDrawer(container)).findByRole('button', { name: 'first thread' }),
      ).toBeInTheDocument();
      await user.type(screen.getByLabelText('メッセージ'), 'finish after switch');
      await user.click(screen.getByRole('button', { name: '送信' }));
      await waitFor(() => {
        expect(screen.getByRole('log').querySelector('.chat-message-streaming')).not.toBeNull();
      });

      await selectThreadFromDrawer(container, user, 'second thread');
      expect(
        await screen.findByText('返信をバックグラウンドで処理中…', {}, { timeout: 2_500 }),
      ).toBeInTheDocument();
      expect(
        await screen.findByText(
          'バックグラウンドの返信が完了しました。',
          {},
          { timeout: 2_500 },
        ),
      ).toBeInTheDocument();

      await selectThreadFromDrawer(container, user, 'first thread');
      expect(
        await screen.findByText('recovered after a retry'),
      ).toBeInTheDocument();
      expect(sess1HistoryCalls).toBeGreaterThanOrEqual(2);
    });

    it('refetches the thread on return when the recovery poll never saw its completion (bdboard-3tw.156)', async () => {
      // 回収機構は「プロジェクト単位の未回収完了」を1件ずつ受け取る仕組みなので、
      // サーバー再起動や回収の取りこぼしで完了を一度も観測できないことがありうる。
      // その場合でも、送信したスレッドへ戻れば履歴を取り直して返信が出ること。
      const user = userEvent.setup();
      fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
      fetchChatThreadsMock.mockResolvedValue([
        { sessionId: 'sess-1', agentId: 'claude', title: 'first thread', pinned: false, updatedAt: '2026-01-02T00:00:00Z' },
        { sessionId: 'sess-2', agentId: 'claude', title: 'second thread', pinned: false, updatedAt: '2026-01-01T00:00:00Z' },
      ]);
      // 完了は一度も観測できない。
      fetchChatTurnStatusMock.mockResolvedValue({ state: 'idle' });
      let sess1HistoryCalls = 0;
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes('/api/chat/sessions/sess-1/messages')) {
          sess1HistoryCalls += 1;
          return jsonResponse({
            sessionId: 'sess-1',
            agentId: 'claude',
            messages:
              sess1HistoryCalls === 1
                ? []
                : [
                    { role: 'user', content: 'finish after switch', createdAt: '2026-08-18T11:59:00.000Z' },
                    { role: 'assistant', content: 'reply nobody announced', createdAt: '2026-08-18T12:00:00.000Z' },
                  ],
          });
        }
        if (url.includes('/api/chat/sessions/sess-2/messages')) {
          return jsonResponse({ sessionId: 'sess-2', agentId: 'claude', messages: [] });
        }
        if (url === '/api/chat/message/stream' && init?.method === 'POST') {
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('event: delta\ndata: {"text":"partial "}\n\n'));
                init.signal?.addEventListener('abort', () => {
                  controller.error(new DOMException('The operation was aborted.', 'AbortError'));
                });
              },
            }),
          );
        }
        throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
      });

      const { container } = renderChatPanel([PROJECT_A]);
      openThreadDrawer(container);
      expect(
        await within(getThreadDrawer(container)).findByRole('button', { name: 'first thread' }),
      ).toBeInTheDocument();
      await user.type(screen.getByLabelText('メッセージ'), 'finish after switch');
      await user.click(screen.getByRole('button', { name: '送信' }));
      await waitFor(() => {
        expect(screen.getByRole('log').querySelector('.chat-message-streaming')).not.toBeNull();
      });

      await selectThreadFromDrawer(container, user, 'second thread');
      await selectThreadFromDrawer(container, user, 'first thread');

      expect(await screen.findByText('reply nobody announced')).toBeInTheDocument();
      expect(sess1HistoryCalls).toBeGreaterThanOrEqual(2);
    });

    it('refetches on return after a bulk (non-streaming) send was abandoned (bdboard-3tw.156)', async () => {
      // ストリーミング非対応エージェントの経路にも同じ安全網が要る。
      const user = userEvent.setup();
      fetchChatAgentsMock.mockResolvedValue([CLAUDE_AGENT]);
      fetchChatThreadsMock.mockResolvedValue([
        { sessionId: 'sess-1', agentId: 'claude', title: 'first thread', pinned: false, updatedAt: '2026-01-02T00:00:00Z' },
        { sessionId: 'sess-2', agentId: 'claude', title: 'second thread', pinned: false, updatedAt: '2026-01-01T00:00:00Z' },
      ]);
      fetchChatTurnStatusMock.mockResolvedValue({ state: 'idle' });
      let sess1HistoryCalls = 0;
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes('/api/chat/sessions/sess-1/messages')) {
          sess1HistoryCalls += 1;
          return jsonResponse({
            sessionId: 'sess-1',
            agentId: 'claude',
            messages:
              sess1HistoryCalls === 1
                ? []
                : [
                    { role: 'user', content: 'bulk before switch', createdAt: '2026-08-18T11:59:00.000Z' },
                    { role: 'assistant', content: 'bulk reply nobody announced', createdAt: '2026-08-18T12:00:00.000Z' },
                  ],
          });
        }
        if (url.includes('/api/chat/sessions/sess-2/messages')) {
          return jsonResponse({ sessionId: 'sess-2', agentId: 'claude', messages: [] });
        }
        if (url === '/api/chat/message' && init?.method === 'POST') {
          return await new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            });
          });
        }
        throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
      });

      const { container } = renderChatPanel([PROJECT_A]);
      openThreadDrawer(container);
      expect(
        await within(getThreadDrawer(container)).findByRole('button', { name: 'first thread' }),
      ).toBeInTheDocument();
      await user.type(screen.getByLabelText('メッセージ'), 'bulk before switch');
      await user.click(screen.getByRole('button', { name: '送信' }));
      await screen.findByText('bulk before switch');

      await selectThreadFromDrawer(container, user, 'second thread');
      await selectThreadFromDrawer(container, user, 'first thread');

      expect(await screen.findByText('bulk reply nobody announced')).toBeInTheDocument();
    });

    it('refetches on return even when the session hit the message cap and history length did not grow (bdboard-3tw.158)', async () => {
      // PR#135 レビュー minor-2 の既知の限界: 保存件数が上限
      // (CHAT_MESSAGES_MAX_PER_SESSION) に達したセッションでは、サーバーが
      // 古い方から捨てて件数を保つため、取りこぼしたターンが載っても件数の
      // 見た目は伸びない。件数比較だけに頼るとこの安全網が永久に効かない
      // ((payload.messages.length <= localCount) のまま)。末尾メッセージの
      // createdAt が伸びていれば、件数が同じでも適用されることを確認する。
      const user = userEvent.setup();
      const sentAt = new Date('2026-03-01T00:00:00.000Z').getTime();
      const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(sentAt);
      fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
      fetchChatThreadsMock.mockResolvedValue([
        { sessionId: 'sess-1', agentId: 'claude', title: 'first thread', pinned: false, updatedAt: '2026-01-02T00:00:00Z' },
        { sessionId: 'sess-2', agentId: 'claude', title: 'second thread', pinned: false, updatedAt: '2026-01-01T00:00:00Z' },
      ]);
      fetchChatTurnStatusMock.mockResolvedValue({ state: 'idle' });
      let sess1HistoryCalls = 0;
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes('/api/chat/sessions/sess-1/messages')) {
          sess1HistoryCalls += 1;
          return jsonResponse({
            sessionId: 'sess-1',
            agentId: 'claude',
            messages:
              sess1HistoryCalls === 1
                ? [{ role: 'assistant', content: 'old message dropped by the cap', createdAt: '2020-01-01T00:00:00.000Z' }]
                : [
                    // 上限到達により古い1件が捨てられ、件数は送信前後で 1 → 2 → 2
                    // のまま伸びない(件数比較だけでは検知できない)。末尾の
                    // createdAt は送信時刻(sentAt)より後なので、取りこぼしは
                    // これで検知できる。
                    { role: 'user', content: 'finish after switch', createdAt: '2026-03-01T00:00:05.000Z' },
                    { role: 'assistant', content: 'reply nobody announced', createdAt: '2026-03-01T00:00:10.000Z' },
                  ],
          });
        }
        if (url.includes('/api/chat/sessions/sess-2/messages')) {
          return jsonResponse({ sessionId: 'sess-2', agentId: 'claude', messages: [] });
        }
        if (url === '/api/chat/message/stream' && init?.method === 'POST') {
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('event: delta\ndata: {"text":"partial "}\n\n'));
                init.signal?.addEventListener('abort', () => {
                  controller.error(new DOMException('The operation was aborted.', 'AbortError'));
                });
              },
            }),
          );
        }
        throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
      });

      const { container } = renderChatPanel([PROJECT_A]);
      openThreadDrawer(container);
      expect(
        await within(getThreadDrawer(container)).findByRole('button', { name: 'first thread' }),
      ).toBeInTheDocument();
      await screen.findByText('old message dropped by the cap');
      await user.type(screen.getByLabelText('メッセージ'), 'finish after switch');
      await user.click(screen.getByRole('button', { name: '送信' }));
      await waitFor(() => {
        expect(screen.getByRole('log').querySelector('.chat-message-streaming')).not.toBeNull();
      });

      await selectThreadFromDrawer(container, user, 'second thread');
      await selectThreadFromDrawer(container, user, 'first thread');

      expect(await screen.findByText('reply nobody announced')).toBeInTheDocument();
      expect(sess1HistoryCalls).toBeGreaterThanOrEqual(2);
      dateNowSpy.mockRestore();
    });

    it('keeps the unresolved mark when a later send on the same thread succeeds (PR#135 レビュー minor-1)', async () => {
      // 見届けられなかったスレッドへ戻り、取り直しが当たる前に次を送信した場合。
      // 送信成功で印を外してしまうと、取りこぼした返信を二度と取りに行かなくなる。
      //
      // サーバー履歴は「まだ追いついていない」状態に固定しておき、取り直しが
      // 空振りし続けるようにする。印が残っていれば、履歴が追いついたあとに
      // もう一度スレッドを開いた時点で拾える。
      const user = userEvent.setup();
      fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
      fetchChatThreadsMock.mockResolvedValue([
        { sessionId: 'sess-1', agentId: 'claude', title: 'first thread', pinned: false, updatedAt: '2026-01-02T00:00:00Z' },
        { sessionId: 'sess-2', agentId: 'claude', title: 'second thread', pinned: false, updatedAt: '2026-01-01T00:00:00Z' },
      ]);
      // 回収経路は最後まで完了を観測しない。
      fetchChatTurnStatusMock.mockResolvedValue({ state: 'idle' });
      let sess1HistoryCalls = 0;
      let serverCaughtUp = false;
      let streamCalls = 0;
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes('/api/chat/sessions/sess-1/messages')) {
          sess1HistoryCalls += 1;
          if (sess1HistoryCalls === 1) {
            return jsonResponse({ sessionId: 'sess-1', agentId: 'claude', messages: [] });
          }
          if (!serverCaughtUp) {
            // ローカル(楽観表示)より短いので、長さガードに弾かれて当たらない。
            // = 印はここでは外れない。
            return jsonResponse({
              sessionId: 'sess-1',
              agentId: 'claude',
              messages: [
                { role: 'user', content: 'abandoned send', createdAt: '2026-08-18T11:59:00.000Z' },
              ],
            });
          }
          return jsonResponse({
            sessionId: 'sess-1',
            agentId: 'claude',
            messages: [
              { role: 'user', content: 'abandoned send', createdAt: '2026-08-18T11:59:00.000Z' },
              { role: 'assistant', content: 'reply nobody announced', createdAt: '2026-08-18T12:00:00.000Z' },
              { role: 'user', content: 'second send', createdAt: '2026-08-18T12:01:00.000Z' },
              { role: 'assistant', content: 'second reply', createdAt: '2026-08-18T12:02:00.000Z' },
            ],
          });
        }
        if (url.includes('/api/chat/sessions/sess-2/messages')) {
          return jsonResponse({ sessionId: 'sess-2', agentId: 'claude', messages: [] });
        }
        if (url === '/api/chat/message/stream' && init?.method === 'POST') {
          streamCalls += 1;
          if (streamCalls === 1) {
            // 1本目はスレッド切替で abort される = 印が立つ。
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode('event: delta\ndata: {"text":"partial "}\n\n'));
                  init.signal?.addEventListener('abort', () => {
                    controller.error(new DOMException('The operation was aborted.', 'AbortError'));
                  });
                },
              }),
            );
          }
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    'event: done\ndata: {"reply":"second reply","sessionId":"sess-1","agentId":"claude"}\n\n',
                  ),
                );
                controller.close();
              },
            }),
          );
        }
        throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
      });

      const { container } = renderChatPanel([PROJECT_A]);
      openThreadDrawer(container);
      expect(
        await within(getThreadDrawer(container)).findByRole('button', { name: 'first thread' }),
      ).toBeInTheDocument();
      await user.type(screen.getByLabelText('メッセージ'), 'abandoned send');
      await user.click(screen.getByRole('button', { name: '送信' }));
      await waitFor(() => {
        expect(screen.getByRole('log').querySelector('.chat-message-streaming')).not.toBeNull();
      });

      // 切替で abort → 戻る。戻った直後の取り直しは空振りする。
      await selectThreadFromDrawer(container, user, 'second thread');
      await selectThreadFromDrawer(container, user, 'first thread');
      await waitFor(() => expect(sess1HistoryCalls).toBeGreaterThanOrEqual(2));
      expect(screen.queryByText('reply nobody announced')).toBeNull();

      // 同じスレッドで次を送って成功させる。ここで印を外す実装だと、以後
      // 取りこぼした返信を取りに行かなくなる。
      await user.type(screen.getByLabelText('メッセージ'), 'second send');
      await user.click(screen.getByRole('button', { name: '送信' }));
      expect(await screen.findByText('second reply')).toBeInTheDocument();
      expect(screen.queryByText('reply nobody announced')).toBeNull();

      // サーバー履歴が追いついた状態でもう一度開く。印が残っていれば拾える。
      // 送信成功でスレッドのタイトルは送った本文に置き換わるので、戻るときの
      // 見出しは 'second send'。
      serverCaughtUp = true;
      await selectThreadFromDrawer(container, user, 'second thread');
      await selectThreadFromDrawer(container, user, 'second send');

      expect(await screen.findByText('reply nobody announced')).toBeInTheDocument();
    });

    it('recovers without leaving the thread once the next turn lands (PR#135 レビュー minor-1)', async () => {
      // 上のテストの姉妹。印が残っているだけでは「次にスレッドを開くまで」
      // 待たされる。同じスレッドに留まったまま次のターンが終わった時点で
      // 取り直しへ戻れること (安全網 effect が会話の件数変化でも起きること)。
      const user = userEvent.setup();
      fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
      fetchChatThreadsMock.mockResolvedValue([
        { sessionId: 'sess-1', agentId: 'claude', title: 'first thread', pinned: false, updatedAt: '2026-01-02T00:00:00Z' },
        { sessionId: 'sess-2', agentId: 'claude', title: 'second thread', pinned: false, updatedAt: '2026-01-01T00:00:00Z' },
      ]);
      fetchChatTurnStatusMock.mockResolvedValue({ state: 'idle' });
      let sess1HistoryCalls = 0;
      let serverCaughtUp = false;
      let streamCalls = 0;
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes('/api/chat/sessions/sess-1/messages')) {
          sess1HistoryCalls += 1;
          if (sess1HistoryCalls === 1) {
            return jsonResponse({ sessionId: 'sess-1', agentId: 'claude', messages: [] });
          }
          if (!serverCaughtUp) {
            return jsonResponse({
              sessionId: 'sess-1',
              agentId: 'claude',
              messages: [
                { role: 'user', content: 'abandoned send', createdAt: '2026-08-18T11:59:00.000Z' },
              ],
            });
          }
          return jsonResponse({
            sessionId: 'sess-1',
            agentId: 'claude',
            messages: [
              { role: 'user', content: 'abandoned send', createdAt: '2026-08-18T11:59:00.000Z' },
              { role: 'assistant', content: 'reply nobody announced', createdAt: '2026-08-18T12:00:00.000Z' },
              { role: 'user', content: 'second send', createdAt: '2026-08-18T12:01:00.000Z' },
              { role: 'assistant', content: 'second reply', createdAt: '2026-08-18T12:02:00.000Z' },
            ],
          });
        }
        if (url.includes('/api/chat/sessions/sess-2/messages')) {
          return jsonResponse({ sessionId: 'sess-2', agentId: 'claude', messages: [] });
        }
        if (url === '/api/chat/message/stream' && init?.method === 'POST') {
          streamCalls += 1;
          if (streamCalls === 1) {
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode('event: delta\ndata: {"text":"partial "}\n\n'));
                  init.signal?.addEventListener('abort', () => {
                    controller.error(new DOMException('The operation was aborted.', 'AbortError'));
                  });
                },
              }),
            );
          }
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    'event: done\ndata: {"reply":"second reply","sessionId":"sess-1","agentId":"claude"}\n\n',
                  ),
                );
                controller.close();
              },
            }),
          );
        }
        throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
      });

      const { container } = renderChatPanel([PROJECT_A]);
      openThreadDrawer(container);
      expect(
        await within(getThreadDrawer(container)).findByRole('button', { name: 'first thread' }),
      ).toBeInTheDocument();
      await user.type(screen.getByLabelText('メッセージ'), 'abandoned send');
      await user.click(screen.getByRole('button', { name: '送信' }));
      await waitFor(() => {
        expect(screen.getByRole('log').querySelector('.chat-message-streaming')).not.toBeNull();
      });

      await selectThreadFromDrawer(container, user, 'second thread');
      await selectThreadFromDrawer(container, user, 'first thread');
      await waitFor(() => expect(sess1HistoryCalls).toBeGreaterThanOrEqual(2));
      expect(screen.queryByText('reply nobody announced')).toBeNull();

      // ここでサーバーが追いつく。以降スレッドの切替はしない。
      serverCaughtUp = true;
      await user.type(screen.getByLabelText('メッセージ'), 'second send');
      await user.click(screen.getByRole('button', { name: '送信' }));

      expect(await screen.findByText('reply nobody announced')).toBeInTheDocument();
    });

    it('drains a second queued completion after acknowledging the first (bdboard-3tw.156)', async () => {
      // 未回収の完了は1件ずつ配られる。1件 ACK したら聞き直して、積まれている
      // 分を掃き切ること。
      const user = userEvent.setup();
      fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
      fetchChatThreadsMock.mockResolvedValue([
        { sessionId: 'sess-1', agentId: 'claude', title: 'first thread', pinned: false, updatedAt: '2026-01-02T00:00:00Z' },
        { sessionId: 'sess-2', agentId: 'claude', title: 'second thread', pinned: false, updatedAt: '2026-01-01T00:00:00Z' },
      ]);
      // サーバー側のキューを模す。ACK された sessionId を落とし、先頭を返す。
      const queued: string[] = ['sess-1', 'sess-2'];
      acknowledgeChatTurnMock.mockImplementation(async (_projectId: string, sessionId: string) => {
        const at = queued.indexOf(sessionId);
        if (at >= 0) queued.splice(at, 1);
      });
      fetchChatTurnStatusMock.mockImplementation(async () => {
        const head = queued[0];
        if (head === undefined) return { state: 'idle' as const };
        return {
          state: 'completed' as const,
          sessionId: head,
          agentId: 'claude',
          completedAt: '2026-08-18T12:00:00.000Z',
        };
      });
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/api/chat/sessions/sess-1/messages')) {
          return jsonResponse({
            sessionId: 'sess-1',
            agentId: 'claude',
            messages: [{ role: 'assistant', content: 'queued reply one', createdAt: '2026-08-18T12:00:00.000Z' }],
          });
        }
        if (url.includes('/api/chat/sessions/sess-2/messages')) {
          return jsonResponse({
            sessionId: 'sess-2',
            agentId: 'claude',
            messages: [{ role: 'assistant', content: 'queued reply two', createdAt: '2026-08-18T12:00:01.000Z' }],
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });

      const { container } = renderChatPanel([PROJECT_A]);

      // 2件とも ACK され、キューが空になるまで掃ける。
      await waitFor(() => {
        expect(acknowledgeChatTurnMock).toHaveBeenCalledWith('proj-a', 'sess-1');
        expect(acknowledgeChatTurnMock).toHaveBeenCalledWith('proj-a', 'sess-2');
      });
      // 2件目の中身も取り込まれている。
      await selectThreadFromDrawer(container, user, 'second thread');
      expect(await screen.findByText('queued reply two')).toBeInTheDocument();
    });

    it('aborts a bulk subscription, then restores its agent/model and resumes the same session', async () => {
      const user = userEvent.setup();
      const recoveryAgent: ChatAgentDto = {
        id: 'recovery-agent',
        label: 'Recovery Agent',
        models: [
          { id: 'fast', label: 'Fast' },
          { id: 'slow', label: 'Slow' },
        ],
        model: 'fast',
        experimental: false,
        capability: 'bd-only',
        availability: 'available',
        supportsStreaming: false,
        supportsImages: false,
      };
      fetchChatAgentsMock.mockResolvedValue([CLAUDE_AGENT, recoveryAgent]);
      fetchChatThreadsMock.mockResolvedValue([
        {
          sessionId: 'sess-bulk',
          agentId: 'recovery-agent',
          title: 'bulk thread',
          pinned: false,
          updatedAt: '2026-01-02T00:00:00Z',
        },
        {
          sessionId: 'sess-other',
          agentId: 'claude',
          title: 'other thread',
          pinned: false,
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ]);
      fetchChatTurnStatusMock
        .mockResolvedValueOnce({ state: 'idle' })
        .mockResolvedValueOnce({ state: 'processing' })
        .mockResolvedValue({
          state: 'completed',
          sessionId: 'sess-bulk',
          agentId: 'recovery-agent',
          completedAt: '2026-08-18T12:00:00.000Z',
        });
      let bulkPostCount = 0;
      let capturedBulkSignal: AbortSignal | undefined;
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes('/api/chat/sessions/sess-bulk/messages')) {
          return jsonResponse({
            sessionId: 'sess-bulk',
            agentId: 'recovery-agent',
            model: 'slow',
            messages: [
              {
                role: 'user',
                content: 'bulk before switch',
                createdAt: '2026-08-18T11:59:00.000Z',
              },
              {
                role: 'assistant',
                content: 'bulk recovered reply',
                createdAt: '2026-08-18T12:00:00.000Z',
              },
            ],
          });
        }
        if (url.includes('/api/chat/sessions/sess-other/messages')) {
          return jsonResponse({ sessionId: 'sess-other', agentId: 'claude', messages: [] });
        }
        if (url === '/api/chat/message' && init?.method === 'POST') {
          bulkPostCount += 1;
          if (bulkPostCount === 1) {
            capturedBulkSignal = init.signal ?? undefined;
            return await new Promise<Response>((_resolve, reject) => {
              init.signal?.addEventListener('abort', () => {
                reject(new DOMException('The operation was aborted.', 'AbortError'));
              });
            });
          }
          return jsonResponse({
            reply: 'continued reply',
            sessionId: 'sess-bulk',
            agentId: 'recovery-agent',
          });
        }
        throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
      });

      const { container } = renderChatPanel([PROJECT_A]);
      openThreadDrawer(container);
      expect(
        await within(getThreadDrawer(container)).findByRole('button', { name: 'bulk thread' }),
      ).toBeInTheDocument();
      await waitFor(() => {
        expect(screen.getByLabelText('チャットエージェント')).toHaveValue('recovery-agent');
      });
      await user.type(screen.getByLabelText('メッセージ'), 'bulk before switch');
      await user.click(screen.getByRole('button', { name: '送信' }));
      await selectThreadFromDrawer(container, user, 'other thread');
      await waitFor(() => expect(capturedBulkSignal?.aborted).toBe(true));
      expect(
        await screen.findByText(
          'バックグラウンドの返信が完了しました。',
          {},
          { timeout: 2_500 },
        ),
      ).toBeInTheDocument();

      await selectThreadFromDrawer(container, user, 'bulk thread');
      expect(await screen.findByText('bulk recovered reply')).toBeInTheDocument();
      await waitFor(() => {
        expect(screen.getByLabelText('チャットエージェント')).toHaveValue('recovery-agent');
        expect(screen.getByLabelText('モデル')).toHaveValue('slow');
      });
      expect(readPersistedChatThreads()['proj-a']).toEqual({
        activeSessionIds: ['sess-other', 'sess-bulk'],
        selectedSessionId: 'sess-bulk',
      });
      await user.clear(screen.getByLabelText('メッセージ'));
      await user.type(screen.getByLabelText('メッセージ'), 'continue recovered');
      await user.click(screen.getByRole('button', { name: '送信' }));
      await waitFor(() => expect(getChatMessagePostCalls(fetchMock)).toHaveLength(2));
      expect(parseChatMessageBody(fetchMock)).toEqual({
        projectId: 'proj-a',
        message: 'continue recovered',
        sessionId: 'sess-bulk',
        agentId: 'recovery-agent',
        model: 'slow',
      });
    });

    it('aborts the fetch signal when switching projects while streaming', async () => {
      const user = userEvent.setup();
      fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
      const capturedSignal: { current: AbortSignal | undefined } = { current: undefined };
      makeGatedStreamingFetchMock(fetchMock, { capturedSignal });

      const rendered = renderChatPanel([PROJECT_A, PROJECT_B], {
        initialProjectId: 'proj-a',
        ticketContextToken: 1,
      });
      await screen.findByLabelText('チャットエージェント');
      await user.type(screen.getByLabelText('メッセージ'), 'project switch abort');
      await user.click(screen.getByRole('button', { name: '送信' }));

      const messages = screen.getByRole('log');
      await waitFor(() => {
        expect(messages.querySelector('.chat-message-streaming')).not.toBeNull();
      });
      expect(capturedSignal.current).toBeDefined();

      rendered.rerender(
        <ChatPanel
          projects={[PROJECT_A, PROJECT_B]}
          initialProjectId="proj-b"
          ticketContextToken={2}
          isTicketOnBoard={rendered.isTicketOnBoard}
          onOpenTicket={rendered.onOpenTicket}
          onClose={rendered.onClose}
        />,
      );

      await waitFor(() => {
        expect(capturedSignal.current?.aborted).toBe(true);
      });
      expect(screen.getByRole('log').querySelector('.chat-message-streaming')).toBeNull();
    });

    // bdboard-sso1.83 特性テスト T7 (設計メモ §5 P1 の再現テスト): ストリーミング
    // 中にプロジェクトを切り替えると、切替による abort が少し遅れて
    // generation を bump し、E8(turn-status 回収)が再実行される。以前の E8 は
    // generation>0 のたびに threadListRequestIdRef を進めていたため、切替先の
    // E7 スレッド一覧 fetch(in-flight)の応答が request-id の不一致で握り
    // つぶされ、切替先 B のスレッド一覧がいつまでも表示されなかった。第5段では
    // it.fails で固定し、bdboard-x4mv で E8 が一覧の request-id を進めるのを
    // hydrate の直前だけにして直した。
    it('P1: loads project B\'s thread list after switching away from a streaming project A', async () => {
      const user = userEvent.setup();
      fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
      const capturedSignal: { current: AbortSignal | undefined } = { current: undefined };
      makeGatedStreamingFetchMock(fetchMock, { capturedSignal });

      const projectBThreads = createDeferred<ChatThreadDto[]>();
      fetchChatThreadsMock.mockImplementation((projectId: string) =>
        projectId === 'proj-b' ? projectBThreads.promise : Promise.resolve([]),
      );

      const rendered = renderChatPanel([PROJECT_A, PROJECT_B], {
        initialProjectId: 'proj-a',
        ticketContextToken: 1,
      });
      await screen.findByLabelText('チャットエージェント');
      await user.type(screen.getByLabelText('メッセージ'), 'stream in A');
      await user.click(screen.getByRole('button', { name: '送信' }));

      await waitFor(() => {
        expect(screen.getByRole('log').querySelector('.chat-message-streaming')).not.toBeNull();
      });

      // B へ切り替える。「対象プロジェクト」の select はストリーミング中は
      // disabled で使えないため、既存の「aborts the fetch signal when
      // switching projects while streaming」テストと同じく、チケット起動
      // (initialProjectId/ticketContextToken の変化)で外部からプロジェクトを
      // 切り替える経路を使う。B の fetchChatThreads は in-flight (deferred)
      // のまま。これが A のストリーミング fetch を abort する
      // (useAbortOnConversationChange)。
      rendered.rerender(
        <ChatPanel
          projects={[PROJECT_A, PROJECT_B]}
          initialProjectId="proj-b"
          ticketContextToken={2}
          isTicketOnBoard={rendered.isTicketOnBoard}
          onOpenTicket={rendered.onOpenTicket}
          onClose={rendered.onClose}
        />,
      );

      await waitFor(() => {
        expect(capturedSignal.current?.aborted).toBe(true);
      });

      // abort が submit の catch(AbortError) 経路を通って
      // setTurnRecoveryGeneration(g => g+1) を呼ぶのは、ストリーム読み取り
      // ループへ abort が伝播した後の非同期タイミング。ここで一呼吸おいて
      // から B の一覧 fetch を解決し、「E8 の generation bump が E7 の
      // in-flight fetch より後から割り込む」順序を作る。
      await new Promise((resolve) => setTimeout(resolve, 50));
      projectBThreads.resolve([
        {
          sessionId: 'sess-b',
          agentId: 'claude',
          title: 'project B thread',
          pinned: false,
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ]);

      openThreadDrawer(rendered.container);
      expect(
        await within(getThreadDrawer(rendered.container)).findByRole('button', { name: 'project B thread' }),
      ).toBeInTheDocument();
    });

    it('does not add an error bubble when abort comes from a thread switch', async () => {
      const user = userEvent.setup();
      fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
      fetchChatThreadsMock.mockResolvedValue([
        {
          sessionId: 'sess-1',
          agentId: 'claude',
          title: 'first thread',
          pinned: false,
          updatedAt: '2026-01-02T00:00:00Z',
        },
        {
          sessionId: 'sess-2',
          agentId: 'claude',
          title: 'second thread',
          pinned: false,
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ]);
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes('/api/chat/sessions/sess-1/messages')) {
          return jsonResponse({ sessionId: 'sess-1', agentId: 'claude', messages: [] });
        }
        if (url.includes('/api/chat/sessions/sess-2/messages')) {
          return jsonResponse({ sessionId: 'sess-2', agentId: 'claude', messages: [] });
        }
        if (url === '/api/chat/message/stream' && init?.method === 'POST') {
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode('event: delta\ndata: {"text":"partial "}\n\n'),
                );
                init.signal?.addEventListener('abort', () => {
                  controller.error(
                    new DOMException('The operation was aborted.', 'AbortError'),
                  );
                });
              },
            }),
          );
        }
        throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
      });

      const { container } = renderChatPanel([PROJECT_A]);
      openThreadDrawer(container);
      expect(
        await within(getThreadDrawer(container)).findByRole('button', { name: 'first thread' }),
      ).toBeInTheDocument();

      await user.type(screen.getByLabelText('メッセージ'), 'abort without error bubble');
      await user.click(screen.getByRole('button', { name: '送信' }));

      await waitFor(() => {
        expect(screen.getByRole('log').querySelector('.chat-message-streaming')).not.toBeNull();
      });

      await selectThreadFromDrawer(container, user, 'second thread');
      await waitFor(() => {
        expect(screen.getByRole('log').querySelector('.chat-message-streaming')).toBeNull();
      });

      await selectThreadFromDrawer(container, user, 'first thread');
      const firstThreadMessages = screen.getByRole('log');
      await waitFor(() => {
        expect(within(firstThreadMessages).getByText('abort without error bubble')).toBeInTheDocument();
      });
      expect(firstThreadMessages.querySelectorAll('.chat-message-error')).toHaveLength(0);
      expect(firstThreadMessages.querySelector('.chat-message-streaming')).toBeNull();
    });
  });
});
