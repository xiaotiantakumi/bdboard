// bdboard-sso1.83 第5段: ChatPanel.test.tsx から move-only で切り出したファイル
// (ChatPanel.send-stream-basics.test.tsx)。手本: sso1.85 の HygienePanel 分割。テスト本体・期待値・文言は
// 1文字も変えていない。共有の fixture/render ヘルパーは ChatPanel-test-support.tsx
// から import する。vi.mock はファイル単位でホイストされるため、元ファイルの
// vi.mock('../api', ...) ブロックと beforeEach/afterEach をこのファイルにも複製している。

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatAgentDto, ChatThreadDto, ChatTurnStatusDto } from '../api';
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

  it('sends the first message without sessionId and shows the reply', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/chat/message' && init?.method === 'POST') {
        return jsonResponse({
          reply: 'Hello from AI',
          sessionId: 'sess-1',
          agentId: 'claude',
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A]);
    await user.type(screen.getByLabelText('メッセージ'), 'first message');
    await user.click(screen.getByRole('button', { name: '送信' }));

    await waitFor(() => {
      expect(getChatMessagePostCalls(fetchMock)).toHaveLength(1);
    });

    const body = parseChatMessageBody(fetchMock);
    expect(body).toEqual({
      projectId: 'proj-a',
      message: 'first message',
    });
    expect(body).not.toHaveProperty('sessionId');
    expect(await screen.findByText('Hello from AI')).toBeInTheDocument();
  });

  it('does not submit via Meta/Ctrl+Enter while the textarea is IME composing (bdboard-sso1.83 特性テスト T2)', async () => {
    // T2: メイン入力で isComposing 中に Meta+Enter を押しても POST しない
    // (第7段 ChatComposer 抽出の前提。今はフック単体(useChatDraftState)の
    // テストにしか無いので、ChatPanel 統合テストとして固定する)。
    const user = userEvent.setup();
    renderChatPanel([PROJECT_A]);
    const textarea = screen.getByLabelText('メッセージ');
    await user.type(textarea, 'still composing');
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true, isComposing: true });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getChatMessagePostCalls(fetchMock)).toHaveLength(0);
    expect(textarea).toHaveValue('still composing');
  });

  it('posts to the streaming endpoint and shows the completed streamed reply', async () => {
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
    // bdboard-l1t.9 Opus レビュー S7: 最終結果(applyChatSuccess後の表示)だけを見ると
    // onDelta が no-op でも通ってしまう。第1delta到着後・done到着前の途中経過を
    // 明示的に観測できるよう、続きの chunk 送出をテスト側から制御できるゲートを挟む。
    let releaseRemainingChunks: () => void = () => {};
    const remainingChunksGate = new Promise<void>((resolve) => {
      releaseRemainingChunks = resolve;
    });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/chat/message/stream' && init?.method === 'POST') {
        return new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(
                new TextEncoder().encode('event: delta\ndata: {"text":"streamed "}\n\n'),
              );
              await remainingChunksGate;
              controller.enqueue(
                new TextEncoder().encode('event: delta\ndata: {"text":"reply"}\n\n'),
              );
              await Promise.resolve();
              controller.enqueue(
                new TextEncoder().encode(
                  'event: done\ndata: {"reply":"streamed reply","sessionId":"sess-stream","agentId":"claude"}\n\n',
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
    await user.type(screen.getByLabelText('メッセージ'), 'stream this');
    await user.click(screen.getByRole('button', { name: '送信' }));

    const messages = screen.getByRole('log');
    // 第1delta到着後・done到着前: onDelta が実際にストリーミング吹き出しへ
    // 部分テキストを反映していることを確認する(ここが no-op だと絶対に通らない)。
    await waitFor(() => {
      const streamingText = messages.querySelector('.chat-message-streaming .chat-message-text');
      expect(streamingText).not.toBeNull();
      expect(streamingText?.textContent).toBe('streamed ');
    });

    releaseRemainingChunks();

    await waitFor(() => {
      expect(within(messages).getByText('streamed reply')).toBeInTheDocument();
    });
    expect(acknowledgeChatTurnMock).toHaveBeenCalledWith('proj-a', 'sess-stream');
    expect(messages.querySelector('.chat-message-streaming')).toBeNull();
    expect(
      fetchMock.mock.calls.filter(
        ([url, request]) =>
          url === '/api/chat/message/stream' &&
          (request as RequestInit | undefined)?.method === 'POST',
      ),
    ).toHaveLength(1);
    expect(getChatMessagePostCalls(fetchMock)).toHaveLength(0);
  });

  // bdboard-22k: jsdom にはレイアウトが無く scrollHeight/clientHeight は常に 0、
  // scrollTop も書いた値がそのまま残るだけなので、素のままでは「追従した/しなかった」
  // を区別できない。中身の文字数に比例して伸びるスクロール領域を差し込んで、
  // 実ブラウザの挙動を模す。
  //
  // 模擬で外せないのが次の2点 (PR#128 fable レビュー)。素通しの setter にすると、
  // 「最下部にいる状態で scroll ハンドラが動く」経路が一度もテストされず、実機なら
  // 機能が死ぬ変更 (距離計算から clientHeight を落とす・ハンドラが常に unpin する)
  // を通してしまう。逆に scrollTop === scrollHeight という模擬世界にしか無い状態を
  // assert すると、実ブラウザでは等価な scrollTop = scrollHeight - clientHeight への
  // 書き換えを誤って落とす。
  //
  //   1. 代入は 0..scrollHeight-clientHeight にクランプされる
  //   2. 値が動いたら scroll イベントが出る (プログラム的スクロールでも出る)
  //
  // bdboard-dtr で growContent を足した。実ブラウザでは「DOM が伸びた」と
  // 「effect が scrollTop を更新した」の間に隙間があり (useEffect は paint 後に
  // 走る)、その隙間に遅れて届いた scroll イベントは *古い scrollTop × 新しい
  // scrollHeight* で距離を測ってしまう。React の内部タイミングに割り込まずに
  // その状態を作るための穴。
  interface ScrollAreaHandle {
    /** scrollTop を動かさずにスクロール領域だけ伸ばす (DOM だけ先に伸びた状態) */
    growContent: (pixels: number) => void;
  }

  function instrumentScrollArea(
    element: HTMLElement,
    clientHeight: number,
  ): ScrollAreaHandle {
    let scrollTop = 0;
    let extraHeight = 0;
    Object.defineProperty(element, 'clientHeight', {
      configurable: true,
      get: () => clientHeight,
    });
    Object.defineProperty(element, 'scrollHeight', {
      configurable: true,
      get: () =>
        clientHeight + (element.textContent ?? '').length * 10 + extraHeight,
    });
    Object.defineProperty(element, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (next: number) => {
        const max = Math.max(0, element.scrollHeight - clientHeight);
        const clamped = Math.max(0, Math.min(next, max));
        if (clamped === scrollTop) {
          return;
        }
        scrollTop = clamped;
        element.dispatchEvent(new Event('scroll'));
      },
    });
    return {
      growContent: (pixels: number) => {
        extraHeight += pixels;
      },
    };
  }

  function distanceFromBottom(element: HTMLElement): number {
    return element.scrollHeight - element.scrollTop - element.clientHeight;
  }

  // delta1 → (gate1) → delta2 → (gate2) → done。ストリーミング途中の状態を
  // 観測するには、done が来る前で止められる必要がある。done まで走らせると
  // ストリーミング吹き出しが確定メッセージへ差し替わってしまう。
  function gatedStreamFetch(fetchMock: ReturnType<typeof vi.fn>): {
    releaseSecondDelta: () => void;
    releaseDone: () => void;
  } {
    let releaseSecondDelta: () => void = () => {};
    let releaseDone: () => void = () => {};
    const secondDeltaGate = new Promise<void>((resolve) => {
      releaseSecondDelta = resolve;
    });
    const doneGate = new Promise<void>((resolve) => {
      releaseDone = resolve;
    });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/chat/message/stream' && init?.method === 'POST') {
        return new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(
                new TextEncoder().encode('event: delta\ndata: {"text":"streamed "}\n\n'),
              );
              await secondDeltaGate;
              controller.enqueue(
                new TextEncoder().encode(
                  `event: delta\ndata: {"text":"${'reply '.repeat(40)}"}\n\n`,
                ),
              );
              await doneGate;
              controller.enqueue(
                new TextEncoder().encode(
                  'event: done\ndata: {"reply":"done reply","sessionId":"sess-stream","agentId":"claude"}\n\n',
                ),
              );
              controller.close();
            },
          }),
        );
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });
    return { releaseSecondDelta, releaseDone };
  }

  it('follows the streaming reply while pinned to the bottom (bdboard-22k)', async () => {
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
    const { releaseSecondDelta, releaseDone } = gatedStreamFetch(fetchMock);

    renderChatPanel([PROJECT_A]);
    await screen.findByLabelText('チャットエージェント');
    const messages = screen.getByRole('log');
    instrumentScrollArea(messages, 300);

    await user.type(screen.getByLabelText('メッセージ'), 'stream this');
    await user.click(screen.getByRole('button', { name: '送信' }));

    await waitFor(() => {
      expect(
        messages.querySelector('.chat-message-streaming .chat-message-text')?.textContent,
      ).toBe('streamed ');
    });

    releaseSecondDelta();

    // 返信が伸びるたびに最下部へ追従する。deps に streaming テキストが無いと、
    // ここで scrollTop が第1delta時点の高さのまま取り残される。
    //
    // 追従の assert を waitFor の中に入れているのは、DOM の反映 (テキストが
    // 伸びる) と useEffect の実行 (scrollTop を更新する) が同じタイミングでは
    // ないため。テキストだけを待って外で assert すると、負荷の高い CI で
    // 「DOM は伸びたが effect はまだ」の瞬間を踏んで落ちる。追従しない
    // 変更ならここは永久に 0 にならないので、緩めたことにはならない。
    await waitFor(() => {
      expect(
        messages.querySelector('.chat-message-streaming .chat-message-text')?.textContent,
      ).toContain('reply');
      expect(distanceFromBottom(messages)).toBe(0);
    });

    // ストリームを畳んでから終わる。開いたまま抜けると、残りの処理が
    // 環境の teardown 後に走る。
    releaseDone();
    await waitFor(() => {
      expect(messages.querySelector('.chat-message-streaming')).toBeNull();
    });
  });

  it('stops following once the user scrolls up (bdboard-22k)', async () => {
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
    const { releaseSecondDelta, releaseDone } = gatedStreamFetch(fetchMock);

    renderChatPanel([PROJECT_A]);
    await screen.findByLabelText('チャットエージェント');
    const messages = screen.getByRole('log');
    instrumentScrollArea(messages, 300);

    await user.type(screen.getByLabelText('メッセージ'), 'stream this');
    await user.click(screen.getByRole('button', { name: '送信' }));

    await waitFor(() => {
      expect(
        messages.querySelector('.chat-message-streaming .chat-message-text')?.textContent,
      ).toBe('streamed ');
    });

    // 利用者が過去ログを読むために上へスクロールした。
    messages.scrollTop = 0;
    fireEvent.scroll(messages);

    releaseSecondDelta();

    await waitFor(() => {
      expect(
        messages.querySelector('.chat-message-streaming .chat-message-text')?.textContent,
      ).toContain('reply');
    });
    // 追従を止める配慮が無いと、トークンごとに最下部へ引き戻されて読めなくなる。
    expect(messages.scrollTop).toBe(0);

    releaseDone();
    await waitFor(() => {
      expect(messages.querySelector('.chat-message-streaming')).toBeNull();
    });
  });

  it('keeps following when a delayed scroll event lands after the area grew (bdboard-dtr)', async () => {
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
    const { releaseSecondDelta, releaseDone } = gatedStreamFetch(fetchMock);

    renderChatPanel([PROJECT_A]);
    await screen.findByLabelText('チャットエージェント');
    const messages = screen.getByRole('log');
    const scrollArea = instrumentScrollArea(messages, 300);

    await user.type(screen.getByLabelText('メッセージ'), 'stream this');
    await user.click(screen.getByRole('button', { name: '送信' }));

    await waitFor(() => {
      expect(
        messages.querySelector('.chat-message-streaming .chat-message-text')?.textContent,
      ).toBe('streamed ');
    });
    // ここまでで effect が最下部へ動かしている。これも waitFor で待つ:
    // テキストの反映と effect の実行は同じタイミングではないので、外で
    // assert すると CI で「DOM は伸びたが effect はまだ」を踏む。同時に、
    // 次の growContent が前提とする「マーカーが記録済み」の同期点も兼ねる。
    await waitFor(() => {
      expect(distanceFromBottom(messages)).toBe(0);
    });

    // 実ブラウザでの競合を再現する。プログラム的スクロールでも scroll イベントは
    // 飛ぶが、それが配送されるまでの間に次の delta で DOM が伸びる。useEffect は
    // paint 後に走るので、「scrollHeight は伸びたが scrollTop はまだ古い」瞬間が
    // 存在し、遅れて届いたイベントはそこで距離を測ってしまう。
    // 貼り付き閾値 (48px) より十分大きく伸ばす。閾値そのものを import せず
    // リテラルで書くのは、閾値の値をテストで固定してしまわないため。
    scrollArea.growContent(200);
    fireEvent.scroll(messages);

    releaseSecondDelta();

    // ここで貼り付きが外れていると、利用者が何も操作していないのに追従が止まる
    // (bdboard-22k の元バグと同じ症状で、手で最下部へ戻すまで復旧しない)。
    await waitFor(() => {
      expect(
        messages.querySelector('.chat-message-streaming .chat-message-text')?.textContent,
      ).toContain('reply');
      expect(distanceFromBottom(messages)).toBe(0);
    });

    releaseDone();
    await waitFor(() => {
      expect(messages.querySelector('.chat-message-streaming')).toBeNull();
    });
  });

  it('resumes following when the user scrolls back to the last auto-scrolled position (bdboard-dtr)', async () => {
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
    const { releaseSecondDelta, releaseDone } = gatedStreamFetch(fetchMock);

    renderChatPanel([PROJECT_A]);
    await screen.findByLabelText('チャットエージェント');
    const messages = screen.getByRole('log');
    instrumentScrollArea(messages, 300);

    await user.type(screen.getByLabelText('メッセージ'), 'stream this');
    await user.click(screen.getByRole('button', { name: '送信' }));

    await waitFor(() => {
      expect(
        messages.querySelector('.chat-message-streaming .chat-message-text')?.textContent,
      ).toBe('streamed ');
    });
    await waitFor(() => {
      expect(distanceFromBottom(messages)).toBe(0);
    });
    const autoScrolledTop = messages.scrollTop;
    expect(autoScrolledTop).toBeGreaterThan(0);

    // 上へ読み返してから、また最下部まで戻ってきた。戻り先は effect が最後に
    // 置いた座標と同じ値になる。
    messages.scrollTop = 0;
    messages.scrollTop = autoScrolledTop;

    releaseSecondDelta();

    // 追従を止めた時点でマーカーを捨てていないと、この復帰スクロールが
    // 「自分で起こした残響」に見えて距離判定に落ちず、最下部へ戻ったのに
    // 追従が再開しない (bdboard-dtr)。
    await waitFor(() => {
      expect(
        messages.querySelector('.chat-message-streaming .chat-message-text')?.textContent,
      ).toContain('reply');
      expect(distanceFromBottom(messages)).toBe(0);
    });

    releaseDone();
    await waitFor(() => {
      expect(messages.querySelector('.chat-message-streaming')).toBeNull();
    });
  });

  it('does not re-pin when the user happens to stop on an old auto-scroll position (bdboard-dtr)', async () => {
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
    const { releaseSecondDelta, releaseDone } = gatedStreamFetch(fetchMock);

    renderChatPanel([PROJECT_A]);
    await screen.findByLabelText('チャットエージェント');
    const messages = screen.getByRole('log');
    const scrollArea = instrumentScrollArea(messages, 300);

    await user.type(screen.getByLabelText('メッセージ'), 'stream this');
    await user.click(screen.getByRole('button', { name: '送信' }));

    await waitFor(() => {
      expect(
        messages.querySelector('.chat-message-streaming .chat-message-text')?.textContent,
      ).toBe('streamed ');
    });
    await waitFor(() => {
      expect(distanceFromBottom(messages)).toBe(0);
    });
    // effect が最後に置いた位置。追従を止めたあとも同じ座標が残っていると、
    // ここへ戻ってきただけで貼り付き扱いになってしまう。
    const previousAutoScrollTop = messages.scrollTop;
    expect(previousAutoScrollTop).toBeGreaterThan(0);

    // 利用者が過去ログを読むために上へスクロールし、追従が止まる。
    messages.scrollTop = 0;

    // その間に別の要因で表示が伸び、さっきの座標はもう最下部ではなくなる。
    scrollArea.growContent(1000);

    // 読み進めた結果、たまたま昔の最下部と同じ座標で止まった。利用者は
    // 依然として過去ログを読んでいるので、ここは貼り付きに戻る場面ではない。
    messages.scrollTop = previousAutoScrollTop;

    releaseSecondDelta();

    await waitFor(() => {
      expect(
        messages.querySelector('.chat-message-streaming .chat-message-text')?.textContent,
      ).toContain('reply');
    });
    // 引き戻されていたら、読んでいた位置が返信が届くたびに奪われる。
    expect(messages.scrollTop).toBe(previousAutoScrollTop);

    releaseDone();
    await waitFor(() => {
      expect(messages.querySelector('.chat-message-streaming')).toBeNull();
    });
  });

  it('re-pins to the bottom when the conversation changes (bdboard-22k)', async () => {
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
    const { releaseSecondDelta, releaseDone } = gatedStreamFetch(fetchMock);

    renderChatPanel([PROJECT_A]);
    await screen.findByLabelText('チャットエージェント');
    const messages = screen.getByRole('log');
    instrumentScrollArea(messages, 300);

    // 前の会話で上へスクロールしていた。
    messages.scrollTop = 0;
    fireEvent.scroll(messages);

    await user.click(screen.getByRole('button', { name: '新しい空のスレッドを開始' }));
    instrumentScrollArea(screen.getByRole('log'), 300);

    await user.type(screen.getByLabelText('メッセージ'), 'stream this');
    await user.click(screen.getByRole('button', { name: '送信' }));
    releaseSecondDelta();

    const switched = screen.getByRole('log');
    // 別の会話を開いたのに前の会話のスクロール位置を引きずる理由は無い。
    await waitFor(() => {
      expect(
        switched.querySelector('.chat-message-streaming .chat-message-text')?.textContent,
      ).toContain('reply');
      expect(distanceFromBottom(switched)).toBe(0);
    });

    releaseDone();
    await waitFor(() => {
      expect(switched.querySelector('.chat-message-streaming')).toBeNull();
    });
  });

  it('posts to the non-streaming endpoint for a non-streaming agent', async () => {
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([CLAUDE_AGENT]);

    renderChatPanel([PROJECT_A]);
    await screen.findByLabelText('チャットエージェント');
    await user.type(screen.getByLabelText('メッセージ'), 'regular chat');
    await user.click(screen.getByRole('button', { name: '送信' }));

    await waitFor(() => {
      expect(within(screen.getByRole('log')).getByText('AI reply')).toBeInTheDocument();
    });
    expect(getChatMessagePostCalls(fetchMock)).toHaveLength(1);
    expect(
      fetchMock.mock.calls.some(([url, request]) =>
        url === '/api/chat/message/stream' &&
        (request as RequestInit | undefined)?.method === 'POST',
      ),
    ).toBe(false);
  });

  // bdboard-sso1.83 特性テスト T4: 設計メモは「送信完了後に textarea へ
  // フォーカスが戻る」ことを第13段の前提として要求しているが、現状の
  // ChatPanel.tsx で再現したところ実際には戻らない (it.fails で確認)。原因は
  // submit の outer finally 内で `setIsSending(false)` の直後に同期的に
  // `inputRef.current?.focus()` を呼んでいる点: React 18 はこの2つの状態変化を
  // 同一マイクロタスクでバッチするため、focus() が呼ばれる瞬間の DOM 上の
  // textarea はまだ直前の disabled=true のままで、disabled な要素への focus()
  // はブラウザ/jsdom 双方で無視される。textarea が disabled=false に再描画
  // された後に focus() を再試行する経路が無く、フォーカスは直前にクリックした
  // 送信ボタンに残ったままになる。ChatPanel.tsx は第5段の対象外(move-only +
  // 特性テスト追加のみ)のためここでは直さず、it.fails で現状を固定した上で
  // bd 起票する(第13段 useChatSubmit 抽出時にあわせて修正する想定)。
  it.fails('returns focus to the textarea after a send completes (bdboard-sso1.83 特性テスト T4)', async () => {
    const user = userEvent.setup();
    renderChatPanel([PROJECT_A]);
    const textarea = screen.getByLabelText('メッセージ');
    await user.type(textarea, 'focus check');
    await user.click(screen.getByRole('button', { name: '送信' }));

    await waitFor(() => {
      expect(within(screen.getByRole('log')).getByText('AI reply')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(textarea).toHaveFocus();
    });
  });

  it('advances 考え中…N秒 from 0 to 1 to 2 while sending, and resets to 0 once it completes (bdboard-sso1.83 特性テスト T5)', async () => {
    // T5: fake timers で経過秒が 0→1→2 と進み、完了時に 0 へ戻ることを固定する
    // (第8段 useStickToBottomScroll 分離、第13段 useChatSubmit 抽出の前提。
    // 今は「考え中…N秒」の文言があることを正規表現で見ているだけで、実際に
    // 1秒ごとに数字が進むことまでは確認していない)。
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const deferred = createDeferred<Response>();
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === '/api/chat/message' && init?.method === 'POST') {
          return deferred.promise;
        }
        throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
      });

      renderChatPanel([PROJECT_A]);
      await user.type(screen.getByLabelText('メッセージ'), 'timed message');
      await user.click(screen.getByRole('button', { name: '送信' }));

      expect(
        screen.getByText('考え中…0秒（最大3分かかることがあります）'),
      ).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(
        screen.getByText('考え中…1秒（最大3分かかることがあります）'),
      ).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(
        screen.getByText('考え中…2秒（最大3分かかることがあります）'),
      ).toBeInTheDocument();

      deferred.resolve(
        jsonResponse({ reply: 'done', sessionId: 'sess-done', agentId: 'claude' }),
      );
      await waitFor(() => {
        expect(screen.getByText('done')).toBeInTheDocument();
      });
      expect(screen.queryByText(/考え中…\d+秒/)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  // bdboard-otf(bdboard-dpq レビュー N2 フォローアップ): 送信失敗時に入力欄へ本文を
  // 復元する回帰テスト群。
  describe('restores the input after a send failure (bdboard-otf)', () => {
    it('restores the draft after a non-streaming send failure', async () => {
      const user = userEvent.setup();
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === '/api/chat/message' && init?.method === 'POST') {
          return jsonResponse({ error: 'boom' }, 500);
        }
        throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
      });

      renderChatPanel([PROJECT_A]);
      const input = screen.getByLabelText('メッセージ');
      await user.type(input, 'failed batch message');
      await user.click(screen.getByRole('button', { name: '送信' }));

      await screen.findByText('boom');
      await waitFor(() => {
        expect(screen.getByLabelText('メッセージ')).toHaveValue('failed batch message');
      });
    });

    it('restores the draft after a streaming send failure, including a failure after partial deltas', async () => {
      const user = userEvent.setup();
      fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
      // bdboard-otf Opus レビュー N6: タイトルの「partial deltas 受信後」を
      // テスト自身に確認させる。同期的に一気に enqueue すると、delta が実際に
      // 描画された事実を観測できないまま最終状態だけを見てしまう(l1t.9 の
      // 既存ストリーミングエラーテストと同じゲートパターン)。
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
                    'event: error\ndata: {"error":"stream boom","code":"agent-error"}\n\n',
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
      const input = screen.getByLabelText('メッセージ');
      await user.type(input, 'failed stream message');
      await user.click(screen.getByRole('button', { name: '送信' }));

      const messages = screen.getByRole('log');
      // エラー到着前: ストリーミング吹き出しが部分テキストとともに実在した
      // ことを確認する(N6、これが無いとタイトルの主張が未検証のまま)。
      await waitFor(() => {
        const streamingText = messages.querySelector('.chat-message-streaming .chat-message-text');
        expect(streamingText).not.toBeNull();
        expect(streamingText?.textContent).toBe('partial');
      });

      releaseErrorChunk();

      await screen.findByText('stream boom');
      // ストリーミング途中(delta 受信後)の失敗でも、部分応答の破棄(既存挙動)とは
      // 独立に、ユーザーが送った本文は入力欄へ復元される。
      await waitFor(() => {
        expect(screen.getByLabelText('メッセージ')).toHaveValue('failed stream message');
      });
      expect(messages.querySelector('.chat-message-streaming')).toBeNull();
    });

    it('does not overwrite a draft the user typed into the same key after the send started', async () => {
      const user = userEvent.setup();
      const deferred = createDeferred<Response>();
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === '/api/chat/message' && init?.method === 'POST') {
          return deferred.promise;
        }
        throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
      });

      renderChatPanel([PROJECT_A]);
      const input = screen.getByLabelText('メッセージ');
      await user.type(input, 'original message');
      await user.click(screen.getByRole('button', { name: '送信' }));

      // 送信中は入力欄が disabled になり、同じ会話キーへの直接入力はできない
      // (this repository's UI invariant)。一方でこのキーに新しい下書きが
      // React state 経由で既に入っていた場合(例: プログラム的な書き込み)、
      // 失敗時の復元がそれを上書きしてはいけない、という不変条件を検証する
      // ため、conversationInputs の書き込み経路である onChange を disabled でも
      // 確実に模す代わりに、fireEvent で直接 change イベントを発火させる。
      expect(input).toBeDisabled();
      fireEvent.change(input, { target: { value: 'a newer draft typed meanwhile' } });

      deferred.resolve(jsonResponse({ error: 'boom' }, 500));

      await screen.findByText('boom');
      await waitFor(() => {
        expect(screen.getByLabelText('メッセージ')).toHaveValue('a newer draft typed meanwhile');
      });
    });

    it('restores the draft into the original conversation key, not the one currently visible, when the user switched threads while the send was pending', async () => {
      const user = userEvent.setup();
      fetchChatThreadsMock.mockResolvedValue([
        { sessionId: 'sess-1', agentId: 'claude', title: 'first thread', pinned: false, updatedAt: '2026-01-02T00:00:00Z' },
        { sessionId: 'sess-2', agentId: 'claude', title: 'second thread', pinned: false, updatedAt: '2026-01-01T00:00:00Z' },
      ]);
      const deferred = createDeferred<Response>();
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes('/api/chat/sessions/sess-1/messages')) {
          return jsonResponse({ sessionId: 'sess-1', agentId: 'claude', messages: [] });
        }
        if (url.includes('/api/chat/sessions/sess-2/messages')) {
          return jsonResponse({ sessionId: 'sess-2', agentId: 'claude', messages: [] });
        }
        if (url === '/api/chat/message' && init?.method === 'POST') {
          return deferred.promise;
        }
        throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
      });

      const { container } = renderChatPanel([PROJECT_A]);
      openThreadDrawer(container);
      expect(
        await within(getThreadDrawer(container)).findByRole('button', { name: 'first thread' }),
      ).toBeInTheDocument();

      const input = screen.getByLabelText('メッセージ');
      await user.type(input, 'message for the first thread');
      await user.click(screen.getByRole('button', { name: '送信' }));

      // 送信中でもスレッドタブの切り替え自体は disabled になっていないため、
      // ユーザーは送信の完了を待たずに別スレッドへ切り替えられる。
      await selectThreadFromDrawer(container, user, 'second thread');
      // 現在表示中(second thread)の入力欄は、まだ何も打っていないので空のまま。
      expect(screen.getByLabelText('メッセージ')).toHaveValue('');

      deferred.resolve(jsonResponse({ error: 'boom' }, 500));
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalled();
      });

      // 復元は送信時点のキー(first thread)へのみ行われ、現在表示中の
      // second thread の入力欄は汚染されない。
      await waitFor(() => {
        expect(screen.getByLabelText('メッセージ')).toHaveValue('');
      });

      await selectThreadFromDrawer(container, user, 'first thread');
      await waitFor(() => {
        expect(screen.getByLabelText('メッセージ')).toHaveValue('message for the first thread');
      });
    });

    it('keeps the seed record after restoring an unedited prefill, so a later prefill still replaces it (SF1 regression)', async () => {
      // bdboard-otf Opus レビュー SF1: 復元時に draftSeedTextRef.current[convKey] を
      // delete すると、未編集のプリフィルを送って失敗→復元したあと、次のチケット
      // 起動(startNewDraftThread の SF1 判定)が「シード記録が無い = 編集済み」と
      // 誤判定し、新しいプリフィルが無言で捨てられて古い文言が居座る。delete
      // しなければ(記録を維持すれば)、復元文言はまさにシード文言そのものなので
      // 「未編集」と正しく判定され、次のプリフィルへ置き換わる。
      const user = userEvent.setup();
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === '/api/chat/message' && init?.method === 'POST') {
          return jsonResponse({ error: 'boom' }, 500);
        }
        throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
      });

      const firstPrefill = '最初のチケットについて: ';
      const rendered = renderChatPanel([PROJECT_A], {
        initialProjectId: 'proj-a',
        initialInput: firstPrefill,
        ticketContextToken: 1,
      });

      await waitFor(() => {
        expect(screen.getByLabelText('メッセージ')).toHaveValue(firstPrefill);
      });

      // 未編集のままプリフィルを送信 → 失敗 → 復元(まさに SF1 が守る「未編集
      // シードの復元」ケース)。
      await user.click(screen.getByRole('button', { name: '送信' }));
      await screen.findByText('boom');
      await waitFor(() => {
        expect(screen.getByLabelText('メッセージ')).toHaveValue(firstPrefill);
      });

      // 別チケットを開く(2回目のトークン) → 復元後もシード記録が保たれていれば
      // 「未編集」と判定され、新しいプリフィルへ正しく置き換わる。delete して
      // いた場合はここで firstPrefill が居座り、このアサーションが fail する。
      const secondPrefill = '次のチケットについて: ';
      rendered.rerender(
        <ChatPanel
          projects={[PROJECT_A]}
          initialProjectId="proj-a"
          initialInput={secondPrefill}
          ticketContextToken={2}
          isTicketOnBoard={rendered.isTicketOnBoard}
          onOpenTicket={rendered.onOpenTicket}
          onClose={rendered.onClose}
        />,
      );

      await waitFor(() => {
        expect(screen.getByLabelText('メッセージ')).toHaveValue(secondPrefill);
      });
    });

    it('shows only one user message in the transcript after failure and retry (bdboard-sp2)', async () => {
      const user = userEvent.setup();
      const messageText = 'retry after failure';
      let postCount = 0;
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === '/api/chat/message' && init?.method === 'POST') {
          postCount += 1;
          if (postCount === 1) {
            return jsonResponse({ error: 'boom' }, 500);
          }
          return jsonResponse({
            reply: 'success reply',
            sessionId: 'sess-retry',
            agentId: 'claude',
          });
        }
        throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
      });

      renderChatPanel([PROJECT_A]);
      const input = screen.getByLabelText('メッセージ');
      await user.type(input, messageText);
      await user.click(screen.getByRole('button', { name: '送信' }));

      await screen.findByText('boom');
      const messages = screen.getByRole('log');
      const userMessagesAfterFailure = [...messages.querySelectorAll('.chat-message-user')].filter(
        (element) => element.textContent === messageText,
      );
      expect(userMessagesAfterFailure).toHaveLength(0);
      expect(screen.getByLabelText('メッセージ')).toHaveValue(messageText);

      await user.click(screen.getByRole('button', { name: '送信' }));
      await screen.findByText('success reply');

      const userMessagesAfterRetry = [...messages.querySelectorAll('.chat-message-user')].filter(
        (element) => element.textContent === messageText,
      );
      expect(userMessagesAfterRetry).toHaveLength(1);
      expect(getChatMessagePostCalls(fetchMock)).toHaveLength(2);
    });

    it('removes the optimistic user message from the transcript after a streaming send failure (bdboard-sp2)', async () => {
      const user = userEvent.setup();
      const messageText = 'failed stream rollback';
      fetchChatAgentsMock.mockResolvedValue([STREAMING_AGENT]);
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === '/api/chat/message/stream' && init?.method === 'POST') {
          return new Response(
            new TextEncoder().encode(
              'event: error\ndata: {"error":"stream boom","code":"agent-error"}\n\n',
            ),
          );
        }
        throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
      });

      renderChatPanel([PROJECT_A]);
      await screen.findByLabelText('チャットエージェント');
      const input = screen.getByLabelText('メッセージ');
      await user.type(input, messageText);
      await user.click(screen.getByRole('button', { name: '送信' }));

      await screen.findByText('stream boom');
      const messages = screen.getByRole('log');
      const userMessagesAfterFailure = [...messages.querySelectorAll('.chat-message-user')].filter(
        (element) => element.textContent === messageText,
      );
      expect(userMessagesAfterFailure).toHaveLength(0);
    });
  });
});
