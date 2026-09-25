// bdboard-sso1.83 第5段: ChatPanel.test.tsx から move-only で切り出したファイル
// (ChatPanel.agent-model-selection.test.tsx)。手本: sso1.85 の HygienePanel 分割。テスト本体・期待値・文言は
// 1文字も変えていない。共有の fixture/render ヘルパーは ChatPanel-test-support.tsx
// から import する。vi.mock はファイル単位でホイストされるため、元ファイルの
// vi.mock('../api', ...) ブロックと beforeEach/afterEach をこのファイルにも複製している。

import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatAgentDto, ChatThreadDto, ChatTurnStatusDto } from '../api';
import { installFakeHistory } from '../test/fakeHistory';
import { writePersistedChatThread } from '../chatThreadStorage';
import {
  CHAT_AGENT_AUTH_FAILURE_HELP,
  CHAT_AGENT_UNAVAILABLE_WARNING,
} from '../writeAccessMessage';
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
  EXAMPLE_AGENT,
  READS_PROJECT_AGENT,
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

  it('selects the sole claude agent by default when only one option exists', async () => {
    fetchChatAgentsMock.mockResolvedValue([CLAUDE_AGENT]);

    renderChatPanel([PROJECT_A]);

    const select = await screen.findByLabelText('チャットエージェント');
    const options = select.querySelectorAll('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveValue('claude');
    expect(select).toHaveValue('claude');
  });

  it('clears sessionId when switching agents and sends a fresh conversation', async () => {
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([CLAUDE_AGENT, EXAMPLE_AGENT]);
    let postCount = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/chat/message' && init?.method === 'POST') {
        postCount += 1;
        const body = JSON.parse(init.body as string) as {
          projectId: string;
          message: string;
          sessionId?: string;
          agentId?: string;
        };
        if (postCount === 1) {
          expect(body.sessionId).toBeUndefined();
          expect(body.agentId).toBe('claude');
          return jsonResponse({
            reply: 'reply one',
            sessionId: 'sess-1',
            agentId: 'claude',
          });
        }
        if (postCount === 2) {
          expect(body.sessionId).toBe('sess-1');
          expect(body.agentId).toBe('claude');
          return jsonResponse({
            reply: 'reply two',
            sessionId: 'sess-1',
            agentId: 'claude',
          });
        }
        expect(body.sessionId).toBeUndefined();
        expect(body.agentId).toBe('example-agent');
        return jsonResponse({
          reply: 'reply three',
          sessionId: 'sess-2',
          agentId: 'example-agent',
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A]);
    await screen.findByLabelText('チャットエージェント');

    await user.type(screen.getByLabelText('メッセージ'), 'message one');
    await user.click(screen.getByRole('button', { name: '送信' }));
    await screen.findByText('reply one');

    await user.type(screen.getByLabelText('メッセージ'), 'message two');
    await user.click(screen.getByRole('button', { name: '送信' }));
    await screen.findByText('reply two');

    await user.selectOptions(
      screen.getByLabelText('チャットエージェント'),
      'example-agent',
    );

    await user.type(screen.getByLabelText('メッセージ'), 'message three');
    await user.click(screen.getByRole('button', { name: '送信' }));
    await screen.findByText('reply three');

    expect(within(screen.getByRole('log')).queryByText('message one')).not.toBeInTheDocument();
    expect(within(screen.getByRole('log')).queryByText('reply one')).not.toBeInTheDocument();
    expect(within(screen.getByRole('log')).queryByText('message two')).not.toBeInTheDocument();
    expect(within(screen.getByRole('log')).queryByText('reply two')).not.toBeInTheDocument();

    await waitFor(() => {
      expect(getChatMessagePostCalls(fetchMock)).toHaveLength(3);
    });
    expect(postCount).toBe(3);
  });

  it('shows capability warning for non-bd-only agents and hides bd-only help text', async () => {
    fetchChatAgentsMock.mockResolvedValue([CLAUDE_AGENT, READS_PROJECT_AGENT]);

    renderChatPanel([PROJECT_A]);
    const agentSelect = await screen.findByLabelText('チャットエージェント');

    expect(
      screen.getByText(/bdチケット操作\(一覧・詳細・claim・状態変更・クローズ・コメント追加\)だけです/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/bd チケット操作以外の権限を持ちます/),
    ).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.selectOptions(agentSelect, 'reads-project-agent');

    expect(
      screen.getByText(
        'このエージェントは bd チケット操作以外の権限を持ちます（reads-project）。',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/bdチケット操作\(一覧・詳細・claim・状態変更・クローズ・コメント追加\)だけです/),
    ).not.toBeInTheDocument();

    await user.selectOptions(agentSelect, 'claude');

    expect(
      screen.getByText(/bdチケット操作\(一覧・詳細・claim・状態変更・クローズ・コメント追加\)だけです/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/bd チケット操作以外の権限を持ちます/),
    ).not.toBeInTheDocument();
  });

  it('shows unavailable warning near the input without opening chat settings (bdboard-nzul)', async () => {
    fetchChatAgentsMock.mockResolvedValue([
      { ...CLAUDE_AGENT, availability: 'unavailable' },
    ]);

    const { container } = renderChatPanel([PROJECT_A], {
      leaveSettingsCollapsed: true,
    });
    const details = container.querySelector('.chat-panel-settings');
    expect(details).toBeInstanceOf(HTMLDetailsElement);
    expect((details as HTMLDetailsElement).open).toBe(false);

    const warning = await screen.findByText(CHAT_AGENT_UNAVAILABLE_WARNING);
    expect(warning).toBeVisible();
    expect(details!.contains(warning)).toBe(false);
    expect(warning).toHaveClass('chat-agent-unavailable-banner');
    expect(warning).toHaveAttribute('role', 'alert');
    expect(screen.getByRole('button', { name: '送信' })).toBeDisabled();
  });

  it('blocks Meta+Enter submit when selected agent is unavailable and adds a conversation error (bdboard-nzul)', async () => {
    fetchChatAgentsMock.mockResolvedValue([
      { ...CLAUDE_AGENT, availability: 'unavailable' },
    ]);

    const user = userEvent.setup();
    renderChatPanel([PROJECT_A]);
    await screen.findByText(CHAT_AGENT_UNAVAILABLE_WARNING);

    const input = screen.getByLabelText('メッセージ');
    await user.type(input, 'blocked keyboard submit');
    await user.keyboard('{Meta>}{Enter}{/Meta}');

    expect(getChatMessagePostCalls(fetchMock)).toEqual([]);

    const messages = screen.getByRole('log');
    const conversationError = messages.querySelector(
      '.chat-message-error .chat-message-text',
    );
    expect(conversationError).not.toBeNull();
    expect(conversationError).toHaveTextContent(CHAT_AGENT_UNAVAILABLE_WARNING);
    expect(conversationError).not.toHaveClass('chat-agent-unavailable-banner');
    expect(conversationError?.closest('.chat-message')).toHaveClass('chat-message-error');
  });

  it('shows unavailable label in chat settings when expanded', async () => {
    fetchChatAgentsMock.mockResolvedValue([
      { ...CLAUDE_AGENT, availability: 'unavailable' },
    ]);

    renderChatPanel([PROJECT_A]);
    const agentSelect = await screen.findByLabelText('チャットエージェント');

    expect(agentSelect).toHaveTextContent('Claude [画像非対応]（利用不可）');
    const warning = await screen.findByText(CHAT_AGENT_UNAVAILABLE_WARNING);
    expect(warning).toHaveAttribute('role', 'alert');
  });

  it('maps agent-exit-nonzero failures to an auth-oriented message (bdboard-nzul)', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/chat/message' && init?.method === 'POST') {
        return jsonResponse(
          {
            error: 'chat failed',
            code: 'agent-exit-nonzero',
            detail:
              'the chat agent exited with an error; the CLI may be missing or not authenticated',
          },
          502,
        );
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A]);
    await user.type(screen.getByLabelText('メッセージ'), 'auth expired test');
    await user.click(screen.getByRole('button', { name: '送信' }));

    expect(await screen.findByText(CHAT_AGENT_AUTH_FAILURE_HELP)).toBeInTheDocument();
    expect(screen.queryByText('chat failed')).not.toBeInTheDocument();
  });

  it('maps chat agent unavailable (503) to an auth-oriented message (bdboard-nzul)', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/chat/message' && init?.method === 'POST') {
        return jsonResponse(
          {
            error: 'chat agent unavailable',
            detail: 'the chat agent CLI could not be started',
          },
          503,
        );
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A]);
    await user.type(screen.getByLabelText('メッセージ'), 'unavailable agent test');
    await user.click(screen.getByRole('button', { name: '送信' }));

    expect(await screen.findByText(CHAT_AGENT_AUTH_FAILURE_HELP)).toBeInTheDocument();
    expect(screen.queryByText('chat agent unavailable')).not.toBeInTheDocument();
  });

  it('shows unknown label but no availability note when auth is unverified', async () => {
    fetchChatAgentsMock.mockResolvedValue([
      { ...CLAUDE_AGENT, availability: 'unknown' },
    ]);

    renderChatPanel([PROJECT_A]);
    const agentSelect = await screen.findByLabelText('チャットエージェント');

    expect(agentSelect).toHaveTextContent('Claude [画像非対応]（認証未確認）');
    expect(
      screen.queryByText(
        'このエージェントの認証状態を確認できませんでした。送信してみるまで使えるか分かりません。',
      ),
    ).not.toBeInTheDocument();
  });

  it('collapses and expands chat settings controls', async () => {
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([CLAUDE_AGENT]);
    const { container } = renderChatPanel([PROJECT_A, PROJECT_B], {
      initialProjectId: PROJECT_A.id,
      leaveSettingsCollapsed: true,
    });

    const details = container.querySelector('.chat-panel-settings');
    expect(details).toBeInstanceOf(HTMLDetailsElement);
    expect((details as HTMLDetailsElement).open).toBe(false);
    expect(screen.getByLabelText('対象プロジェクト')).toBeVisible();
    expect(await screen.findByLabelText('チャットエージェント')).not.toBeVisible();
    expect(screen.getByText(/チャット設定 — Project Alpha/)).toBeInTheDocument();

    await user.click(screen.getByText(/チャット設定 — Project Alpha/));
    expect((details as HTMLDetailsElement).open).toBe(true);
    expect(screen.getByLabelText('チャットエージェント')).toBeInTheDocument();

    await user.click(screen.getByText(/チャット設定 — Project Alpha/));
    expect((details as HTMLDetailsElement).open).toBe(false);
    expect(screen.queryByLabelText('チャットエージェント')).not.toBeVisible();
  });

  it('selects initialProjectId when provided', async () => {
    renderChatPanel([PROJECT_A, PROJECT_B], { initialProjectId: 'proj-b' });

    expect(screen.getByLabelText('対象プロジェクト')).toHaveValue('proj-b');
  });

  it('calls onProjectIdChange when the project select changes', async () => {
    const user = userEvent.setup();
    const onProjectIdChange = vi.fn();
    renderChatPanel([PROJECT_A, PROJECT_B], {
      initialProjectId: 'proj-a',
      onProjectIdChange,
    });

    await waitFor(() => {
      expect(onProjectIdChange).toHaveBeenCalledWith('proj-a');
    });
    onProjectIdChange.mockClear();

    await user.selectOptions(
      screen.getByLabelText('対象プロジェクト'),
      'proj-b',
    );

    expect(onProjectIdChange).toHaveBeenCalledWith('proj-b');
  });

  it('leaves the project unselected when initialProjectId is unknown', async () => {
    renderChatPanel([PROJECT_A, PROJECT_B], {
      initialProjectId: 'missing-project',
    });

    expect(screen.getByLabelText('対象プロジェクト')).toHaveValue('');
    expect(
      screen.getByText('送信先のプロジェクトを選んでください。選ぶまで送信できません。'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '送信' })).toBeDisabled();
  });

  it('shows unselected project state with disabled send when multiple projects and no initialProjectId', async () => {
    const user = userEvent.setup();
    renderChatPanel([PROJECT_A, PROJECT_B], { leaveSettingsCollapsed: true });

    expect(screen.getByLabelText('対象プロジェクト')).toHaveValue('');
    expect(
      screen.getByText('送信先のプロジェクトを選んでください。選ぶまで送信できません。'),
    ).toBeInTheDocument();

    await user.type(screen.getByLabelText('メッセージ'), 'draft while unselected');
    expect(screen.getByRole('button', { name: '送信' })).toBeDisabled();
  });

  it('auto-selects the sole project without showing unselected hint', async () => {
    renderChatPanel([PROJECT_A], { leaveSettingsCollapsed: true });

    expect(screen.queryByLabelText('対象プロジェクト')).not.toBeInTheDocument();
    expect(screen.getByText('Project Alpha')).toBeInTheDocument();
    expect(
      screen.queryByText('送信先のプロジェクトを選んでください。選ぶまで送信できません。'),
    ).not.toBeInTheDocument();
  });

  it('shows empty-projects hint and keeps send disabled when the projects list is empty (major-1 regression)', async () => {
    renderChatPanel([], { leaveSettingsCollapsed: true });

    expect(
      screen.getByText(/プロジェクトを読み込めていません。/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '送信' })).toBeDisabled();
  });

  it('preserves draft text when selecting a project from unselected state', async () => {
    // 補助テスト(回帰ガードではない): fetchChatThreads が既定の [] を返すため、
    // ドラフト保護(nonce bump)が無くても通る。実際の回帰ガードは
    // 'keeps the carried-over draft selected even when the chosen project has
    // existing threads' の方。
    const user = userEvent.setup();
    renderChatPanel([PROJECT_A, PROJECT_B], { leaveSettingsCollapsed: true });

    await user.type(screen.getByLabelText('メッセージ'), 'keep this draft');
    await user.selectOptions(screen.getByLabelText('対象プロジェクト'), 'proj-b');

    await waitFor(() => {
      expect(screen.getByLabelText('対象プロジェクト')).toHaveValue('proj-b');
    });
    expect(screen.getByLabelText('メッセージ')).toHaveValue('keep this draft');
  });

  it('keeps the carried-over draft selected even when the chosen project has existing threads', async () => {
    const user = userEvent.setup();
    fetchChatThreadsMock.mockResolvedValue([
      {
        sessionId: 'sess-existing',
        agentId: 'claude',
        title: '既存スレッド',
        pinned: false,
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ]);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/chat/sessions/sess-existing/messages')) {
        return jsonResponse({
          sessionId: 'sess-existing',
          agentId: 'claude',
          messages: [],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const { container } = renderChatPanel([PROJECT_A, PROJECT_B], { leaveSettingsCollapsed: true });

    await user.type(screen.getByLabelText('メッセージ'), 'keep this draft');
    await user.selectOptions(screen.getByLabelText('対象プロジェクト'), 'proj-b');

    await waitFor(() => {
      expect(fetchChatThreadsMock).toHaveBeenCalledWith('proj-b');
    });
    openThreadDrawer(container);
    await within(getThreadDrawer(container)).findByRole('button', {
      name: '既存スレッド',
    });
    // 既存スレッドの自動選択に負けず、書きかけドラフトが表示されたままであること。
    expect(screen.getByLabelText('メッセージ')).toHaveValue('keep this draft');
  });

  it('keeps typed draft when projects arrive via effect with existing threads (major-2 regression)', async () => {
    const user = userEvent.setup();
    fetchChatThreadsMock.mockResolvedValue([
      {
        sessionId: 'sess-existing',
        agentId: 'claude',
        title: '既存スレッド',
        pinned: false,
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ]);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/chat/sessions/sess-existing/messages')) {
        return jsonResponse({
          sessionId: 'sess-existing',
          agentId: 'claude',
          messages: [],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const rendered = renderChatPanel([], { leaveSettingsCollapsed: true });

    await user.type(screen.getByLabelText('メッセージ'), 'keep this cold draft');

    rendered.rerender(
      <ChatPanel
        projects={[PROJECT_A]}
        isTicketOnBoard={rendered.isTicketOnBoard}
        onOpenTicket={rendered.onOpenTicket}
        onClose={rendered.onClose}
      />,
    );

    openThreadDrawer(rendered.container);
    await within(getThreadDrawer(rendered.container)).findByRole('button', {
      name: '既存スレッド',
    });
    expect(screen.getByLabelText('メッセージ')).toHaveValue('keep this cold draft');
  });

  it('still restores an existing thread when no draft was typed before choosing the project', async () => {
    const user = userEvent.setup();
    fetchChatThreadsMock.mockResolvedValue([
      {
        sessionId: 'sess-existing',
        agentId: 'claude',
        title: '既存スレッド',
        pinned: false,
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ]);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/chat/sessions/sess-existing/messages')) {
        return jsonResponse({
          sessionId: 'sess-existing',
          agentId: 'claude',
          messages: [],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const { container } = renderChatPanel([PROJECT_A, PROJECT_B], { leaveSettingsCollapsed: true });

    await user.selectOptions(screen.getByLabelText('対象プロジェクト'), 'proj-b');

    await waitFor(() => {
      expect(fetchChatThreadsMock).toHaveBeenCalledWith('proj-b');
    });
    openThreadDrawer(container);
    await within(getThreadDrawer(container)).findByRole('button', { name: '既存スレッド' });
    await waitFor(() => {
      expect(
        within(getThreadDrawer(container)).getByRole('button', { name: '既存スレッド' }),
      ).toHaveAttribute('aria-current', 'true');
    });
  });

  it('shows target project selector while chat settings remain collapsed', async () => {
    const { container } = renderChatPanel([PROJECT_A, PROJECT_B], {
      leaveSettingsCollapsed: true,
    });

    const details = container.querySelector('.chat-panel-settings');
    expect(details).toBeInstanceOf(HTMLDetailsElement);
    expect((details as HTMLDetailsElement).open).toBe(false);
    expect(screen.getByLabelText('対象プロジェクト')).toBeVisible();
  });

  it('works without agent select when fetchChatAgents fails', async () => {
    const user = userEvent.setup();
    fetchChatAgentsMock.mockRejectedValue(new Error('agents unavailable'));
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/chat/message' && init?.method === 'POST') {
        return jsonResponse({
          reply: 'fallback reply',
          sessionId: 'sess-fallback',
          agentId: 'claude',
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A]);
    await waitFor(() => {
      expect(fetchChatAgentsMock).toHaveBeenCalled();
    });

    expect(screen.queryByLabelText('チャットエージェント')).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('メッセージ'), 'still works');
    await user.click(screen.getByRole('button', { name: '送信' }));

    await waitFor(() => {
      expect(getChatMessagePostCalls(fetchMock)).toHaveLength(1);
    });

    const body = parseChatMessageBody(fetchMock);
    expect(body).toEqual({
      projectId: 'proj-a',
      message: 'still works',
    });
    expect(body).not.toHaveProperty('agentId');
    expect(await screen.findByText('fallback reply')).toBeInTheDocument();
  });

  it('shows model select when the agent exposes two or more models and sends the choice', async () => {
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([
      {
        ...CLAUDE_AGENT,
        model: 'sonnet',
        models: [
          { id: 'sonnet', label: 'Sonnet' },
          { id: 'opus', label: 'Opus' },
        ],
      },
    ]);

    renderChatPanel([PROJECT_A]);
    const modelSelect = await screen.findByLabelText('モデル');
    expect(modelSelect).toHaveValue('sonnet');

    await user.selectOptions(modelSelect, 'opus');
    await user.type(screen.getByLabelText('メッセージ'), 'use opus');
    await user.click(screen.getByRole('button', { name: '送信' }));

    await waitFor(() => {
      expect(getChatMessagePostCalls(fetchMock)).toHaveLength(1);
    });

    expect(parseChatMessageBody(fetchMock)).toEqual({
      projectId: 'proj-a',
      message: 'use opus',
      agentId: 'claude',
      model: 'opus',
    });

    // エージェント側のラベルに descriptor 既定を出さない。出すと Opus 選択中に
    // 「Claude Code (sonnet)」と並んで表示され、2つのコントロールが矛盾する。
    expect(
      screen.getByLabelText('チャットエージェント'),
    ).not.toHaveTextContent('(sonnet)');
  });

  it('keeps model selection when choosing project from unselected state (minor-7 regression)', async () => {
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([
      {
        ...CLAUDE_AGENT,
        model: 'sonnet',
        models: [
          { id: 'sonnet', label: 'Sonnet' },
          { id: 'opus', label: 'Opus' },
        ],
      },
    ]);

    renderChatPanel([PROJECT_A, PROJECT_B], { leaveSettingsCollapsed: true });

    const modelSelect = await screen.findByLabelText('モデル');
    expect(modelSelect).toHaveValue('sonnet');
    await user.selectOptions(modelSelect, 'opus');
    expect(modelSelect).toHaveValue('opus');

    await user.selectOptions(screen.getByLabelText('対象プロジェクト'), 'proj-a');

    await waitFor(() => {
      expect(screen.getByLabelText('対象プロジェクト')).toHaveValue('proj-a');
    });
    expect(screen.getByLabelText('モデル')).toHaveValue('opus');
  });

  it('hides model select when the agent exposes fewer than two models', async () => {
    fetchChatAgentsMock.mockResolvedValue([
      {
        ...CLAUDE_AGENT,
        model: 'sonnet',
        models: [{ id: 'sonnet', label: 'Sonnet' }],
      },
    ]);

    renderChatPanel([PROJECT_A]);
    await screen.findByLabelText('チャットエージェント');

    expect(screen.queryByLabelText('モデル')).not.toBeInTheDocument();
  });

  it('carries draft body but not threadModelIds when switching agents — shared model would stick if threadModelIds were carried (bdboard-ru4d)', async () => {
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([
      {
        ...CLAUDE_AGENT,
        model: 'sonnet',
        models: [
          { id: 'sonnet', label: 'Sonnet' },
          { id: 'shared-model', label: 'Shared' },
        ],
      },
      {
        ...EXAMPLE_AGENT,
        model: 'fast',
        models: [
          { id: 'shared-model', label: 'Shared' },
          { id: 'fast', label: 'Fast' },
        ],
      },
    ]);
    fetchChatThreadsMock.mockResolvedValue([]);

    renderChatPanel([PROJECT_A]);
    const modelSelect = await screen.findByLabelText('モデル');
    await user.selectOptions(modelSelect, 'shared-model');
    expect(modelSelect).toHaveValue('shared-model');

    await user.type(screen.getByLabelText('メッセージ'), '書きかけの本文');

    await user.selectOptions(
      screen.getByLabelText('チャットエージェント'),
      'example-agent',
    );

    expect(screen.getByLabelText('メッセージ')).toHaveValue('書きかけの本文');
    // threadModelIds を引き継ぐと shared-model がメンバーシップチェックを通過して残る。
    // 引き継がない場合のみ B のデフォルト fast になる。
    expect(await screen.findByLabelText('モデル')).toHaveValue('fast');
  });

  it('starts a fresh empty draft without carrying draft payload on explicit new thread (bdboard-ru4d)', async () => {
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([
      {
        ...CLAUDE_AGENT,
        model: 'sonnet',
        models: [
          { id: 'sonnet', label: 'Sonnet' },
          { id: 'opus', label: 'Opus' },
        ],
      },
    ]);
    fetchChatThreadsMock.mockResolvedValue([]);

    renderChatPanel([PROJECT_A]);
    await screen.findByLabelText('チャットエージェント');

    await user.type(screen.getByLabelText('メッセージ'), '旧ドラフトの本文');
    await user.click(screen.getByRole('button', { name: '新しい空のスレッドを開始' }));

    expect(screen.getByLabelText('メッセージ')).toHaveValue('');
  });

  it('resets model selection to the new agent default when switching agents', async () => {
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([
      {
        ...CLAUDE_AGENT,
        model: 'sonnet',
        models: [
          { id: 'sonnet', label: 'Sonnet' },
          { id: 'opus', label: 'Opus' },
        ],
      },
      {
        ...EXAMPLE_AGENT,
        model: 'fast',
        models: [
          { id: 'fast', label: 'Fast' },
          { id: 'slow', label: 'Slow' },
        ],
      },
    ]);

    renderChatPanel([PROJECT_A]);
    const modelSelect = await screen.findByLabelText('モデル');
    await user.selectOptions(modelSelect, 'opus');
    expect(modelSelect).toHaveValue('opus');

    await user.selectOptions(
      screen.getByLabelText('チャットエージェント'),
      'example-agent',
    );

    expect(await screen.findByLabelText('モデル')).toHaveValue('fast');
  });

  it('restores a draft model selection after remounting without sending', async () => {
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([
      {
        ...CLAUDE_AGENT,
        model: 'sonnet',
        models: [
          { id: 'sonnet', label: 'Sonnet' },
          { id: 'opus', label: 'Opus' },
        ],
      },
    ]);

    const first = renderChatPanel([PROJECT_A]);
    const modelSelect = await screen.findByLabelText('モデル');
    await user.selectOptions(modelSelect, 'opus');
    expect(modelSelect).toHaveValue('opus');
    first.unmount();

    renderChatPanel([PROJECT_A]);
    await waitFor(() => {
      expect(screen.getByLabelText('モデル')).toHaveValue('opus');
    });
  });

  it('preserves model selection when switching back to the same agent', async () => {
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([
      {
        ...CLAUDE_AGENT,
        model: 'sonnet',
        models: [
          { id: 'sonnet', label: 'Sonnet' },
          { id: 'opus', label: 'Opus' },
        ],
      },
      {
        ...EXAMPLE_AGENT,
        model: 'fast',
        models: [
          { id: 'fast', label: 'Fast' },
          { id: 'slow', label: 'Slow' },
        ],
      },
    ]);

    renderChatPanel([PROJECT_A]);
    const modelSelect = await screen.findByLabelText('モデル');
    await user.selectOptions(modelSelect, 'opus');
    expect(modelSelect).toHaveValue('opus');

    await user.selectOptions(
      screen.getByLabelText('チャットエージェント'),
      'example-agent',
    );

    expect(await screen.findByLabelText('モデル')).toHaveValue('fast');

    await user.selectOptions(
      screen.getByLabelText('チャットエージェント'),
      'claude',
    );

    expect(await screen.findByLabelText('モデル')).toHaveValue('opus');
  });

  it('restores the model after history resolves before the agents request', async () => {
    writePersistedChatThread('proj-a', {
      sessionId: 'sess-model-race',
      agentId: 'claude',
    });
    fetchChatThreadsMock.mockResolvedValue([
      {
        sessionId: 'sess-model-race',
        agentId: 'claude',
        title: 'race',
        pinned: false,
        updatedAt: '2026-08-16T03:00:00.000Z',
      },
    ]);
    const agentsDeferred = createDeferred<ChatAgentDto[]>();
    fetchChatAgentsMock.mockReturnValue(agentsDeferred.promise);
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/chat/sessions/sess-model-race/messages')) {
        return jsonResponse({
          sessionId: 'sess-model-race',
          agentId: 'claude',
          model: 'opus',
          messages: [],
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) =>
        String(url).startsWith('/api/chat/sessions/sess-model-race/messages'),
      )).toBe(true);
    });
    expect(fetchChatAgentsMock).toHaveBeenCalled();

    // agents リクエストがまだ解決していない時点では、モデル選択セレクトはまだ
    // 描画されない(エージェント一覧が空なので selectedAgent が定まらない)。
    // ここで復元済みの値が早期に(誤って)反映されていないことを確認してから
    // agents を解決させることで、pendingModelRestoreRef 相当のキャッシュ経由の
    // 復元経路を確実に踏ませる。
    expect(screen.queryByLabelText('モデル')).not.toBeInTheDocument();

    agentsDeferred.resolve([{
      ...CLAUDE_AGENT,
      model: 'sonnet',
      models: [
        { id: 'sonnet', label: 'Sonnet' },
        { id: 'opus', label: 'Opus' },
      ],
    }]);

    // findByLabelText はセレクト要素が最初に現れた時点(まだ既定値 'sonnet' の
    // ままの可能性がある)で解決してしまうため、値の確定は waitFor で
    // 再ポーリングして待つ。
    await waitFor(() => {
      expect(screen.getByLabelText('モデル')).toHaveValue('opus');
    });
  });

  it('restores the agent and falls back from an invalid persisted model', async () => {
    writePersistedChatThread('proj-a', {
      sessionId: 'sess-invalid-model',
      agentId: 'example-agent',
    });
    fetchChatThreadsMock.mockResolvedValue([
      {
        sessionId: 'sess-invalid-model',
        agentId: 'example-agent',
        title: 'invalid',
        pinned: false,
        updatedAt: '2026-08-16T03:00:00.000Z',
      },
    ]);
    fetchChatAgentsMock.mockResolvedValue([
      {
        ...CLAUDE_AGENT,
        model: 'sonnet',
        models: [
          { id: 'sonnet', label: 'Sonnet' },
          { id: 'opus', label: 'Opus' },
        ],
      },
      {
        ...EXAMPLE_AGENT,
        model: 'fast',
        models: [
          { id: 'fast', label: 'Fast' },
          { id: 'slow', label: 'Slow' },
        ],
      },
    ]);
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/chat/sessions/sess-invalid-model/messages')) {
        return jsonResponse({
          sessionId: 'sess-invalid-model',
          agentId: 'example-agent',
          model: 'nonexistent-model',
          messages: [],
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });

    await waitFor(() => {
      expect(screen.getByLabelText('チャットエージェント')).toHaveValue(
        'example-agent',
      );
    });
    await waitFor(() => {
      expect(screen.getByLabelText('モデル')).toHaveValue('fast');
    });
  });

  it('restores the persisted agent even when the default-agent effect sets a different agent first (bdboard-2n8 stale-ref regression)', async () => {
    // 以前は「履歴リクエスト開始時点の selectedAgentId」のスナップショットと
    // 「現在の selectedAgentId」を比較しており、この effect の外で起きる
    // 「エージェント一覧ロード後の既定エージェント自動選択」だけでもスナップ
    // ショットとの不一致が生まれ、ユーザーが何も手動操作していないのに
    // 永続化されていたエージェントへの復元が失敗していた。ここでは
    // 履歴フェッチより先にエージェント一覧の解決(既定選択)を起こし、
    // その後で履歴フェッチが「別のエージェント」を返すという順序を明示的に
    // 再現して、復元が成功することを確認する。
    writePersistedChatThread('proj-a', {
      sessionId: 'sess-agent-race',
      agentId: 'example-agent',
    });
    fetchChatThreadsMock.mockResolvedValue([
      {
        sessionId: 'sess-agent-race',
        agentId: 'example-agent',
        title: 'race',
        pinned: false,
        updatedAt: '2026-08-16T03:00:00.000Z',
      },
    ]);
    const agentsDeferred = createDeferred<ChatAgentDto[]>();
    fetchChatAgentsMock.mockReturnValue(agentsDeferred.promise);
    const messagesDeferred = createDeferred<Response>();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/chat/sessions/sess-agent-race/messages')) {
        return messagesDeferred.promise;
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) =>
        String(url).startsWith('/api/chat/sessions/sess-agent-race/messages'),
      )).toBe(true);
    });

    // 履歴フェッチはまだ in-flight。ここでエージェント一覧を解決させ、
    // 「既定エージェント(list[0] = claude)の自動選択」を先に起こす。
    agentsDeferred.resolve([CLAUDE_AGENT, EXAMPLE_AGENT]);
    await waitFor(() => {
      expect(screen.getByLabelText('チャットエージェント')).toHaveValue('claude');
    });

    // このあとで履歴フェッチが解決し、永続化されていた 'example-agent' を
    // 返す。ユーザーは一度も手動でエージェントを変更していないので、
    // 復元が適用されるべき。
    messagesDeferred.resolve(
      jsonResponse({
        sessionId: 'sess-agent-race',
        agentId: 'example-agent',
        messages: [],
      }),
    );
    await waitFor(() => {
      expect(screen.getByLabelText('チャットエージェント')).toHaveValue('example-agent');
    });
  });

  it('restores the model from the server after sending and remounting', async () => {
    const user = userEvent.setup();
    const modelEnabledClaude: ChatAgentDto = {
      ...CLAUDE_AGENT,
      model: 'sonnet',
      models: [
        { id: 'sonnet', label: 'Sonnet' },
        { id: 'opus', label: 'Opus' },
      ],
    };
    fetchChatAgentsMock.mockResolvedValue([modelEnabledClaude]);
    // 1回目(初回マウント時)は「まだスレッドが無い」状態、2回目(再マウント時、
    // 送信後の localStorage を引き継いだ状態)は送信で作られたスレッドが
    // サーバー側の一覧にも載っている状態を模す。
    fetchChatThreadsMock.mockResolvedValueOnce([]).mockResolvedValue([
      {
        sessionId: 'sess-sent-model',
        agentId: 'claude',
        title: 'sent',
        pinned: false,
        updatedAt: '2026-08-16T03:00:00.000Z',
      },
    ]);
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/chat/message' && init?.method === 'POST') {
        return jsonResponse({
          reply: 'sent', sessionId: 'sess-sent-model', agentId: 'claude', model: 'opus',
        });
      }
      if (url.startsWith('/api/chat/sessions/sess-sent-model/messages')) {
        return jsonResponse({
          sessionId: 'sess-sent-model', agentId: 'claude', model: 'opus', messages: [],
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    const first = renderChatPanel([PROJECT_A]);
    const modelSelect = await screen.findByLabelText('モデル');
    await user.selectOptions(modelSelect, 'opus');
    await user.type(screen.getByLabelText('メッセージ'), 'persist this choice');
    await user.click(screen.getByRole('button', { name: '送信' }));
    await screen.findByText('sent');
    first.unmount();

    renderChatPanel([PROJECT_A]);
    await waitFor(() => {
      expect(screen.getByLabelText('モデル')).toHaveValue('opus');
    });
  });

  it('keeps a manual model pick made while the history fetch is still in flight (bdboard-2n8)', async () => {
    const user = userEvent.setup();
    writePersistedChatThread('proj-a', {
      sessionId: 'sess-manual-race',
      agentId: 'claude',
    });
    fetchChatThreadsMock.mockResolvedValue([
      {
        sessionId: 'sess-manual-race',
        agentId: 'claude',
        title: 'manual',
        pinned: false,
        updatedAt: '2026-08-16T03:00:00.000Z',
      },
    ]);
    fetchChatAgentsMock.mockResolvedValue([
      {
        ...CLAUDE_AGENT,
        model: 'sonnet',
        models: [
          { id: 'sonnet', label: 'Sonnet' },
          { id: 'opus', label: 'Opus' },
        ],
      },
    ]);
    const messagesDeferred = createDeferred<Response>();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/chat/sessions/sess-manual-race/messages')) {
        return messagesDeferred.promise;
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });

    const modelSelect = await screen.findByLabelText('モデル');
    await waitFor(() => expect(modelSelect).toHaveValue('sonnet'));
    await user.selectOptions(modelSelect, 'opus');
    expect(modelSelect).toHaveValue('opus');

    // 履歴フェッチが後から解決し、サーバー側の復元値('sonnet')を返す。
    // ユーザーが in-flight 中に手動で 'opus' を選んでいるので、
    // これで上書きされてはいけない。
    messagesDeferred.resolve(
      jsonResponse({
        sessionId: 'sess-manual-race',
        agentId: 'claude',
        model: 'sonnet',
        messages: [],
      }),
    );

    await waitFor(() => {
      expect(screen.queryByText('履歴を読み込み中…')).not.toBeInTheDocument();
    });
    expect(screen.getByLabelText('モデル')).toHaveValue('opus');
  });

  it('keeps a manual model pick on an unsent draft thread across a round trip through another project (bdboard-2n8)', async () => {
    // ドラフト(未送信)スレッドの会話キーは `new:${projectId}:${draftNonce}` で、
    // draftNonce はプロジェクトごとに独立している。そのためプロジェクトを
    // 切り替えて元に戻ると、ドラフトの会話キー自体は変わらない —
    // これが「タブ往復」で手動選択を保持できるかを検証できる具体的な経路。
    const user = userEvent.setup();
    fetchChatAgentsMock.mockResolvedValue([
      {
        ...CLAUDE_AGENT,
        model: 'sonnet',
        models: [
          { id: 'sonnet', label: 'Sonnet' },
          { id: 'opus', label: 'Opus' },
        ],
      },
    ]);
    fetchChatThreadsMock.mockResolvedValue([]);

    renderChatPanel([PROJECT_A, PROJECT_B], { initialProjectId: 'proj-a' });

    const modelSelect = await screen.findByLabelText('モデル');
    await waitFor(() => expect(modelSelect).toHaveValue('sonnet'));
    await user.selectOptions(modelSelect, 'opus');
    expect(modelSelect).toHaveValue('opus');

    await user.selectOptions(screen.getByLabelText('対象プロジェクト'), 'proj-b');
    await waitFor(() => {
      expect(screen.getByLabelText('対象プロジェクト')).toHaveValue('proj-b');
    });
    await waitFor(() => {
      expect(screen.getByLabelText('モデル')).toHaveValue('sonnet');
    });

    await user.selectOptions(screen.getByLabelText('対象プロジェクト'), 'proj-a');
    await waitFor(() => {
      expect(screen.getByLabelText('モデル')).toHaveValue('opus');
    });
  });

  it('reapplies each thread’s own restored model when switching between already-loaded tabs', async () => {
    // MF3: 履歴読み込み effect はスレッドごとに一度きり(historyLoadedFor で
    // ガード)なので、既に両方読み込み済みのスレッドを A→B→A と行き来したときに
    // モデルが再適用されるのは「フェッチが起きた時」ではなく「表示中の会話キーが
    // 変わった時」に反応するキャッシュ経由でなければならない。
    const user = userEvent.setup();
    const modelEnabledClaude: ChatAgentDto = {
      ...CLAUDE_AGENT,
      model: 'sonnet',
      models: [
        { id: 'sonnet', label: 'Sonnet' },
        { id: 'opus', label: 'Opus' },
      ],
    };
    fetchChatAgentsMock.mockResolvedValue([modelEnabledClaude]);
    fetchChatThreadsMock.mockResolvedValue([
      { sessionId: 'sess-thread-a', agentId: 'claude', title: 'thread A', pinned: false, updatedAt: '2026-08-16T03:00:00.000Z' },
      { sessionId: 'sess-thread-b', agentId: 'claude', title: 'thread B', pinned: false, updatedAt: '2026-08-16T03:01:00.000Z' },
    ]);
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/chat/sessions/sess-thread-a/messages')) {
        return jsonResponse({
          sessionId: 'sess-thread-a', agentId: 'claude', model: 'sonnet', messages: [],
        });
      }
      if (url.startsWith('/api/chat/sessions/sess-thread-b/messages')) {
        return jsonResponse({
          sessionId: 'sess-thread-b', agentId: 'claude', model: 'opus', messages: [],
        });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    });

    const { container } = renderChatPanel([PROJECT_A], { initialProjectId: 'proj-a' });

    openThreadDrawer(container);
    expect(
      await within(getThreadDrawer(container)).findByRole('button', { name: 'thread A' }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByLabelText('モデル')).toHaveValue('sonnet');
    });

    await selectThreadFromDrawer(container, user, 'thread B');
    await waitFor(() => {
      expect(screen.getByLabelText('モデル')).toHaveValue('opus');
    });

    await selectThreadFromDrawer(container, user, 'thread A');
    await waitFor(() => {
      expect(screen.getByLabelText('モデル')).toHaveValue('sonnet');
    });
  });
});
