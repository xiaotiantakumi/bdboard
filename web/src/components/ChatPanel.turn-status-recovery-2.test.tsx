// bdboard-sso1.83 第5段: ChatPanel.test.tsx から move-only で切り出したファイル
// (ChatPanel.turn-status-recovery-2.test.tsx)。手本: sso1.85 の HygienePanel 分割。テスト本体・期待値・文言は
// 1文字も変えていない。共有の fixture/render ヘルパーは ChatPanel-test-support.tsx
// から import する。vi.mock はファイル単位でホイストされるため、元ファイルの
// vi.mock('../api', ...) ブロックと beforeEach/afterEach をこのファイルにも複製している。

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
  STREAMING_AGENT,
  jsonResponse,
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

  it('keeps polling and recovers a completed turn after turn-status fails once (bdboard-3tw.164, done なし回収)', async () => {
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
    // 同じ done なし配信停止シナリオだが、配信停止後 最初の turn-status 取得が
    // ネットワークエラーで失敗する。以前はここでポーリングが止まり、サーバー側で
    // 完走・保存済みのターンが画面に表示されないまま残っていた (bdboard-3tw.164)。
    let streamClosed = false;
    let statusCallsAfterClose = 0;
    fetchChatTurnStatusMock.mockImplementation(async () => {
      if (!streamClosed) return { state: 'idle' };
      statusCallsAfterClose += 1;
      if (statusCallsAfterClose === 1) {
        throw new TypeError('network hiccup');
      }
      return {
        state: 'completed',
        sessionId: 'sess-overflow',
        agentId: 'claude',
        completedAt: '2026-09-13T08:00:10.000Z',
      };
    });
    fetchChatThreadsMock.mockImplementation(async () =>
      streamClosed
        ? [
            {
              sessionId: 'sess-overflow',
              agentId: 'claude',
              title: 'overflow question',
              pinned: false,
              updatedAt: '2026-09-13T08:00:10.000Z',
            },
          ]
        : [],
    );
    let releaseClose: () => void = () => {};
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/chat/sessions/sess-overflow/messages')) {
        return jsonResponse({
          sessionId: 'sess-overflow',
          agentId: 'claude',
          messages: [
            { role: 'user', content: 'overflow question', createdAt: '2026-09-13T08:00:00.000Z' },
            {
              role: 'assistant',
              content: 'full reply recovered after a retry',
              createdAt: '2026-09-13T08:00:10.000Z',
            },
          ],
        });
      }
      if (url === '/api/chat/message/stream' && init?.method === 'POST') {
        return new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(
                new TextEncoder().encode('event: delta\ndata: {"text":"partial"}\n\n'),
              );
              await closeGate;
              streamClosed = true;
              controller.close();
            },
          }),
        );
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A]);
    await screen.findByLabelText('チャットエージェント');
    await user.type(screen.getByLabelText('メッセージ'), 'overflow question');
    await user.click(screen.getByRole('button', { name: '送信' }));

    const messages = screen.getByRole('log');
    await waitFor(() => {
      expect(
        messages.querySelector('.chat-message-streaming .chat-message-text')?.textContent,
      ).toBe('partial');
    });

    releaseClose();

    expect(
      await screen.findByText('full reply recovered after a retry', {}, { timeout: 2_500 }),
    ).toBeInTheDocument();
    expect(acknowledgeChatTurnMock).toHaveBeenCalledWith('proj-a', 'sess-overflow');
    // 少なくとも「失敗した1回」+「成功した1回」の2回は取得を試みている。
    expect(statusCallsAfterClose).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole('log').querySelectorAll('.chat-message-error')).toHaveLength(0);
    expect(screen.getByLabelText('メッセージ')).toHaveValue('');
  });

  it('retries hydration (not just the turn-status fetch) after a transient failure loading a completed turn (bdboard-3tw.164 Opus レビュー)', async () => {
    // turn-status 自体は毎回 completed を返すが、掃き出し用の thread 一覧取得
    // (fetchChatThreads) が最初の1回だけ失敗する。重複防止印 (recoveredSessionIds)
    // が外れずに再試行が黙って戻り続ける退行を防ぐための回帰テスト。
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
    let streamClosed = false;
    fetchChatTurnStatusMock.mockImplementation(async () => {
      if (!streamClosed) return { state: 'idle' };
      return {
        state: 'completed',
        sessionId: 'sess-overflow',
        agentId: 'claude',
        completedAt: '2026-09-13T08:00:10.000Z',
      };
    });
    // マウント時の初期スレッド一覧取得 (streamClosed===false の間) は成功させ、
    // ストリーム終了後 (ハイドレーション経路) の最初の1回だけ失敗させる。
    let hydrationThreadsCalls = 0;
    fetchChatThreadsMock.mockImplementation(async () => {
      if (!streamClosed) return [];
      hydrationThreadsCalls += 1;
      if (hydrationThreadsCalls === 1) {
        throw new TypeError('network hiccup');
      }
      return [
        {
          sessionId: 'sess-overflow',
          agentId: 'claude',
          title: 'overflow question',
          pinned: false,
          updatedAt: '2026-09-13T08:00:10.000Z',
        },
      ];
    });
    let releaseClose: () => void = () => {};
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/chat/sessions/sess-overflow/messages')) {
        return jsonResponse({
          sessionId: 'sess-overflow',
          agentId: 'claude',
          messages: [
            { role: 'user', content: 'overflow question', createdAt: '2026-09-13T08:00:00.000Z' },
            {
              role: 'assistant',
              content: 'full reply recovered after hydration retry',
              createdAt: '2026-09-13T08:00:10.000Z',
            },
          ],
        });
      }
      if (url === '/api/chat/message/stream' && init?.method === 'POST') {
        return new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(
                new TextEncoder().encode('event: delta\ndata: {"text":"partial"}\n\n'),
              );
              await closeGate;
              streamClosed = true;
              controller.close();
            },
          }),
        );
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A]);
    await screen.findByLabelText('チャットエージェント');
    await user.type(screen.getByLabelText('メッセージ'), 'overflow question');
    await user.click(screen.getByRole('button', { name: '送信' }));

    const messages = screen.getByRole('log');
    await waitFor(() => {
      expect(
        messages.querySelector('.chat-message-streaming .chat-message-text')?.textContent,
      ).toBe('partial');
    });

    releaseClose();

    expect(
      await screen.findByText(
        'full reply recovered after hydration retry',
        {},
        { timeout: 2_500 },
      ),
    ).toBeInTheDocument();
    expect(acknowledgeChatTurnMock).toHaveBeenCalledWith('proj-a', 'sess-overflow');
    // 少なくとも「失敗した1回」+「成功した1回」はハイドレーション経路から
    // fetchChatThreads を試みている。
    expect(hydrationThreadsCalls).toBeGreaterThanOrEqual(2);
  });

  it('falls back to a send failure when turn-status turns idle without recovering the detached turn (bdboard-zlzo)', async () => {
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
    // 配信停止後にエージェントが失敗した: サーバーは error を送れず、completed も
    // 記録されないので、turn-status は processing のあと idle になる。
    let streamClosed = false;
    let statusCallsAfterClose = 0;
    fetchChatTurnStatusMock.mockImplementation(async () => {
      if (!streamClosed) return { state: 'idle' };
      statusCallsAfterClose += 1;
      return statusCallsAfterClose === 1
        ? { state: 'processing', message: 'doomed question', agentId: 'claude' }
        : { state: 'idle' };
    });
    let releaseClose: () => void = () => {};
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/chat/message/stream' && init?.method === 'POST') {
        return new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(
                new TextEncoder().encode('event: delta\ndata: {"text":"partial"}\n\n'),
              );
              await closeGate;
              streamClosed = true;
              controller.close();
            },
          }),
        );
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A]);
    await screen.findByLabelText('チャットエージェント');
    await user.type(screen.getByLabelText('メッセージ'), 'doomed question');
    await user.click(screen.getByRole('button', { name: '送信' }));
    await waitFor(() => {
      expect(screen.getByRole('log').querySelector('.chat-message-streaming')).not.toBeNull();
    });

    releaseClose();

    const errorText = await screen.findByText(
      '返信の受信が途中で途切れ、サーバー側でも返信の完了を確認できませんでした。もう一度送信してください。',
      {},
      { timeout: 2_500 },
    );
    expect(errorText.closest('.chat-message')).toHaveClass('chat-message-error');
    expect(statusCallsAfterClose).toBeGreaterThanOrEqual(2);
    expect(screen.getByLabelText('メッセージ')).toHaveValue('doomed question');
    expect(within(screen.getByRole('log')).queryByText('doomed question')).not.toBeInTheDocument();
    // bdboard-3tw.166 (Opus レビュー指摘): 失敗が確定した以上、回収中ずっと表示して
    // いた部分テキストの吹き出しもここで消えている必要がある (エラー吹き出しと
    // 二重に出たままにしない)。
    expect(screen.getByRole('log').querySelector('.chat-message-streaming')).not.toBeInTheDocument();
  });

  it('falls back to a send failure on the explicit failed turn-status instead of waiting for idle (bdboard-3tw.165)', async () => {
    // Same scenario as the idle-inference test above, but the server now reports the
    // failure explicitly instead of turn-status silently falling through to idle. web
    // must reach the exact same failure UI from this new signal. This send is a brand
    // new thread's first message, so it has no sessionId of its own yet -- and per the
    // real server contract (chat-routes.ts's recordFailedTurn mirrors the *request's*
    // sessionId verbatim), a failed entry for a sessionId-less request is always itself
    // sessionId-less too. So (bdboard-96rp) there is nothing to ack here, unlike the
    // sibling test below for an existing thread.
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
    let streamClosed = false;
    let statusCallsAfterClose = 0;
    fetchChatTurnStatusMock.mockImplementation(async () => {
      if (!streamClosed) return { state: 'idle' };
      statusCallsAfterClose += 1;
      if (statusCallsAfterClose === 1) {
        return { state: 'processing', message: 'doomed question', agentId: 'claude' };
      }
      return {
        state: 'failed',
        code: 'agent-timeout',
        agentId: 'claude',
        // bdboard-96rp: no sessionId, matching the tracked send's own (also
        // undefined) sessionId, and failedAt is generated fresh (>= the moment the
        // send detached) so the recency guard in checkTurnStatus's 'failed' branch
        // accepts it as this send's own failure rather than an unrelated stale entry.
        failedAt: new Date().toISOString(),
      };
    });
    let releaseClose: () => void = () => {};
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/chat/message/stream' && init?.method === 'POST') {
        return new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(
                new TextEncoder().encode('event: delta\ndata: {"text":"partial"}\n\n'),
              );
              await closeGate;
              streamClosed = true;
              controller.close();
            },
          }),
        );
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A]);
    await screen.findByLabelText('チャットエージェント');
    await user.type(screen.getByLabelText('メッセージ'), 'doomed question');
    await user.click(screen.getByRole('button', { name: '送信' }));
    await waitFor(() => {
      expect(screen.getByRole('log').querySelector('.chat-message-streaming')).not.toBeNull();
    });

    releaseClose();

    const errorText = await screen.findByText(
      '返信の受信が途中で途切れ、サーバー側でも返信の完了を確認できませんでした。もう一度送信してください。',
      {},
      { timeout: 2_500 },
    );
    expect(errorText.closest('.chat-message')).toHaveClass('chat-message-error');
    expect(statusCallsAfterClose).toBeGreaterThanOrEqual(2);
    expect(screen.getByLabelText('メッセージ')).toHaveValue('doomed question');
    expect(within(screen.getByRole('log')).queryByText('doomed question')).not.toBeInTheDocument();
    // bdboard-96rp: sessionId-less, so there is no ack path (see FailedChatTurn's doc
    // comment in chat-routes.ts) -- the resolution still happens, just without an ack.
    expect(acknowledgeChatTurnMock).not.toHaveBeenCalled();
    // bdboard-3tw.166 (Opus レビュー指摘): idle 分岐と同様、失敗確定後は部分テキストの
    // 吹き出しも消えている必要がある。
    expect(screen.getByRole('log').querySelector('.chat-message-streaming')).not.toBeInTheDocument();
  });

  it('acks and surfaces a send failure on an existing thread whose own sessionId matches the failed turn-status (bdboard-96rp Opus レビュー指摘 W2)', async () => {
    // bdboard-96rp (W2): the sibling test above ("falls back to a send failure...") only
    // covers a brand new thread's first message, whose own sessionId is unknown at detach
    // time -- so matchesTrackedSend's `detached.sessionId !== undefined` branch (the ack
    // path) was never exercised by any test. This covers that branch: an existing thread's
    // resend detaches with a KNOWN sessionId, and the turn-status poll later reports
    // 'failed' with that SAME sessionId -- matchesTrackedSend must resolve it as this
    // send's own failure (surfacing the error UI) AND ack it (unlike the sessionId-less
    // case, which has no ack path).
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
    let detachStreamClosed = false;
    let postDetachCalls = 0;
    fetchChatTurnStatusMock.mockImplementation(async () => {
      if (!detachStreamClosed) return { state: 'idle' };
      postDetachCalls += 1;
      if (postDetachCalls === 1) {
        return { state: 'processing', message: 'second try', agentId: 'claude' };
      }
      return {
        state: 'failed',
        code: 'agent-timeout',
        agentId: 'claude',
        sessionId: 'sess-w2',
        failedAt: new Date().toISOString(),
      };
    });
    let streamPosts = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/chat/message/stream' && init?.method === 'POST') {
        streamPosts += 1;
        if (streamPosts === 1) {
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    'event: done\ndata: {"reply":"first reply","sessionId":"sess-w2","agentId":"claude"}\n\n',
                  ),
                );
                controller.close();
              },
            }),
          );
        }
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode('event: delta\ndata: {"text":"w2 partial"}\n\n'),
              );
              controller.close();
              detachStreamClosed = true;
            },
          }),
        );
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A]);
    await screen.findByLabelText('チャットエージェント');
    await user.type(screen.getByLabelText('メッセージ'), 'first message');
    await user.click(screen.getByRole('button', { name: '送信' }));
    await screen.findByText('first reply');
    acknowledgeChatTurnMock.mockClear();

    await user.type(screen.getByLabelText('メッセージ'), 'second try');
    await user.click(screen.getByRole('button', { name: '送信' }));

    const errorText = await screen.findByText(
      '返信の受信が途中で途切れ、サーバー側でも返信の完了を確認できませんでした。もう一度送信してください。',
      {},
      { timeout: 4_000 },
    );
    expect(errorText.closest('.chat-message')).toHaveClass('chat-message-error');
    expect(postDetachCalls).toBeGreaterThanOrEqual(2);
    expect(acknowledgeChatTurnMock).toHaveBeenCalledWith('proj-a', 'sess-w2');
  }, 10_000);

  it('drains a stale failed turn from an unrelated session instead of surfacing it as an error (bdboard-3tw.165 Opus レビュー)', async () => {
    // failedTurns is a per-project queue (like completedTurns, bdboard-3tw.155/156), so a
    // background poll can see an old failure that has nothing to do with anything this
    // panel is currently tracking. Unlike 'idle' (which under the single-lock-per-project
    // model can only mean "our own pending send settled"), a mismatched 'failed' entry
    // must not resolve an unrelated pending send as failed (nothing was pending here at
    // all) and must not surface any error UI — it should just be acked and drained.
    fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
    fetchChatTurnStatusMock.mockImplementation(async () => {
      if (acknowledgeChatTurnMock.mock.calls.length === 0) {
        return {
          state: 'failed',
          code: 'agent-timeout',
          agentId: 'claude',
          sessionId: 'sess-stale',
          failedAt: '2026-09-01T00:00:00.000Z',
        };
      }
      return { state: 'idle' };
    });

    renderChatPanel([PROJECT_A]);
    await screen.findByLabelText('チャットエージェント');

    await waitFor(() => {
      expect(acknowledgeChatTurnMock).toHaveBeenCalledWith('proj-a', 'sess-stale');
    });
    expect(screen.getByRole('log').querySelectorAll('.chat-message-error')).toHaveLength(0);
    expect(screen.getByLabelText('メッセージ')).toHaveValue('');
  });

  it('recovers a detached turn on an existing thread without duplicating the user message (bdboard-zlzo)', async () => {
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
    fetchChatThreadsMock.mockResolvedValue([
      { sessionId: 'sess-1', agentId: 'claude', title: 'first thread', pinned: false, updatedAt: '2026-01-02T00:00:00Z' },
    ]);
    let streamClosed = false;
    let statusCallsAfterClose = 0;
    fetchChatTurnStatusMock.mockImplementation(async () => {
      if (!streamClosed) return { state: 'idle' };
      statusCallsAfterClose += 1;
      if (statusCallsAfterClose === 1) {
        return { state: 'processing', message: 'overflow question', agentId: 'claude', sessionId: 'sess-1' };
      }
      return {
        state: 'completed',
        sessionId: 'sess-1',
        agentId: 'claude',
        completedAt: '2026-09-13T08:00:10.000Z',
      };
    });
    let releaseClose: () => void = () => {};
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/chat/sessions/sess-1/messages')) {
        return jsonResponse({
          sessionId: 'sess-1',
          agentId: 'claude',
          // 実サーバーは finalize で初めて保存するので、履歴が伸びるのは completed 以降。
          messages: statusCallsAfterClose >= 2
            ? [
                { role: 'user', content: 'earlier question', createdAt: '2026-09-13T07:00:00.000Z' },
                { role: 'assistant', content: 'earlier answer', createdAt: '2026-09-13T07:00:05.000Z' },
                { role: 'user', content: 'overflow question', createdAt: '2026-09-13T08:00:00.000Z' },
                { role: 'assistant', content: 'recovered answer for sess-1', createdAt: '2026-09-13T08:00:10.000Z' },
              ]
            : [
                { role: 'user', content: 'earlier question', createdAt: '2026-09-13T07:00:00.000Z' },
                { role: 'assistant', content: 'earlier answer', createdAt: '2026-09-13T07:00:05.000Z' },
              ],
        });
      }
      if (url === '/api/chat/message/stream' && init?.method === 'POST') {
        expect(JSON.parse(init.body as string)).toMatchObject({ sessionId: 'sess-1' });
        return new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(
                new TextEncoder().encode('event: delta\ndata: {"text":"partial"}\n\n'),
              );
              await closeGate;
              streamClosed = true;
              controller.close();
            },
          }),
        );
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A]);
    await screen.findByText('earlier answer');
    await user.type(screen.getByLabelText('メッセージ'), 'overflow question');
    await user.click(screen.getByRole('button', { name: '送信' }));
    await waitFor(() => {
      expect(screen.getByRole('log').querySelector('.chat-message-streaming')).not.toBeNull();
    });

    releaseClose();

    expect(
      await screen.findByText('recovered answer for sess-1', {}, { timeout: 2_500 }),
    ).toBeInTheDocument();
    // turn-status の completed 回収 (= 配信停止分の判定の解消) と ACK まで待ってから、
    // エラーに落ちていないことを確かめる。
    await waitFor(
      () => expect(acknowledgeChatTurnMock).toHaveBeenCalledWith('proj-a', 'sess-1'),
      { timeout: 2_500 },
    );
    const log = screen.getByRole('log');
    expect(within(log).getAllByText('overflow question')).toHaveLength(1);
    expect(log.querySelectorAll('.chat-message-error')).toHaveLength(0);
    expect(screen.getByLabelText('メッセージ')).toHaveValue('');
    // bdboard-3tw.166 (Opus レビュー指摘): ハイドレートされた確定本文
    // ('recovered answer for sess-1') の隣に、回収中ずっと表示していた部分テキストの
    // 吹き出しが残ったまま (二重表示) になっていないことを確認する。
    expect(log.querySelector('.chat-message-streaming')).not.toBeInTheDocument();
  });

  it('blocks a resend while the previous turn is still recovering, then allows it once the recovery resolves to a failure (bdboard-v3ag)', async () => {
    // bdboard-v3ag: 配信停止 (SSE キュー上限超過等) からの turn-status 回収中に、
    // 従来は「前のターンがまだ続いている間の再送」がサーバー側の 409 で弾かれるまで
    // クライアント側では止められず、その再送自身の
    // setStreamingReply({ key: sendKey, text: '' }) が回収中ずっと表示していた部分
    // テキストを即座に空文字で上書きしてしまっていた (bdboard-3tw.166 の保証が
    // その場で壊れる)。このテストは、その再送がそもそも送信ボタンの disabled で
    // 止まり、部分テキストが上書きされないこと、かつ回収が実際に失敗で確定した
    // あとは再送が通常どおり行えることを確認する。
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
    let streamClosed = false;
    let recoveryResolved = false;
    fetchChatTurnStatusMock.mockImplementation(async () => {
      if (!streamClosed) return { state: 'idle' };
      if (!recoveryResolved) {
        return { state: 'processing', message: 'doomed question', agentId: 'claude' };
      }
      // 前のターンは結局 completed/failed どちらのエントリも残さず終わった
      // (=失敗) 扱いで確定する。
      return { state: 'idle' };
    });
    let releaseClose: () => void = () => {};
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    let streamPosts = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/chat/message/stream' && init?.method === 'POST') {
        streamPosts += 1;
        if (streamPosts === 1) {
          return new Response(
            new ReadableStream({
              async start(controller) {
                controller.enqueue(
                  new TextEncoder().encode('event: delta\ndata: {"text":"partial"}\n\n'),
                );
                await closeGate;
                streamClosed = true;
                controller.close();
              },
            }),
          );
        }
        // 2本目 (second try) はガードが解けたあとにしか届かないはず — 通常どおり
        // 完走させる。
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'event: done\ndata: {"reply":"second reply","sessionId":"sess-second","agentId":"claude"}\n\n',
                ),
              );
              controller.close();
            },
          }),
        );
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A]);
    await screen.findByLabelText('チャットエージェント');
    await user.type(screen.getByLabelText('メッセージ'), 'doomed question');
    await user.click(screen.getByRole('button', { name: '送信' }));
    await waitFor(() => {
      expect(screen.getByRole('log').querySelector('.chat-message-streaming')).not.toBeNull();
    });
    releaseClose();
    await waitFor(() => {
      expect(screen.getByLabelText('メッセージ')).not.toBeDisabled();
    });
    // bdboard-3tw.166: 配信停止直後はまだ回収中(turn-status がここでは
    // processing を返す)なので、直前に受け取った部分テキストはまだ消えない。
    expect(
      screen.getByRole('log').querySelector('.chat-message-streaming .chat-message-text')
        ?.textContent,
    ).toBe('partial');

    // 回収中は送信ボタンが disabled になり、クリックしても再送は発生しない
    // (bdboard-v3ag)。部分テキストも上書きされずに残る。
    await user.type(screen.getByLabelText('メッセージ'), 'second try');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '送信' })).toBeDisabled();
    });
    await user.click(screen.getByRole('button', { name: '送信' }));
    expect(streamPosts).toBe(1);
    expect(
      screen.getByRole('log').querySelector('.chat-message-streaming .chat-message-text')
        ?.textContent,
    ).toBe('partial');

    // 前のターンの回収が実際には失敗として確定する。
    recoveryResolved = true;
    expect(
      await screen.findByText(
        '返信の受信が途中で途切れ、サーバー側でも返信の完了を確認できませんでした。もう一度送信してください。',
        {},
        { timeout: 2_500 },
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('log').querySelector('.chat-message-streaming')).not.toBeInTheDocument();
    expect(screen.getByRole('log').querySelectorAll('.chat-message-error')).toHaveLength(1);

    // 確定した以上、送信ボタンは再び有効になり、"second try" を実際に送れる —
    // 再送そのものは禁止されていない。
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '送信' })).not.toBeDisabled();
    });
    expect(screen.getByLabelText('メッセージ')).toHaveValue('second try');
    await user.click(screen.getByRole('button', { name: '送信' }));
    expect(await screen.findByText('second reply')).toBeInTheDocument();
    expect(streamPosts).toBe(2);
  });

  it(
    'unblocks the send button and shows a failure once turn-status polling exhausts its retry backoff (bdboard-v3ag Opus レビュー指摘 blocker B1)',
    async () => {
      // B1: bdboard-v3ag の送信ブロックは detachedStreamSendRef が non-null な間ずっと
      // 有効になる。turn-status のポーリングが (ネットワーク断などで)
      // TURN_STATUS_POLL_RETRY_BACKOFF_MS を使い切って諦めた場合、修正前はその ref を
      // 誰も解放しないまま effect が黙って止まり、送信ボタンが永久に disabled のまま
      // 残る (ページ再読み込み以外に回復手段の無いデッドロック) というのが指摘内容。
      // ここでは turn-status を毎回エラーにしてバックオフを使い切らせ、それでも
      // 最終的に失敗表示が出てボタンが再度有効になることを確認する。
      const user = userEvent.setup();
      fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
      fetchChatTurnStatusMock.mockRejectedValue(new Error('turn-status unavailable'));
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === '/api/chat/message/stream' && init?.method === 'POST') {
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode('event: delta\ndata: {"text":"partial"}\n\n'),
                );
                controller.close();
              },
            }),
          );
        }
        throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
      });

      renderChatPanel([PROJECT_A]);
      await screen.findByLabelText('チャットエージェント');
      await user.type(screen.getByLabelText('メッセージ'), 'doomed question');
      await user.click(screen.getByRole('button', { name: '送信' }));

      // done/error 無しでストリームが閉じる = 配信停止 → turn-status 回収へ。
      await waitFor(() => {
        expect(
          screen.getByRole('log').querySelector('.chat-message-streaming .chat-message-text')
            ?.textContent,
        ).toBe('partial');
      });
      await waitFor(() => {
        expect(screen.getByRole('button', { name: '送信' })).toBeDisabled();
      });

      // turn-status がここから先ずっとエラーを返し続け、バックオフ
      // ([1s, 2s, 4s, 8s, 8s] = 最大23秒) を使い切って諦める。B1 の修正が無いと、
      // 送信ボタンはここで二度と有効に戻らない。
      expect(
        await screen.findByText(
          '返信の受信が途中で途切れ、サーバー側でも返信の完了を確認できませんでした。もう一度送信してください。',
          {},
          { timeout: 26_000 },
        ),
      ).toBeInTheDocument();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: '送信' })).not.toBeDisabled();
      });
      expect(
        screen.getByRole('log').querySelector('.chat-message-streaming'),
      ).not.toBeInTheDocument();
    },
    30_000,
  );

  it(
    'clears the frozen "processing in background" banner once turn-status polling gives up (bdboard-qfps)',
    async () => {
      // qfps: bdboard-v3ag の B1 修正は、ポーリングを諦めたときに
      // detachedStreamSendRef を解放して送信ボタンの永久ロック(デッドロック)を
      // 解消したが、backgroundTurnStatus 自体は据え置きだった —
      // setBackgroundTurnStatus(status) は checkTurnStatus の try 内、
      // fetchChatTurnStatus が成功した直後にしか呼ばれず、ポーリングを諦める
      // catch 経路はそこを通らない。そのため、諦める直前に一度でも
      // 'processing' を観測していた場合、ログ上部の「返信をバックグラウンドで
      // 処理中…」バナー (bdboard-3tw.166 由来、backgroundTurnStatus.state==
      // 'processing' 直結) は、送信ボタンが再度有効になり失敗表示が出た後も
      // 凍りついたまま残ってしまう — これが qfps チケット本文そのものの症状。
      const user = userEvent.setup();
      fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
      let afterDetach = false;
      let pollsAfterDetach = 0;
      fetchChatTurnStatusMock.mockImplementation(async () => {
        if (!afterDetach) return { state: 'idle' };
        pollsAfterDetach += 1;
        if (pollsAfterDetach === 1) {
          // 配信停止後、最初の聞き直しでは 'processing' が見え、バナーが灯る。
          return { state: 'processing', message: 'まだ処理中です', agentId: 'claude' };
        }
        // 以降はずっと取得に失敗し、バックオフを使い切って諦める。
        throw new Error('turn-status unavailable');
      });
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === '/api/chat/message/stream' && init?.method === 'POST') {
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode('event: delta\ndata: {"text":"partial"}\n\n'),
                );
                controller.close();
                afterDetach = true;
              },
            }),
          );
        }
        throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
      });

      renderChatPanel([PROJECT_A]);
      await screen.findByLabelText('チャットエージェント');
      await user.type(screen.getByLabelText('メッセージ'), 'doomed question');
      await user.click(screen.getByRole('button', { name: '送信' }));

      // 配信停止後の1回目の聞き直しで 'processing' を観測し、バナーが出る。
      await screen.findByText('返信をバックグラウンドで処理中…');

      // 以降は毎回失敗し、バックオフ ([1s, 2s, 4s, 8s, 8s] = 最大23秒) を
      // 使い切って諦める。qfps Opus レビュー指摘: give-up 自体が既に約23秒かかる
      // ため、直後の findByText/it のタイムアウト余裕が薄いとCI/並列worktreeの
      // 負荷下でフレークしうる — 26s/30s から 28s/32s へ広げておく。
      expect(
        await screen.findByText(
          '返信の受信が途中で途切れ、サーバー側でも返信の完了を確認できませんでした。もう一度送信してください。',
          {},
          { timeout: 28_000 },
        ),
      ).toBeInTheDocument();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: '送信' })).not.toBeDisabled();
      });
      // qfps の修正が無いと、このバナーとメッセージバブルは上の失敗表示と同時に
      // 凍りついたまま残り続ける (どちらも backgroundTurnStatus.state===
      // 'processing' 直結)。
      expect(
        screen.queryByText('返信をバックグラウンドで処理中…'),
      ).not.toBeInTheDocument();
      expect(screen.queryByText('まだ処理中です')).not.toBeInTheDocument();
    },
    32_000,
  );

  it('keeps polling past an unrelated sessionId-less failed entry instead of stalling forever (bdboard-v3ag Opus レビュー指摘 blocker B1)', async () => {
    // B1 (b)(c): 追っている送信とは無関係な failed エントリ (sessionId 無し、または
    // 既に一度ACK済みの重複) を見たとき、修正前は effect が無条件 return して二度と
    // checkTurnStatus を呼ばなかった。無関係なエントリがキューの先頭に居座っている
    // だけで、本当に追っている送信の回収が永久に止まってしまう (=送信ボタンも
    // 永久に disabled のまま)。
    //
    // これを確実に再現するには、追っている送信 (D) 自身の sessionId が既知
    // (=既存スレッドへの再送) である必要がある。
    //
    // bdboard-96rp (Opus レビュー指摘 W3, 旧コメント更新): 修正前は「sessionId 無しの
    // failed は全部 D 自身のものかもしれない」という無条件の寛容な一致判定
    // (matchesTrackedSend) だったため、D 自身の sessionId が未知だとこのテストが
    // 狙う「無関係で一致しない failed をどう扱うか」の分岐を素通りしてしまっていた。
    // bdboard-96rp の修正で matchesTrackedSend は sessionId 無し同士でも detachedAt
    // (クロックずれ許容込み) 以降の失敗しか一致させなくなったため、この特定の
    // 固定 failedAt だけを見れば D の sessionId が未知でも素通りしなくなった可能性は
    // あるが、それはテスト実行時刻に依存する脆い前提になってしまう。D の sessionId を
    // 既知に固定するこの構成は、タイミングに依存せず「無関係な failed をどう扱うか」の
    // 分岐だけを決定的に踏むための意図的な設計として維持する。
    // そのため、まず1通目を通常どおり完走させて sessionId を確定させ、2通目を
    // 配信停止させる。
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
    let detachStreamClosed = false;
    let postDetachCalls = 0;
    fetchChatTurnStatusMock.mockImplementation(async () => {
      if (!detachStreamClosed) return { state: 'idle' };
      postDetachCalls += 1;
      if (postDetachCalls === 1) {
        // 無関係な新規スレッドの sessionId 無し失敗 (ACK 経路が無く区別もできない)。
        // D 自身の sessionId は既知 ('sess-b1bc') なので、これは matchesTrackedSend
        // に一致しない = 無関係扱いの分岐 (B1 の修正対象) を通る。
        return {
          state: 'failed',
          code: 'agent-error',
          agentId: 'claude',
          failedAt: '2026-09-19T08:00:10.000Z',
          // sessionId は意図的に省略 (新規スレッドの初回送信中の失敗を模す)。
        };
      }
      // 追っている送信 (D) 自身は completed/failed どちらのエントリも残さず終わった
      // = 失敗として確定する。
      return { state: 'idle' };
    });
    let streamPosts = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/chat/message/stream' && init?.method === 'POST') {
        streamPosts += 1;
        if (streamPosts === 1) {
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    'event: done\ndata: {"reply":"first reply","sessionId":"sess-b1bc","agentId":"claude"}\n\n',
                  ),
                );
                controller.close();
              },
            }),
          );
        }
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode('event: delta\ndata: {"text":"d partial"}\n\n'),
              );
              controller.close();
              detachStreamClosed = true;
            },
          }),
        );
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A]);
    await screen.findByLabelText('チャットエージェント');
    await user.type(screen.getByLabelText('メッセージ'), 'first message');
    await user.click(screen.getByRole('button', { name: '送信' }));
    await screen.findByText('first reply');
    acknowledgeChatTurnMock.mockClear();

    await user.type(screen.getByLabelText('メッセージ'), 'detach this');
    await user.click(screen.getByRole('button', { name: '送信' }));

    // 配信停止した瞬間 (無関係な failed の聞き直しが1秒後に控えている) と実時間で
    // 競合しないよう、「送信直後、まだ聞き直し前」の一時的な状態を短いタイムアウト
    // で先に確定させる。
    await waitFor(
      () => {
        expect(
          screen.getByRole('log').querySelector('.chat-message-streaming .chat-message-text')
            ?.textContent,
        ).toBe('d partial');
      },
      { timeout: 400 },
    );
    await waitFor(
      () => {
        expect(screen.getByRole('button', { name: '送信' })).toBeDisabled();
      },
      { timeout: 400 },
    );

    // 無関係な1件を挟んでも、1秒後の聞き直しで idle に辿り着き解決する
    // (B1 の修正が無いと、この findByText はタイムアウトするまで永久に見つからない)。
    expect(
      await screen.findByText(
        '返信の受信が途中で途切れ、サーバー側でも返信の完了を確認できませんでした。もう一度送信してください。',
        {},
        { timeout: 4_000 },
      ),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '送信' })).not.toBeDisabled();
    });
    expect(postDetachCalls).toBeGreaterThanOrEqual(2);
    expect(acknowledgeChatTurnMock).not.toHaveBeenCalled();
  });

  it('does not resolve a still-open new-thread send using a stale sessionId-less failed entry that predates it (bdboard-96rp)', async () => {
    // Before this fix, the tracked send's own sessionId is unknown at detach time
    // (brand new thread, first message) -- checkTurnStatus's 'failed' branch treated
    // ANY sessionId-less failed entry as "maybe mine", including one that was already
    // queued *before* this send even started (e.g. left over from a completely
    // different, earlier attempt in the same project). That let an unrelated, already
    // stale failure immediately and incorrectly resolve this send as failed on the
    // very first poll.
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
    let detachStreamClosed = false;
    let postDetachCalls = 0;
    fetchChatTurnStatusMock.mockImplementation(async () => {
      if (!detachStreamClosed) return { state: 'idle' };
      postDetachCalls += 1;
      if (postDetachCalls === 1) {
        // Stale and unrelated: recorded long before this send was even submitted.
        return {
          state: 'failed',
          code: 'agent-error',
          agentId: 'claude',
          failedAt: '2020-01-01T00:00:00.000Z',
        };
      }
      // This send itself settled without leaving a completed/failed entry of its own.
      return { state: 'idle' };
    });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/chat/message/stream' && init?.method === 'POST') {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode('event: delta\ndata: {"text":"d partial"}\n\n'),
              );
              controller.close();
              detachStreamClosed = true;
            },
          }),
        );
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A]);
    await screen.findByLabelText('チャットエージェント');
    await user.type(screen.getByLabelText('メッセージ'), 'first message ever');
    await user.click(screen.getByRole('button', { name: '送信' }));

    await waitFor(
      () => {
        expect(
          screen.getByRole('log').querySelector('.chat-message-streaming .chat-message-text')
            ?.textContent,
        ).toBe('d partial');
      },
      { timeout: 400 },
    );

    // The stale, unrelated entry must not resolve this send yet: the partial text (and
    // the disabled send button) must still be there shortly after the first
    // post-detach poll would have seen it.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(
      screen.queryByText(
        '返信の受信が途中で途切れ、サーバー側でも返信の完了を確認できませんでした。もう一度送信してください。',
      ),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '送信' })).toBeDisabled();

    // Once the real settlement (idle) is observed, it resolves normally.
    expect(
      await screen.findByText(
        '返信の受信が途中で途切れ、サーバー側でも返信の完了を確認できませんでした。もう一度送信してください。',
        {},
        { timeout: 4_000 },
      ),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '送信' })).not.toBeDisabled();
    });
    expect(postDetachCalls).toBeGreaterThanOrEqual(2);
  },
  // bdboard-96rp (Opus レビュー指摘 W4): 累積の待ち時間 (300ms + waitFor 400ms +
  // findByText 4_000ms) がデフォルトの testTimeout (5000ms) に近く、CI や並列
  // worktree 実行時の揺れでフレーキーになり得るため、他のテスト (32_000 の前例) に
  // 倣って明示的に余裕を持たせる。
  10_000,
  );

  it('eventually resolves a tracked send whose own sessionId-less failure never satisfies the time-window match, instead of blocking forever (bdboard-96rp round 2 reblocker)', async () => {
    // Round 2 Opus reblocker: a genuinely stalled/tunneled connection can mean the
    // server records failedAt well before the client notices the stream died and
    // stamps detachedAt (e.g. a slow-to-timeout proxy/tunnel hop) -- more than
    // TURN_STATUS_CLOCK_SKEW_TOLERANCE_MS apart. Because a sessionId-less failed
    // entry has no ack path, the *first* unmatched observation used to just poll
    // again forever with nothing ever superseding it -- a real, permanent deadlock
    // (send button disabled forever, no error ever shown). This proves
    // UNMATCHED_SESSIONLESS_FAILED_GIVEUP_POLLS bounds that wait: the same
    // never-changing sessionId-less failed entry must eventually resolve the
    // tracked send once the give-up threshold is reached.
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
    let detachStreamClosed = false;
    let postDetachCalls = 0;
    fetchChatTurnStatusMock.mockImplementation(async () => {
      if (!detachStreamClosed) return { state: 'idle' };
      postDetachCalls += 1;
      // Always the same stale-looking, sessionId-less failed entry -- never changes,
      // never acked (no ack path), never superseded. Simulates the deadlock case.
      return {
        state: 'failed',
        code: 'agent-error',
        agentId: 'claude',
        failedAt: '2020-01-01T00:00:00.000Z',
      };
    });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/chat/message/stream' && init?.method === 'POST') {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode('event: delta\ndata: {"text":"stuck partial"}\n\n'),
              );
              controller.close();
              detachStreamClosed = true;
            },
          }),
        );
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A]);
    await screen.findByLabelText('チャットエージェント');
    await user.type(screen.getByLabelText('メッセージ'), 'stuck message');
    await user.click(screen.getByRole('button', { name: '送信' }));

    // It must still be unresolved well before the give-up threshold -- otherwise
    // this would just be testing the immediate-match path, not the give-up path.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(
      screen.queryByText(
        '返信の受信が途中で途切れ、サーバー側でも返信の完了を確認できませんでした。もう一度送信してください。',
      ),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '送信' })).toBeDisabled();

    // But it must NOT hang forever: once the give-up threshold is reached, the same
    // persistent entry is accepted as this send's own (delayed) failure.
    expect(
      await screen.findByText(
        '返信の受信が途中で途切れ、サーバー側でも返信の完了を確認できませんでした。もう一度送信してください。',
        {},
        { timeout: 25_000 },
      ),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '送信' })).not.toBeDisabled();
    });
    // 20 (the give-up threshold) plus some margin, given the leading 3s wait above
    // and setTimeout/microtask jitter.
    expect(postDetachCalls).toBeGreaterThanOrEqual(20);
  }, 35_000);

  it('blocks a resend triggered via ⌘/Ctrl+Enter (which bypasses the disabled submit button) while recovery is unresolved (bdboard-v3ag Opus レビュー指摘 W3)', async () => {
    // W3: ⌘/Ctrl+Enter は handleKeyDown から formRef.current.requestSubmit() を
    // 直接呼ぶ。ブラウザの `disabled` はマウスクリックによる暗黙の送信は止めるが、
    // requestSubmit() は disabled な送信ボタンの有無にかかわらず form の submit
    // イベントを発火させる。したがって、この経路を実際にブロックしているのは
    // ボタンの disabled 属性ではなく submitChatMessage 冒頭の
    // unresolvedProjectRecoveryAtSubmit ガードそのものである。それを確認する。
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
    fetchChatTurnStatusMock.mockResolvedValue({
      state: 'processing',
      message: 'detach this',
      agentId: 'claude',
    });
    let streamPosts = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/chat/message/stream' && init?.method === 'POST') {
        streamPosts += 1;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode('event: delta\ndata: {"text":"partial"}\n\n'),
              );
              controller.close();
            },
          }),
        );
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A]);
    await screen.findByLabelText('チャットエージェント');
    await user.type(screen.getByLabelText('メッセージ'), 'detach this');
    await user.click(screen.getByRole('button', { name: '送信' }));
    await waitFor(() => {
      expect(
        screen.getByRole('log').querySelector('.chat-message-streaming .chat-message-text')
          ?.textContent,
      ).toBe('partial');
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '送信' })).toBeDisabled();
    });
    expect(streamPosts).toBe(1);

    await user.type(screen.getByLabelText('メッセージ'), 'second try');
    await user.type(screen.getByLabelText('メッセージ'), '{Meta>}{Enter}{/Meta}');

    // ⌘+Enter で form.requestSubmit() が呼ばれても、submitChatMessage 自身の
    // ガードにより2本目のストリーム POST は発生しない。
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(streamPosts).toBe(1);
    expect(
      screen.getByRole('log').querySelector('.chat-message-streaming .chat-message-text')
        ?.textContent,
    ).toBe('partial');
  });
});
