// bdboard-sso1.83 第5段: ChatPanel.test.tsx から move-only で切り出したファイル
// (ChatPanel.panel-chrome.test.tsx)。手本: sso1.85 の HygienePanel 分割。テスト本体・期待値・文言は
// 1文字も変えていない。共有の fixture/render ヘルパーは ChatPanel-test-support.tsx
// から import する。vi.mock はファイル単位でホイストされるため、元ファイルの
// vi.mock('../api', ...) ブロックと beforeEach/afterEach をこのファイルにも複製している。

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatAgentDto, ChatThreadDto, ChatTurnStatusDto } from '../api';
import { expectNoA11yViolations } from '../test/axe';
import { installFakeHistory } from '../test/fakeHistory';
import { writePersistedChatThreadState } from '../chatThreadStorage';
import { resetBoardTimeZoneForTests, setBoardTimeZoneOverride } from '../boardTimeZone';
import { ChatPanel, formatThreadUpdatedAt } from './ChatPanel';

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
  fetchDiscoveredChatSessions,
  fetchPlatformSupport,
} from '../api';
import { resetPlatformSupportCache } from './PlatformLimitationNotice';

const fetchChatAgentsMock = vi.mocked(fetchChatAgents);
const fetchChatThreadsMock = vi.mocked(fetchChatThreads);
const fetchChatTurnStatusMock = vi.mocked(fetchChatTurnStatus);
const acknowledgeChatTurnMock = vi.mocked(acknowledgeChatTurn);
const deleteChatThreadMock = vi.mocked(deleteChatThread);
const updateChatThreadMock = vi.mocked(updateChatThread);
const fetchDiscoveredChatSessionsMock = vi.mocked(fetchDiscoveredChatSessions);
const fetchPlatformSupportMock = vi.mocked(fetchPlatformSupport);
const defaultWindowInnerWidth = window.innerWidth;

import {
  PROJECT_A,
  PROJECT_B,
  CLAUDE_AGENT,
  createDeferred,
  jsonResponse,
  getChatMessagePostCalls,
  openThreadDrawer,
  getThreadDrawer,
  openThreadDrawerItemMenu,
  renderChatPanel,
} from './ChatPanel-test-support';

