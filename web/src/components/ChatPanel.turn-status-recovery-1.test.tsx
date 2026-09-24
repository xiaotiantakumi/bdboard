// bdboard-sso1.83 第5段: ChatPanel.test.tsx から move-only で切り出したファイル
// (ChatPanel.turn-status-recovery-1.test.tsx)。手本: sso1.85 の HygienePanel 分割。テスト本体・期待値・文言は
// 1文字も変えていない。共有の fixture/render ヘルパーは ChatPanel-test-support.tsx
// から import する。vi.mock はファイル単位でホイストされるため、元ファイルの
// vi.mock('../api', ...) ブロックと beforeEach/afterEach をこのファイルにも複製している。

import { screen, waitFor, within } from '@testing-library/react';
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
  PROJECT_B,
  STREAMING_AGENT,
  createDeferred,
  jsonResponse,
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

  it('shows a detached turn as processing, then refreshes and restores its completed reply', async () => {
    fetchChatTurnStatusMock
      .mockResolvedValueOnce({
        state: 'processing',
        message: 'detached question',
        agentId: 'claude',
      })
      .mockResolvedValue({
        state: 'completed',
        sessionId: 'sess-detached',
        agentId: 'claude',
        completedAt: '2026-08-18T12:00:00.000Z',
      });
    fetchChatThreadsMock
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        {
          sessionId: 'sess-detached',
          agentId: 'claude',
          title: 'detached question',
          pinned: false,
          updatedAt: '2026-08-18T12:00:00.000Z',
        },
      ]);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/chat/sessions/sess-detached/messages')) {
        return jsonResponse({
          sessionId: 'sess-detached',
          agentId: 'claude',
          messages: [
            {
              role: 'user',
              content: 'detached question',
              createdAt: '2026-08-18T11:59:00.000Z',
            },
            {
              role: 'assistant',
              content: 'reply completed after close',
              createdAt: '2026-08-18T12:00:00.000Z',
            },
          ],
        });
      }
      throw new Error(`Unexpected fetch: GET ${url}`);
    });

    renderChatPanel([PROJECT_A]);

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
    expect(
      await screen.findByText('reply completed after close', {}, { timeout: 2_500 }),
    ).toBeInTheDocument();
    expect(acknowledgeChatTurnMock).toHaveBeenCalledWith('proj-a', 'sess-detached');
  });

  it('shows the pending user message while a detached turn is still processing', async () => {
    fetchChatTurnStatusMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                state: 'processing',
                message: 'detached question',
                agentId: 'claude',
              }),
            50,
          );
        }),
    );
    fetchChatThreadsMock.mockResolvedValue([]);

    renderChatPanel([PROJECT_A]);

    expect(
      await screen.findByText('返信をバックグラウンドで処理中…'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('log')).getByText('detached question'),
    ).toBeInTheDocument();
  });

  it('ignores an older initial thread-list response that resolves after recovery', async () => {
    const initialThreads = createDeferred<ChatThreadDto[]>();
    let threadRequestCount = 0;
    fetchChatThreadsMock.mockImplementation(() => {
      threadRequestCount += 1;
      if (threadRequestCount === 1) return initialThreads.promise;
      return Promise.resolve([
        {
          sessionId: 'sess-recovered',
          agentId: 'claude',
          title: 'recovered thread',
          pinned: false,
          updatedAt: '2026-08-18T12:00:00.000Z',
        },
      ]);
    });
    fetchChatTurnStatusMock.mockResolvedValue({
      state: 'completed',
      sessionId: 'sess-recovered',
      agentId: 'claude',
      completedAt: '2026-08-18T12:00:00.000Z',
    });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/chat/sessions/sess-recovered/messages')) {
        return jsonResponse({
          sessionId: 'sess-recovered',
          agentId: 'claude',
          messages: [
            {
              role: 'assistant',
              content: 'recovered history',
              createdAt: '2026-08-18T12:00:00.000Z',
            },
          ],
        });
      }
      throw new Error(`Unexpected fetch: GET ${url}`);
    });

    const { container } = renderChatPanel([PROJECT_A]);
    openThreadDrawer(container);
    expect(
      await within(getThreadDrawer(container)).findByRole('button', { name: 'recovered thread' }),
    ).toBeInTheDocument();
    initialThreads.resolve([
      {
        sessionId: 'sess-stale',
        agentId: 'claude',
        title: 'stale initial thread',
        pinned: false,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await waitFor(() => {
      openThreadDrawer(container);
      expect(
        within(getThreadDrawer(container)).queryByRole('button', { name: 'stale initial thread' }),
      ).not.toBeInTheDocument();
      expect(
        within(getThreadDrawer(container)).getByRole('button', { name: 'recovered thread' }),
      ).toBeInTheDocument();
    });
  });

  it('shows the stream error and clears the partial streaming reply', async () => {
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
    // bdboard-l1t.9 Opus レビュー S7: エラー発生前にストリーミング吹き出しが実際に
    // 表示されていたことを確認できるよう、error chunk の送出をテスト側から
    // 制御できるゲートを挟む(同期的に一気に enqueue すると途中経過を
    // 観測できないまま最終状態だけを見てしまう)。
    let releaseErrorChunk: () => void = () => {};
    const errorChunkGate = new Promise<void>((resolve) => {
      releaseErrorChunk = resolve;
    });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/chat/message/stream' && init?.method === 'POST') {
        return new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(
                new TextEncoder().encode('event: delta\ndata: {"text":"partial"}\n\n'),
              );
              await errorChunkGate;
              controller.enqueue(
                new TextEncoder().encode(
                  'event: error\ndata: {"error":"chat failed","code":"agent-error","detail":"safe detail"}\n\n',
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
    await user.type(screen.getByLabelText('メッセージ'), 'fail this stream');
    await user.click(screen.getByRole('button', { name: '送信' }));

    const messages = screen.getByRole('log');
    // エラー到着前: ストリーミング吹き出しが部分テキストとともに実在したことを確認する。
    await waitFor(() => {
      const streamingText = messages.querySelector('.chat-message-streaming .chat-message-text');
      expect(streamingText).not.toBeNull();
      expect(streamingText?.textContent).toBe('partial');
    });

    releaseErrorChunk();

    await waitFor(() => {
      const errorMessage = within(messages).getByText('chat failed');
      expect(errorMessage).toHaveClass('chat-message-text');
      expect(errorMessage.closest('.chat-message')).toHaveClass('chat-message-error');
      expect(messages.querySelector('.chat-message-streaming')).toBeNull();
    });
  });

  it('acks the failed turn-status entry when a still-connected client sees the inline SSE error event (bdboard-w26w)', async () => {
    // bdboard-w26w: PR #482 (bdboard-3tw.165) recorded every ChatAgentError into
    // failedTurns unconditionally (recordFailedTurn), mirroring recordCompletedTurn, but
    // only the completed-turn success path (applyChatSuccess) acked it. A client that is
    // still connected and sees the failure directly via the inline SSE 'error' event
    // (this test) never called DELETE /api/chat/turn-status, so the entry piled up until
    // CHAT_COMPLETED_TURNS_MAX eviction. This test sends two turns on the same session:
    // the first succeeds (establishing sessionId), the second fails inline while still
    // connected, and asserts the failure is acked with that same sessionId.
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/chat/message/stream' && init?.method === 'POST') {
        const body = JSON.parse((init.body as string | undefined) ?? '{}') as {
          sessionId?: string;
        };
        if (body.sessionId === undefined) {
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    'event: done\ndata: {"reply":"first reply","sessionId":"sess-w26w","agentId":"claude"}\n\n',
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
                new TextEncoder().encode(
                  'event: error\ndata: {"error":"chat failed","code":"agent-error"}\n\n',
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
    await user.type(screen.getByLabelText('メッセージ'), 'first message');
    await user.click(screen.getByRole('button', { name: '送信' }));
    await screen.findByText('first reply');
    expect(acknowledgeChatTurnMock).toHaveBeenCalledWith('proj-a', 'sess-w26w');

    // 以降のアサートが今回のバグ修正 (失敗時の ACK) 由来であることを、成功時の
    // ACK 呼び出しと区別するためにクリアする。
    acknowledgeChatTurnMock.mockClear();

    await user.type(screen.getByLabelText('メッセージ'), 'second message');
    await user.click(screen.getByRole('button', { name: '送信' }));

    const messages = screen.getByRole('log');
    await waitFor(() => {
      expect(within(messages).getByText('chat failed')).toBeInTheDocument();
    });
    expect(acknowledgeChatTurnMock).toHaveBeenCalledWith('proj-a', 'sess-w26w');
  });

  it('blocks a resend while an earlier same-project detached send is still being recovered (bdboard-v3ag), which also makes the bdboard-w26w finding-1 direct-ACK-skip branch unreachable from a single tab', async () => {
    // 由来: bdboard-w26w Opus レビュー finding 1。DELETE /api/chat/turn-status は同じ
    // sessionId の completed と failed を両方まとめて ACK する (ackCompletedTurn +
    // ackFailedTurn, chat-routes.ts)。isBusy はプロジェクト単位のロックなので、
    // 「同じ会話への前の送信 (D) が配信停止し、まだ回収が終わっていない間に、後続の
    // 送信 (N) がインライン失敗する」状況が起きれば、N の失敗を直接 ACK すると D の
    // 未回収の completed エントリまで巻き添えで消しうる、というのが finding-1 の懸念
    // だった。それを防ぐガード (unresolvedSameSessionDetach, ChatPanel.tsx) 自体は
    // まだ残っている。
    //
    // ただし bdboard-v3ag (このテスト) は、その前提そのもの — 「D が未回収の間に
    // 同じタブから N を送れてしまう」— を1つ手前で塞ぐ: D の turn-status 回収が
    // 'processing' のまま確定していない間は送信ボタンを disabled にし、
    // submitChatMessage 自体もガードする (サーバー側の 409/isBusy と足並みを揃える)。
    // そのため、この1コンポーネントインスタンス (=1タブ) の中では N がそもそも
    // 送信できず、finding-1 の直接 ACK スキップ分岐はもう露出しない
    // (別タブ/別クライアントからの N は、そのタブ自身の detachedStreamSendRef が
    // D を追っていないため、そもそもこのガードの対象にならない — finding-1 の
    // コードは今もそちら向けの防御として残る)。
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
    fetchChatTurnStatusMock.mockResolvedValue({
      state: 'processing',
      message: 'detach this',
      agentId: 'claude',
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
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    'event: done\ndata: {"reply":"first reply","sessionId":"sess-w26w-guard","agentId":"claude"}\n\n',
                  ),
                );
                controller.close();
              },
            }),
          );
        }
        if (streamPosts === 2) {
          return new Response(
            new ReadableStream({
              async start(controller) {
                controller.enqueue(
                  new TextEncoder().encode('event: delta\ndata: {"text":"d partial"}\n\n'),
                );
                await closeGate;
                controller.close();
              },
            }),
          );
        }
        throw new Error('unexpected third stream POST: a resend should have been blocked client-side');
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A]);
    await screen.findByLabelText('チャットエージェント');
    await user.type(screen.getByLabelText('メッセージ'), 'first message');
    await user.click(screen.getByRole('button', { name: '送信' }));
    await screen.findByText('first reply');
    expect(acknowledgeChatTurnMock).toHaveBeenCalledWith('proj-a', 'sess-w26w-guard');
    acknowledgeChatTurnMock.mockClear();

    await user.type(screen.getByLabelText('メッセージ'), 'detach this');
    await user.click(screen.getByRole('button', { name: '送信' }));
    await waitFor(() => {
      expect(
        screen.getByRole('log').querySelector('.chat-message-streaming .chat-message-text')
          ?.textContent,
      ).toBe('d partial');
    });
    releaseClose();
    await waitFor(() => {
      expect(screen.getByLabelText('メッセージ')).not.toBeDisabled();
    });

    // D の回収 (turn-status) がまだ 'processing' のまま確定していないので、送信ボタンは
    // disabled のまま — 入力欄自体は使えるが、送信できない (bdboard-v3ag)。
    await user.type(screen.getByLabelText('メッセージ'), 'second try');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '送信' })).toBeDisabled();
    });
    await user.click(screen.getByRole('button', { name: '送信' }));

    // bdboard-v3ag Opus レビュー指摘 (nit N2): この回帰を実際に検出しているのは
    // 直前の toBeDisabled() の waitFor (ガードを外すと disabled にならずここで
    // タイムアウトする)。この下の streamPosts===2 はそのうえでの二重チェックで、
    // 万一クリックがすり抜けて3本目の POST が発生しても、上の fetchMock 実装は
    // Promise を reject するだけ — アプリ側の catch (postChatMessageStream の
    // エラーハンドリング) に飲まれて通常のチャットエラー表示になるだけで、
    // テスト自体を例外で落とすわけではない。
    // (旧コメントは「fetchMock が例外を投げてテストを落とす」としていたが不正確
    // だったため修正した。)
    // クリックしても3本目のストリーム POST は発生しない。D の部分テキストは
    // 消えずに残る。
    expect(streamPosts).toBe(2);
    expect(
      screen.getByRole('log').querySelector('.chat-message-streaming .chat-message-text')
        ?.textContent,
    ).toBe('d partial');
    expect(screen.getByLabelText('メッセージ')).toHaveValue('second try');
    expect(acknowledgeChatTurnMock).not.toHaveBeenCalled();
  });

  it('recovers a completed turn instead of showing an error when the stream ends without done (bdboard-zlzo)', async () => {
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
    // サーバーは SSE キュー上限超過で done/error を送らずに配信だけを止め、ターンは
    // 裏で完走・保存する。ストリーム終了前の turn-status は idle、終了後は processing
    // を 1 回返してから completed になる。
    let streamClosed = false;
    let statusCallsAfterClose = 0;
    fetchChatTurnStatusMock.mockImplementation(async () => {
      if (!streamClosed) return { state: 'idle' };
      statusCallsAfterClose += 1;
      if (statusCallsAfterClose === 1) {
        return { state: 'processing', message: 'overflow question', agentId: 'claude' };
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
              content: 'full reply recovered from turn-status',
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
      await screen.findByText('full reply recovered from turn-status', {}, { timeout: 2_500 }),
    ).toBeInTheDocument();
    expect(acknowledgeChatTurnMock).toHaveBeenCalledWith('proj-a', 'sess-overflow');
    expect(statusCallsAfterClose).toBeGreaterThanOrEqual(2);
    // 送信失敗扱いにしない: エラー吹き出しも入力欄への本文復元も起きない。
    expect(screen.getByRole('log').querySelectorAll('.chat-message-error')).toHaveLength(0);
    expect(screen.queryByText('chat stream ended unexpectedly')).not.toBeInTheDocument();
    expect(screen.getByLabelText('メッセージ')).toHaveValue('');
  });

  it('keeps showing the last received partial text and a near-input processing indicator while recovering a detached turn, then replaces both with the completed reply (bdboard-3tw.166)', async () => {
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
    // 同じ done なし配信停止シナリオ (bdboard-zlzo) だが、このテストは回収中
    // (turn-status が processing を返している間) に何が見えているかを検証する:
    // 直前まで受け取っていた部分テキストが消えずに残っていること、かつ入力欄付近にも
    // 処理中インジケータが出ていること。completed が届くゲートを自前で止めて、
    // その "processing のまま" の窓を確定的に観測できるようにする。
    let streamClosed = false;
    let statusCallsAfterClose = 0;
    let releaseCompletion: () => void = () => {};
    const completionGate = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    fetchChatTurnStatusMock.mockImplementation(async () => {
      if (!streamClosed) return { state: 'idle' };
      statusCallsAfterClose += 1;
      if (statusCallsAfterClose === 1) {
        return { state: 'processing', message: 'overflow question', agentId: 'claude' };
      }
      await completionGate;
      return {
        state: 'completed',
        sessionId: 'sess-overflow-2',
        agentId: 'claude',
        // bdboard-96rp (Opus レビュー指摘 W1): 追っている送信の sessionId が未確定
        // (新規スレッドの初回送信) な間は、completed の completedAt が detachedAt
        // (=この送信を追い始めた実時刻) 以降であることまで確認するようになった。
        // 固定の過去日時だと、実行時刻によってはこの現実的な時系列の前提
        // (completedAt は detachedAt より前には絶対にならない) を満たさなくなり
        // テストが壊れるため、実行時刻ベースの値にする。
        completedAt: new Date().toISOString(),
      };
    });
    fetchChatThreadsMock.mockImplementation(async () =>
      streamClosed
        ? [
            {
              sessionId: 'sess-overflow-2',
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
      if (url.includes('/api/chat/sessions/sess-overflow-2/messages')) {
        return jsonResponse({
          sessionId: 'sess-overflow-2',
          agentId: 'claude',
          messages: [
            { role: 'user', content: 'overflow question', createdAt: '2026-09-13T08:00:00.000Z' },
            {
              role: 'assistant',
              content: 'full reply recovered while indicator was showing',
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

    // 回収中 (processing) の窓: ログ上部・入力欄付近、両方のインジケータが見える。
    await screen.findByText('返信をバックグラウンドで処理中…', {}, { timeout: 2_500 });
    await screen.findByText('バックグラウンドで応答を処理中です…', {}, { timeout: 2_500 });
    // この時点ではまだ回収が確定していないので、直前に受け取った部分テキストは
    // 消えずに残っている (bdboard-3tw.166 の要件)。
    expect(
      messages.querySelector('.chat-message-streaming .chat-message-text')?.textContent,
    ).toBe('partial');

    releaseCompletion();

    expect(
      await screen.findByText(
        'full reply recovered while indicator was showing',
        {},
        { timeout: 2_500 },
      ),
    ).toBeInTheDocument();
    // 回収したターンの本文が届いたら、部分テキストの吹き出しと両方の処理中
    // インジケータは両方とも消える (二重表示にならない)。
    expect(messages.querySelector('.chat-message-streaming')).not.toBeInTheDocument();
    expect(screen.queryByText('返信をバックグラウンドで処理中…')).not.toBeInTheDocument();
    expect(screen.queryByText('バックグラウンドで応答を処理中です…')).not.toBeInTheDocument();
    expect(acknowledgeChatTurnMock).toHaveBeenCalledWith('proj-a', 'sess-overflow-2');
  });

  it('keeps a still-recovering project A partial reply intact after switching to project B, sending there, and completing that send normally (bdboard-1qoe)', async () => {
    // streamingReply が単一スロットだった頃は、プロジェクト B での送信開始時の
    // 初期化 (setStreamingReply({ key: sendKeyB, text: '' })) と完了時のクリア
    // (setStreamingReply(null)) が、無関係なプロジェクト A がバックグラウンドで
    // 配信停止回収待ちのまま保持していた部分テキストを巻き添えで消していた
    // (元チケット bdboard-v3ag PR #492 の Opus レビュー worth-considering W2)。
    // 会話キーでスコープした Record に変えたことで、これが構造的に起きなくなった
    // ことを検証する。
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
    fetchChatThreadsMock.mockResolvedValue([]);
    // プロジェクト A の配信停止回収は意図的に永遠に 'processing' のまま止めておく
    // (この会話キーの部分テキストが、他の操作で偶発的に消えていないかだけを見たい
    // ため。'idle'/'failed'/'completed' に倒すと、その分岐自身が別の理由で
    // clearStreamingReplyForKey を呼んでしまい、何を検証しているのか曖昧になる)。
    // プロジェクト B は何も配信停止していないので 'idle' のままでよい。
    fetchChatTurnStatusMock.mockImplementation(async (projectId: string) =>
      projectId === PROJECT_A.id ? { state: 'processing' as const } : { state: 'idle' as const },
    );

    let releaseAClose: () => void = () => {};
    const aCloseGate = new Promise<void>((resolve) => {
      releaseAClose = resolve;
    });
    let releaseBDone: () => void = () => {};
    const bDoneGate = new Promise<void>((resolve) => {
      releaseBDone = resolve;
    });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/chat/message/stream' && init?.method === 'POST') {
        const body = JSON.parse((init.body as string) ?? '{}') as { message?: string };
        if (body.message === 'question from A') {
          return new Response(
            new ReadableStream({
              async start(controller) {
                controller.enqueue(
                  new TextEncoder().encode('event: delta\ndata: {"text":"partial-from-A"}\n\n'),
                );
                await aCloseGate;
                // done/error を送らずに閉じる = ChatStreamEndedWithoutResultError
                // (bdboard-zlzo の配信停止シナリオ)。
                controller.close();
              },
            }),
          );
        }
        if (body.message === 'question from B') {
          return new Response(
            new ReadableStream({
              async start(controller) {
                controller.enqueue(
                  new TextEncoder().encode('event: delta\ndata: {"text":"partial-from-B"}\n\n'),
                );
                // bdboard-l1t.9 Opus レビュー S7 と同じ理由: delta と done を同期的に
                // 続けて enqueue すると、テスト側が partial-from-B を観測する前に
                // currentConversationKey が sess-b へ進んでしまい (delta 到着時点の
                // 会話キーは draftKey、done 到着後は sessionId)、途中経過を確定的に
                // 観測できない。ゲートで区切る。
                await bDoneGate;
                controller.enqueue(
                  new TextEncoder().encode(
                    'event: done\ndata: {"reply":"reply from B","sessionId":"sess-b","agentId":"claude"}\n\n',
                  ),
                );
                controller.close();
              },
            }),
          );
        }
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A, PROJECT_B], { initialProjectId: PROJECT_A.id });
    await screen.findByLabelText('チャットエージェント');
    await user.type(screen.getByLabelText('メッセージ'), 'question from A');
    await user.click(screen.getByRole('button', { name: '送信' }));

    const messagesA = screen.getByRole('log');
    await waitFor(() => {
      expect(
        messagesA.querySelector('.chat-message-streaming .chat-message-text')?.textContent,
      ).toBe('partial-from-A');
    });

    releaseAClose();
    // 配信停止 → バックグラウンド回収中インジケータが出るまで待つ (この時点で
    // detachedStreamSendRef がプロジェクト A を指した状態になる)。
    await screen.findByText('返信をバックグラウンドで処理中…', {}, { timeout: 2_500 });
    expect(
      messagesA.querySelector('.chat-message-streaming .chat-message-text')?.textContent,
    ).toBe('partial-from-A');

    // プロジェクト B へ切り替える (A の配信停止回収はまだ未解決のまま)。
    await user.selectOptions(screen.getByLabelText('対象プロジェクト'), PROJECT_B.id);
    await waitFor(() => {
      expect(fetchChatThreadsMock).toHaveBeenCalledWith(PROJECT_B.id);
    });

    // プロジェクト B で送信し、途中経過を経て正常に完了させる。
    await user.type(screen.getByLabelText('メッセージ'), 'question from B');
    await user.click(screen.getByRole('button', { name: '送信' }));

    const messagesB = screen.getByRole('log');
    await waitFor(() => {
      expect(
        messagesB.querySelector('.chat-message-streaming .chat-message-text')?.textContent,
      ).toBe('partial-from-B');
    });
    releaseBDone();
    expect(await within(messagesB).findByText('reply from B')).toBeInTheDocument();
    expect(messagesB.querySelector('.chat-message-streaming')).not.toBeInTheDocument();

    // プロジェクト A へ戻る: バックグラウンドで回収待ちのまま保持していたはずの
    // 部分テキストが、B での送信開始/完了に巻き添えで消されていないことを確認する。
    await user.selectOptions(screen.getByLabelText('対象プロジェクト'), PROJECT_A.id);
    await waitFor(() => {
      expect(fetchChatThreadsMock).toHaveBeenCalledWith(PROJECT_A.id);
    });
    const messagesAfterSwitchBack = screen.getByRole('log');
    expect(
      messagesAfterSwitchBack.querySelector('.chat-message-streaming .chat-message-text')
        ?.textContent,
    ).toBe('partial-from-A');
  });

  it("resolves project A's own detached send after project B also detaches, instead of leaving A frozen forever (bdboard-t5i0, bdboard-1qoe の残課題)", async () => {
    // 単一スロットの ref だった頃は、サーバー側の isBusy ロックがプロジェクト単位
    // である以上ごく普通に起きる「プロジェクト A の配信停止が回収待ちのまま、別
    // プロジェクト B でも配信停止した」場合に、B への代入が A の
    // { fail, streamingKey, ... } を無条件に上書きしていた。結果、A の fail() が
    // 永久に失われ、A の checkTurnStatus がその後 'idle'/'failed' を見ても、ref は
    // もう B の情報しか持たないため A 用の fail() を呼べず、A は「回収中」のまま
    // 二度と解決しない凍りついた表示になっていた。projectId をキーにした Record 化
    // により、B の代入が A のエントリに触れず、A へ戻ったときに A 自身の
    // checkTurnStatus が正しく解決できることを検証する。
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
    fetchChatThreadsMock.mockResolvedValue([]);

    // プロジェクト A の turn-status は、サーバー側で本当に completed/failed を残さず
    // idle に落ちたと分かるまで (aTurnIdle を true にするまで) 'processing' のまま
    // 止めておく。プロジェクト B はこのテストの検証対象外なので、常に 'processing'
    // のままにしておく (B 自身が解決されるかどうかはこのテストの主張と無関係)。
    let aTurnIdle = false;
    fetchChatTurnStatusMock.mockImplementation(async (projectId: string) =>
      projectId === PROJECT_A.id
        ? { state: aTurnIdle ? ('idle' as const) : ('processing' as const) }
        : { state: 'processing' as const },
    );

    let releaseAClose: () => void = () => {};
    const aCloseGate = new Promise<void>((resolve) => {
      releaseAClose = resolve;
    });
    let releaseBClose: () => void = () => {};
    const bCloseGate = new Promise<void>((resolve) => {
      releaseBClose = resolve;
    });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/chat/message/stream' && init?.method === 'POST') {
        const body = JSON.parse((init.body as string) ?? '{}') as { message?: string };
        if (body.message === 'question from A') {
          return new Response(
            new ReadableStream({
              async start(controller) {
                controller.enqueue(
                  new TextEncoder().encode('event: delta\ndata: {"text":"partial-from-A"}\n\n'),
                );
                await aCloseGate;
                // done/error を送らずに閉じる = ChatStreamEndedWithoutResultError
                // (bdboard-zlzo の配信停止シナリオ)。
                controller.close();
              },
            }),
          );
        }
        if (body.message === 'question from B') {
          return new Response(
            new ReadableStream({
              async start(controller) {
                controller.enqueue(
                  new TextEncoder().encode('event: delta\ndata: {"text":"partial-from-B"}\n\n'),
                );
                await bCloseGate;
                controller.close();
              },
            }),
          );
        }
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A, PROJECT_B], { initialProjectId: PROJECT_A.id });
    await screen.findByLabelText('チャットエージェント');
    await user.type(screen.getByLabelText('メッセージ'), 'question from A');
    await user.click(screen.getByRole('button', { name: '送信' }));

    const messagesA = screen.getByRole('log');
    await waitFor(() => {
      expect(
        messagesA.querySelector('.chat-message-streaming .chat-message-text')?.textContent,
      ).toBe('partial-from-A');
    });

    releaseAClose();
    // A が配信停止 → detachedStreamSendRef['proj-a'] が積まれる。
    await screen.findByText('返信をバックグラウンドで処理中…', {}, { timeout: 2_500 });

    // A から B へ切り替える (A の回収はまだ未解決のまま)。
    await user.selectOptions(screen.getByLabelText('対象プロジェクト'), PROJECT_B.id);
    await waitFor(() => {
      expect(fetchChatThreadsMock).toHaveBeenCalledWith(PROJECT_B.id);
    });

    // B でも送信し、配信停止させる (detachedStreamSendRef['proj-b'] を積む。単一
    // スロットの ref だった頃は、この代入が A のエントリを丸ごと上書きして消して
    // いた)。
    await user.type(screen.getByLabelText('メッセージ'), 'question from B');
    await user.click(screen.getByRole('button', { name: '送信' }));

    const messagesB = screen.getByRole('log');
    await waitFor(() => {
      expect(
        messagesB.querySelector('.chat-message-streaming .chat-message-text')?.textContent,
      ).toBe('partial-from-B');
    });
    releaseBClose();
    await screen.findByText('返信をバックグラウンドで処理中…', {}, { timeout: 2_500 });

    // サーバー側では A のターンは completed/failed を残さず、本当に idle へ落ちて
    // いた、という事実がここで判明する。
    aTurnIdle = true;

    // A へ戻る: 単一スロットの ref だった頃は、ref はもう B の情報しか持っておらず
    // (detached.projectId === selectedProjectId が B !== A で不一致)、A 側の
    // checkTurnStatus はこの idle を見ても何もできず、A は「回収中」のまま凍りつい
    // て二度と解決しなかった。Record 化後は A 自身のエントリが生き残っているので、
    // A へ戻った時点の checkTurnStatus が正しく fail() を呼び、通常の送信失敗表示
    // に落ちる。
    await user.selectOptions(screen.getByLabelText('対象プロジェクト'), PROJECT_A.id);
    await waitFor(() => {
      expect(fetchChatThreadsMock).toHaveBeenCalledWith(PROJECT_A.id);
    });

    const errorText = await screen.findByText(
      '返信の受信が途中で途切れ、サーバー側でも返信の完了を確認できませんでした。もう一度送信してください。',
      {},
      { timeout: 2_500 },
    );
    expect(errorText.closest('.chat-message')).toHaveClass('chat-message-error');
    // 回収が失敗として確定した以上、A の部分テキストの吹き出しはもう残っていない
    // (エラー吹き出しと二重に出たままにしない、bdboard-3tw.166 と同じ不変条件)。
    expect(
      screen.getByRole('log').querySelector('.chat-message-streaming'),
    ).not.toBeInTheDocument();
    // 送信欄の本文も通常の送信失敗と同じく復元されている。
    expect(screen.getByLabelText('メッセージ')).toHaveValue('question from A');
  });

  // bdboard-sso1.83 特性テスト T6 (設計メモ §5 P2 の再現テスト): 同じプロジェクト
  // 内で、まだ履歴未読込のスレッドへストリーム中に切り替えると、切替による abort が
  // 少し遅れて generation を bump し、E8(turn-status 回収)が再実行される。以前の
  // E8 は generation>0 のたびに historyRequestIdRef を進めていたため、E12(履歴
  // ローダー)の in-flight fetch の応答も finally の historyLoadedFor 書き込みも
  // requestId 不一致で握りつぶされ、E12 は deps(conversations、historyLoadedFor)が
  // 変わらないので再実行されず、送信ボタンが無効のまま戻らなかった。第5段では
  // it.fails で固定し、bdboard-ibkf で E8 が履歴の request-id を進めるのを hydrate の
  // 直前だけにして直した。
  it('P2: re-enables the submit button after switching to a not-yet-history-loaded thread while streaming', async () => {
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
    fetchChatThreadsMock.mockResolvedValue([
      { sessionId: 'sess-1', agentId: 'claude', title: 'first thread', pinned: false, updatedAt: '2026-01-02T00:00:00Z' },
      { sessionId: 'sess-2', agentId: 'claude', title: 'second thread', pinned: false, updatedAt: '2026-01-01T00:00:00Z' },
    ]);

    const sess2History = createDeferred<Response>();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/chat/sessions/sess-1/messages')) {
        return jsonResponse({ sessionId: 'sess-1', agentId: 'claude', messages: [] });
      }
      if (url.includes('/api/chat/sessions/sess-2/messages')) {
        return sess2History.promise;
      }
      if (url === '/api/chat/message/stream' && init?.method === 'POST') {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode('event: delta\ndata: {"text":"partial "}\n\n'),
              );
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
    await user.type(screen.getByLabelText('メッセージ'), 'question from sess-1');
    await user.click(screen.getByRole('button', { name: '送信' }));
    await waitFor(() => {
      expect(screen.getByRole('log').querySelector('.chat-message-streaming')).not.toBeNull();
    });

    // まだ履歴未読込の sess-2 へ切り替える。これが sess-1 のストリーミング
    // fetch を abort する(useAbortOnConversationChange)。
    await selectThreadFromDrawer(container, user, 'second thread');

    // abort が submit の catch(AbortError) 経路を通って
    // setTurnRecoveryGeneration(g => g+1) を呼ぶのは非同期タイミング。E8 は
    // generation が進むと turn-status を取り直すので、その2回目を待ってから
    // sess-2 の履歴 fetch を解決し、「E8 の generation bump が E12 の in-flight
    // fetch より後から割り込む」順序を確実に作る(固定の sleep だと、遅い環境
    // では bump より先に解決して修正前でも通ってしまう)。
    await waitFor(() => {
      expect(fetchChatTurnStatusMock).toHaveBeenCalledTimes(2);
    });
    sess2History.resolve(
      jsonResponse({ sessionId: 'sess-2', agentId: 'claude', messages: [] }),
    );

    await user.type(screen.getByLabelText('メッセージ'), 'question from sess-2');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '送信' })).not.toBeDisabled();
    });
  });
});