describe('formatThreadUpdatedAt', () => {
  afterEach(() => {
    resetBoardTimeZoneForTests();
  });

  it('uses board timezone override rather than host timezone at day boundaries', () => {
    const iso = '2026-08-09T23:00:00.000Z';

    setBoardTimeZoneOverride('UTC');
    expect(formatThreadUpdatedAt(iso)).toBe('8/9');

    setBoardTimeZoneOverride('Asia/Tokyo');
    expect(formatThreadUpdatedAt(iso)).toBe('8/10');
  });

  it('returns empty string for invalid iso timestamps', () => {
    expect(formatThreadUpdatedAt('not-a-date')).toBe('');
  });
});

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

  it('prefills the input with initialInput', () => {
    renderChatPanel([PROJECT_A], { initialInput: 'bdboard-abc.1 について: ' });

    expect(screen.getByLabelText('メッセージ')).toHaveValue(
      'bdboard-abc.1 について: ',
    );
  });

  it('has no a11y violations in the default loaded state', async () => {
    fetchChatAgentsMock.mockResolvedValue([CLAUDE_AGENT]);
    const { container } = renderChatPanel([PROJECT_A], {
      initialProjectId: 'proj-a',
    });

    await screen.findByLabelText('メッセージ');
    await expectNoA11yViolations(container);
  });

  it('resizes the desktop chat panel within bounds and remembers the width', () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1000,
    });
    const first = renderChatPanel([PROJECT_A]);
    const panel = first.container.querySelector('.detail-panel.chat-panel');
    const handle = screen.getByRole('separator', { name: 'チャットパネルの幅を変更' });

    expect(panel).toHaveStyle({ width: '480px' });

    // pointerdown はカーソル位置から幅を再計算しない(bdboard-p2ew): ハンドルと
    // カーソル位置がずれていても、ドラッグ開始直後に幅が瞬間的に跳ばない。
    fireEvent(handle, new MouseEvent('pointerdown', { bubbles: true, clientX: 0 }));
    expect(panel).toHaveStyle({ width: '480px' });
    // pointerdown からの移動量(差分)で幅を更新する。ここでは開始位置から
    // 900px 移動しており、480 - 900 は MIN_WIDTH でクランプされて 360 になる。
    fireEvent(handle, new MouseEvent('pointermove', { bubbles: true, clientX: 900 }));
    expect(panel).toHaveStyle({ width: '360px' });
    // ドラッグ中の localStorage 書き込みはまだ発生しない。確定は pointerup 時のみ。
    expect(localStorage.getItem('bdboard.ui.chatPanelWidth')).toBeNull();
    fireEvent(handle, new MouseEvent('pointerup', { bubbles: true }));
    expect(localStorage.getItem('bdboard.ui.chatPanelWidth')).toBe('360');

    first.unmount();
    const second = renderChatPanel([PROJECT_A]);
    expect(second.container.querySelector('.detail-panel.chat-panel')).toHaveStyle({
      width: '360px',
    });
  });

  it('maximizes the chat panel to full width and restores the previous width (bdboard-3tw.153)', async () => {
    // ドラッグリサイズは MAX_WIDTH (720px) で頭打ちになる。最大化はその上限を
    // 意図的に越える表示モードで、解除したら直前の幅へ戻ること。
    const user = userEvent.setup();
    // 上限 720px が視野幅由来のクランプ (innerWidth - 320) より小さくなる幅に
    // 固定しておく。ここを既定の 1024 のままにすると 704px で頭打ちになり、
    // 「MAX_WIDTH を越える」という本題がぼやける。
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
    const first = renderChatPanel([PROJECT_A]);
    const panel = first.container.querySelector('.detail-panel.chat-panel');
    const handle = screen.getByRole('separator', { name: 'チャットパネルの幅を変更' });

    fireEvent.keyDown(handle, { key: 'End' });
    expect(panel).toHaveStyle({ width: '720px' });
    expect(localStorage.getItem('bdboard.ui.chatPanelWidth')).toBe('720');

    const maximize = screen.getByRole('button', { name: '最大化' });
    // 見出しの操作は .detail-header-actions にまとめる (レビュー major-2)。
    expect(maximize.parentElement?.className).toContain('detail-header-actions');
    // aria-pressed は付けない (レビュー minor-3)。状態はラベルが伝える。
    expect(maximize).not.toHaveAttribute('aria-pressed');
    await user.click(maximize);

    expect(panel).toHaveStyle({ width: '100%' });
    expect(panel?.className).toContain('is-maximized');
    expect(screen.queryByRole('separator', { name: 'チャットパネルの幅を変更' })).not.toBeInTheDocument();
    // 100% は一時的な表示状態であり、通常幅の保存値を書き換えない。
    expect(localStorage.getItem('bdboard.ui.chatPanelWidth')).toBe('720');
    const shrink = screen.getByRole('button', { name: '縮小' });
    expect(shrink).not.toHaveAttribute('aria-pressed');

    await user.click(shrink);
    // 幅は最大化中も保持されているので、直前の 720px に戻る。
    expect(panel).toHaveStyle({ width: '720px' });
    expect(panel?.className).not.toContain('is-maximized');
    expect(screen.getByRole('button', { name: '最大化' })).toBeInTheDocument();
    expect(screen.getByRole('separator', { name: 'チャットパネルの幅を変更' })).toBeInTheDocument();

    // 最大化はこの表示中だけの状態。次回開いたときも、保存済みの通常幅でリサイズできる。
    first.unmount();
    const second = renderChatPanel([PROJECT_A]);
    expect(second.container.querySelector('.detail-panel.chat-panel')).toHaveStyle({ width: '720px' });
    expect(screen.getByRole('button', { name: '最大化' })).toBeInTheDocument();
    expect(screen.getByRole('separator', { name: 'チャットパネルの幅を変更' })).toBeInTheDocument();
  });

  it('supports keyboard resizing on desktop', () => {
    const { container } = renderChatPanel([PROJECT_A]);
    const panel = container.querySelector('.detail-panel.chat-panel');
    const handle = screen.getByRole('separator', { name: 'チャットパネルの幅を変更' });

    fireEvent.keyDown(handle, { key: 'ArrowLeft' });

    expect(panel).toHaveStyle({ width: '500px' });
  });

  it('opens the CLI session discovery panel', async () => {
    const user = userEvent.setup();
    fetchDiscoveredChatSessionsMock.mockResolvedValue({ sessions: [] });
    const { container } = renderChatPanel([PROJECT_A]);

    openThreadDrawer(container);
    const drawer = getThreadDrawer(container);
    await user.click(within(drawer).getByRole('button', { name: 'CLIセッションを再開' }));
    expect(await screen.findByText('再開できるCLIセッションはありません。')).toBeInTheDocument();
    expect(fetchDiscoveredChatSessionsMock).toHaveBeenCalledWith('proj-a');
  });

  it('focuses the drawer close button when the thread drawer opens', async () => {
    fetchChatThreadsMock.mockResolvedValue([
      {
        sessionId: 'sess-first',
        agentId: 'claude',
        title: 'first thread',
        pinned: false,
        updatedAt: '2026-01-02T00:00:00Z',
      },
    ]);

    const { container } = renderChatPanel([PROJECT_A]);
    openThreadDrawer(container);
    const drawer = getThreadDrawer(container);
    await within(drawer).findByRole('button', { name: 'first thread' });

    expect(within(drawer).getByRole('button', { name: '閉じる' })).toHaveFocus();
  });

  it('traps Tab focus inside the thread drawer', async () => {
    fetchChatThreadsMock.mockResolvedValue([
      {
        sessionId: 'sess-first',
        agentId: 'claude',
        title: 'first thread',
        pinned: false,
        updatedAt: '2026-01-02T00:00:00Z',
      },
      {
        sessionId: 'sess-second',
        agentId: 'claude',
        title: 'second thread',
        pinned: false,
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ]);

    const { container } = renderChatPanel([PROJECT_A]);
    openThreadDrawer(container);
    const drawer = getThreadDrawer(container);
    await within(drawer).findByRole('button', { name: 'second thread' });

    const lastFocusable = within(drawer).getByRole('button', { name: 'CLIセッションを再開' });
    lastFocusable.focus();
    fireEvent.keyDown(lastFocusable, { key: 'Tab' });

    expect(within(drawer).getByRole('button', { name: '閉じる' })).toHaveFocus();
    expect(screen.getByLabelText('メッセージ')).not.toHaveFocus();
  });

  it('closes the thread drawer on Escape without closing the chat panel', async () => {
    fetchChatThreadsMock.mockResolvedValue([
      {
        sessionId: 'sess-first',
        agentId: 'claude',
        title: 'first thread',
        pinned: false,
        updatedAt: '2026-01-02T00:00:00Z',
      },
    ]);

    const { container, onClose } = renderChatPanel([PROJECT_A]);
    openThreadDrawer(container);
    const drawer = getThreadDrawer(container);
    await within(drawer).findByRole('button', { name: 'first thread' });

    const closeButton = within(drawer).getByRole('button', { name: '閉じる' });
    expect(closeButton).toHaveFocus();
    fireEvent.keyDown(closeButton, { key: 'Escape' });

    expect(container.querySelector('#chat-thread-drawer')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  describe('quick commands', () => {
    it('renders quick command chips above the message input', () => {
      renderChatPanel([PROJECT_A], { leaveSettingsCollapsed: true });
      expect(screen.getByRole('group', { name: 'クイックコマンド' })).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'ready一覧を入力欄に挿入' }),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'チケット相談を入力欄に挿入' })).toBeInTheDocument();
    });

    it('prefills the input (without sending) when a quick command chip is tapped', async () => {
      const user = userEvent.setup();
      renderChatPanel([PROJECT_A], { leaveSettingsCollapsed: true });
      await user.click(screen.getByRole('button', { name: 'ready一覧を入力欄に挿入' }));

      const textarea = screen.getByLabelText<HTMLTextAreaElement>('メッセージ');
      const expected = '着手可能(ready)なチケットを一覧し、優先度が高い順に要約してください。';
      expect(textarea).toHaveValue(expected);
      await waitFor(() => {
        expect(textarea.selectionStart).toBe(expected.length);
        expect(textarea.selectionEnd).toBe(expected.length);
      });
      // 誤タップでそのまま送信されないことを確認する(bdboard-3tw.133)。
      expect(getChatMessagePostCalls(fetchMock)).toHaveLength(0);
    });

    it('prefills the input when the free-text quick command chip is tapped', async () => {
      const user = userEvent.setup();
      renderChatPanel([PROJECT_A], { leaveSettingsCollapsed: true });
      await user.click(screen.getByRole('button', { name: 'チケット相談を入力欄に挿入' }));

      const textarea = screen.getByLabelText<HTMLTextAreaElement>('メッセージ');
      expect(textarea).toHaveValue('次のチケットについて: ');
      await waitFor(() => {
        expect(textarea.selectionStart).toBe('次のチケットについて: '.length);
        expect(textarea.selectionEnd).toBe('次のチケットについて: '.length);
      });
      expect(getChatMessagePostCalls(fetchMock)).toHaveLength(0);
    });

    it('disables quick command chips while sending', async () => {
      const user = userEvent.setup();
      const deferred = createDeferred<Response>();
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === '/api/chat/message' && init?.method === 'POST') {
          return deferred.promise;
        }
        throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
      });

      renderChatPanel([PROJECT_A], { leaveSettingsCollapsed: true });
      await user.type(screen.getByLabelText('メッセージ'), 'hold');
      await user.click(screen.getByRole('button', { name: '送信' }));

      expect(
        screen.getByRole('button', { name: 'ready一覧を入力欄に挿入' }),
      ).toBeDisabled();
    });
  });
  describe('platform limitations (bdboard-70z.9)', () => {
    const WIN32_CHAT = {
      platform: 'win32',
      limitations: [
        {
          feature: 'chat' as const,
          reason: 'AI チャットは Windows では利用できません。',
          detail: 'エージェント CLI が .cmd シムのため shell 無しでは起動できない。',
        },
      ],
    };

    it('disables the composer and explains why on an unsupported platform', async () => {
      fetchPlatformSupportMock.mockResolvedValue(WIN32_CHAT);
      renderChatPanel([PROJECT_A, PROJECT_B], { initialProjectId: PROJECT_A.id });

      expect(
        await screen.findByText('AI チャットは Windows では利用できません。'),
      ).toBeInTheDocument();
      // 案内を出したうえで送信でき、送って初めて 501 に気付く、では
      // 「UI 上で無効化」になっていない (PR#115 fable レビュー minor)。
      await waitFor(() => {
        expect(screen.getByLabelText('メッセージ')).toBeDisabled();
      });
      expect(screen.getByRole('button', { name: '送信' })).toBeDisabled();
    });

    it('leaves the composer usable on a supported platform', async () => {
      renderChatPanel([PROJECT_A, PROJECT_B], { initialProjectId: PROJECT_A.id });

      await waitFor(() => {
        expect(fetchPlatformSupportMock).toHaveBeenCalled();
      });
      expect(
        screen.queryByText('AI チャットは Windows では利用できません。'),
      ).not.toBeInTheDocument();
      expect(screen.getByLabelText('メッセージ')).toBeEnabled();
    });
  });

  describe('thread list ordering (bdboard-3tw.154)', () => {
    // 「開いているスレッド」の並びは openThreadIds の挿入順で、これは
    // localStorage に永続化されている。前回のセッションで古い順に開いていれば、
    // 一覧もその古い順のまま出てくる — それがこのチケットの症状。
    // ここでは永続化状態を先に仕込んで、その経路を再現する。
    function drawerSectionTitles(container: HTMLElement, sectionTitle: string): string[] {
      const drawer = getThreadDrawer(container);
      const heading = within(drawer)
        .getByText(sectionTitle)
        .closest('.chat-thread-drawer-section');
      if (!(heading instanceof HTMLElement)) {
        throw new Error(`section not found: ${sectionTitle}`);
      }
      return [...heading.querySelectorAll('.chat-thread-drawer-item')].map((item) => {
        const title = item.querySelector('.chat-thread-drawer-item-title');
        return (title ?? item).textContent ?? '';
      });
    }

    const threads: ChatThreadDto[] = [
      { sessionId: 'sess-new', agentId: 'claude', title: 'newest thread', pinned: false, updatedAt: '2026-01-03T00:00:00Z' },
      { sessionId: 'sess-mid', agentId: 'claude', title: 'middle thread', pinned: false, updatedAt: '2026-01-02T00:00:00Z' },
      { sessionId: 'sess-old', agentId: 'claude', title: 'oldest thread', pinned: false, updatedAt: '2026-01-01T00:00:00Z' },
    ];

    function mockThreadMessages() {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/api/chat/sessions/')) {
          return jsonResponse({ sessionId: 'sess-new', agentId: 'claude', messages: [] });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });
    }

    it('lists open threads newest first even when they were opened oldest first', async () => {
      fetchChatThreadsMock.mockResolvedValue(threads);
      mockThreadMessages();
      // 前回のセッションで古い順に開いた状態。
      writePersistedChatThreadState('proj-a', {
        activeSessionIds: ['sess-old', 'sess-mid', 'sess-new'],
        selectedSessionId: 'sess-old',
      });

      const { container } = renderChatPanel([PROJECT_A]);
      openThreadDrawer(container);
      await within(getThreadDrawer(container)).findByText('newest thread');

      expect(drawerSectionTitles(container, '開いているスレッド')).toEqual([
        'newest thread',
        'middle thread',
        'oldest thread',
      ]);
    });

    it('falls back to the newest remaining displayed thread when closing the selected one (bdboard-3tw.157)', async () => {
      // 3tw.154 で表示順を挿入順(古い順)→新しい順に変えたことで、選択中スレッドを
      // 閉じたときのフォールバック(旧実装: openThreadIds の挿入順の先頭 = 最古)が
      // 表示との整合を失っていた。挿入順で古い順に開いた3スレッドのうち表示先頭
      // (= 最新)を閉じたら、次に新しい表示中スレッドへ選択が移ることを確認する
      // (挿入順の先頭である最古スレッドへは飛ばない)。
      const user = userEvent.setup();
      fetchChatThreadsMock.mockResolvedValue(threads);
      mockThreadMessages();
      writePersistedChatThreadState('proj-a', {
        activeSessionIds: ['sess-old', 'sess-mid', 'sess-new'],
        selectedSessionId: 'sess-new',
      });

      const { container } = renderChatPanel([PROJECT_A]);
      openThreadDrawer(container);
      await within(getThreadDrawer(container)).findByText('newest thread');

      const menu = await openThreadDrawerItemMenu(container, user, 'newest thread');
      await user.click(within(menu).getByRole('menuitem', { name: /タブから閉じる/ }));

      openThreadDrawer(container);
      expect(
        within(getThreadDrawer(container)).getByRole('button', { name: 'middle thread' }),
      ).toHaveAttribute('aria-current', 'true');
      expect(
        within(getThreadDrawer(container)).getByRole('button', { name: 'oldest thread' }),
      ).not.toHaveAttribute('aria-current');
    });

    it('lists closed threads newest first regardless of the order they arrive in', async () => {
      // サーバーは更新の新しい順で返す契約だが、送信直後にローカルで末尾へ
      // 差し込む経路があるので、表示側は受け取り順に依存してはいけない。
      fetchChatThreadsMock.mockResolvedValue([threads[2], threads[0], threads[1]]);
      mockThreadMessages();
      writePersistedChatThreadState('proj-a', {
        activeSessionIds: ['sess-mid'],
        selectedSessionId: 'sess-mid',
      });

      const { container } = renderChatPanel([PROJECT_A]);
      openThreadDrawer(container);
      await within(getThreadDrawer(container)).findByText('newest thread');

      expect(drawerSectionTitles(container, '閉じたスレッド')).toEqual([
        'newest thread',
        'oldest thread',
      ]);
    });

    it('keeps pinned threads at the top even when they are the oldest', async () => {
      fetchChatThreadsMock.mockResolvedValue([
        threads[0],
        threads[1],
        { ...threads[2], pinned: true },
      ]);
      mockThreadMessages();
      writePersistedChatThreadState('proj-a', {
        activeSessionIds: ['sess-old', 'sess-mid', 'sess-new'],
        selectedSessionId: 'sess-old',
      });

      const { container } = renderChatPanel([PROJECT_A]);
      openThreadDrawer(container);
      await within(getThreadDrawer(container)).findByText('newest thread');

      expect(drawerSectionTitles(container, 'ピン留め')).toEqual(['oldest thread']);
      expect(drawerSectionTitles(container, '開いているスレッド')).toEqual([
        'newest thread',
        'middle thread',
      ]);
    });

    it('pushes a thread with an unreadable timestamp to the bottom instead of scrambling the order', async () => {
      // updatedAt が読めないスレッドを NaN のまま比較へ流すと、比較関数が
      // 「a<b でも b<a でもない」を返して並びが入力順に依存する。読めないものは
      // 0 (= 最古) に倒して、残りの並びは壊さない。
      fetchChatThreadsMock.mockResolvedValue([
        { sessionId: 'sess-broken', agentId: 'claude', title: 'broken thread', pinned: false, updatedAt: 'not-a-date' },
        threads[0],
        threads[2],
      ]);
      mockThreadMessages();
      writePersistedChatThreadState('proj-a', {
        activeSessionIds: ['sess-broken', 'sess-new', 'sess-old'],
        selectedSessionId: 'sess-broken',
      });

      const { container } = renderChatPanel([PROJECT_A]);
      openThreadDrawer(container);
      await within(getThreadDrawer(container)).findByText('newest thread');

      expect(drawerSectionTitles(container, '開いているスレッド')).toEqual([
        'newest thread',
        'oldest thread',
        'broken thread',
      ]);
    });

    it('puts a thread whose record has not arrived yet at the bottom (PR#133 レビュー minor-2)', async () => {
      // CLIセッションを再開した直後は、openThreadIds に sessionId が入っている
      // のにスレッド一覧の再取得がまだ返ってきていない窓がある。この窓では
      // threadById に記録が無く、更新日時が読めない。最新扱いにすると、まだ
      // 何も分かっていないスレッドが先頭に居座る。
      const user = userEvent.setup();
      fetchChatAgentsMock.mockResolvedValue([CLAUDE_AGENT]);
      fetchChatThreadsMock.mockReset();
      fetchChatThreadsMock
        .mockResolvedValueOnce([threads[0], threads[2]])
        // 再開後の再取得は返さない = 記録が届いていない窓を開けたままにする。
        .mockImplementation(() => new Promise(() => {}));
      fetchDiscoveredChatSessionsMock.mockResolvedValue({
        sessions: [
          { sessionId: 'discovered-1', lastActivityAt: '2026-08-16T12:00:00.000Z', alreadyAdopted: false },
        ],
      });
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (
          url === '/api/chat/projects/proj-a/discovered-sessions/discovered-1/adopt' &&
          init?.method === 'POST'
        ) {
          return jsonResponse({
            sessionId: 'discovered-1',
            agentId: 'claude',
            seedMessages: [
              { role: 'user', text: 'seeded question', timestamp: '2026-08-16T11:00:00.000Z' },
            ],
          });
        }
        if (url.includes('/api/chat/sessions/')) {
          return jsonResponse({ sessionId: 'sess-new', agentId: 'claude', messages: [] });
        }
        throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
      });
      writePersistedChatThreadState('proj-a', {
        activeSessionIds: ['sess-new', 'sess-old'],
        selectedSessionId: 'sess-new',
      });

      const { container } = renderChatPanel([PROJECT_A]);
      openThreadDrawer(container);
      await within(getThreadDrawer(container)).findByText('newest thread');
      await user.click(
        within(getThreadDrawer(container)).getByRole('button', { name: 'CLIセッションを再開' }),
      );
      await user.click(await screen.findByRole('button', { name: 'セッション discovered-1 を再開' }));
      await screen.findByText('seeded question');

      openThreadDrawer(container);
      expect(drawerSectionTitles(container, '開いているスレッド')).toEqual([
        'newest thread',
        'oldest thread',
        '(無題)',
      ]);
    });
  });

  describe('T10: API call-order fingerprint (bdboard-sso1.83 特性テスト, §4 4b-4)', () => {
    // T10: マウント時・プロジェクト切替時・abort 後の3パターンで、
    // fetchChatThreads → fetchChatTurnStatus → fetchChatAgents →
    // sessions/messages という API 呼び出し順を固定する。後続段
    // (第9〜14段)がこの並びに依存する effect の登録順を変えていないことを
    // 検出するための「指紋」であり、この並び自体が「正しい」という主張では
    // ない(現状のまま固定するのが目的)。
    function makeCallOrderRecorder() {
      const callOrder: string[] = [];
      return {
        callOrder,
        record: (tag: string) => callOrder.push(tag),
      };
    }

    it('fingerprints the call order on mount', async () => {
      const { callOrder, record } = makeCallOrderRecorder();
      fetchChatThreadsMock.mockImplementation((_projectId: string) => {
        record('threads');
        return Promise.resolve([
          { sessionId: 'sess-1', agentId: 'claude', title: 'first thread', pinned: false, updatedAt: '2026-01-01T00:00:00Z' },
        ]);
      });
      fetchChatTurnStatusMock.mockImplementation(() => {
        record('turn-status');
        return Promise.resolve({ state: 'idle' });
      });
      fetchChatAgentsMock.mockImplementation(() => {
        record('agents');
        return Promise.resolve([CLAUDE_AGENT]);
      });
      const fetchMock = vi.fn(async (url: string) => {
        if (url.includes('/api/chat/sessions/sess-1/messages')) {
          record('messages');
          return jsonResponse({ sessionId: 'sess-1', agentId: 'claude', messages: [] });
        }
        throw new Error(`Unexpected fetch: GET ${url}`);
      });
      vi.stubGlobal('fetch', fetchMock);

      renderChatPanel([PROJECT_A]);

      await waitFor(() => {
        expect(callOrder).toEqual(['threads', 'turn-status', 'agents', 'messages']);
      });
    });

    it('fingerprints the call order when switching projects (not streaming)', async () => {
      const { callOrder, record } = makeCallOrderRecorder();
      fetchChatThreadsMock.mockImplementation((projectId: string) => {
        record(`threads:${projectId}`);
        return Promise.resolve([
          { sessionId: `sess-${projectId}`, agentId: 'claude', title: `${projectId} thread`, pinned: false, updatedAt: '2026-01-01T00:00:00Z' },
        ]);
      });
      fetchChatTurnStatusMock.mockImplementation((projectId: string) => {
        record(`turn-status:${projectId}`);
        return Promise.resolve({ state: 'idle' });
      });
      fetchChatAgentsMock.mockImplementation(() => {
        record('agents');
        return Promise.resolve([CLAUDE_AGENT]);
      });
      const fetchMock = vi.fn(async (url: string) => {
        const match = /\/api\/chat\/sessions\/sess-(proj-[ab])\/messages/.exec(url);
        if (match) {
          record(`messages:${match[1]}`);
          return jsonResponse({ sessionId: `sess-${match[1]}`, agentId: 'claude', messages: [] });
        }
        throw new Error(`Unexpected fetch: GET ${url}`);
      });
      vi.stubGlobal('fetch', fetchMock);

      const user = userEvent.setup();
      renderChatPanel([PROJECT_A, PROJECT_B], { initialProjectId: 'proj-a' });
      await waitFor(() => {
        expect(callOrder).toEqual([
          'threads:proj-a',
          'turn-status:proj-a',
          'agents',
          'messages:proj-a',
        ]);
      });

      callOrder.length = 0;
      await user.selectOptions(screen.getByLabelText('対象プロジェクト'), 'proj-b');

      await waitFor(() => {
        expect(callOrder).toEqual([
          'threads:proj-b',
          'turn-status:proj-b',
          'messages:proj-b',
        ]);
      });
    });

    it('fingerprints the call order after an abort-driven project switch while streaming', async () => {
      const { callOrder, record } = makeCallOrderRecorder();
      fetchChatThreadsMock.mockImplementation((projectId: string) => {
        record(`threads:${projectId}`);
        return Promise.resolve([]);
      });
      fetchChatTurnStatusMock.mockImplementation((projectId: string) => {
        record(`turn-status:${projectId}`);
        return Promise.resolve({ state: 'idle' });
      });
      fetchChatAgentsMock.mockResolvedValue([
        { ...CLAUDE_AGENT, supportsStreaming: true },
      ]);
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/chat/message/stream' && init?.method === 'POST') {
          record('stream:post');
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
      vi.stubGlobal('fetch', fetchMock);

      const user = userEvent.setup();
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

      callOrder.length = 0;
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

      // abort 後、E8(turn-status 回収)は generation bump によって B 向けに
      // 2回目の fetchChatTurnStatus 呼び出しを行う(1回目は選択直後の通常の
      // effect 実行、2回目は abort の catch(AbortError) 経路が非同期で
      // turnRecoveryGeneration を bump したことによる再実行)。B にはまだ
      // スレッドが無い(fetchChatThreadsMock は空配列)ため
      // fetchChatSessionMessages は呼ばれない。
      await waitFor(
        () => {
          expect(callOrder).toEqual(['threads:proj-b', 'turn-status:proj-b', 'turn-status:proj-b']);
        },
        { timeout: 3_000 },
      );
    });
  });
});
