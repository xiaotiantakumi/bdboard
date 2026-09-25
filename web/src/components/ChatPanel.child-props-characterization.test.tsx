// bdboard-sso1.83 第15c段の前に書いた特性テスト。ChatPanel が子の presentational
// コンポーネント(ヘッダー・プロジェクト欄・スレッド切替・ドロワー枠・設定・
// メッセージ一覧・コンポーザー)へ渡す props を、view model へまとめる前の形で固定する。
// 第6段/第7段の配線テスト(thread-drawer-row-wiring / composer-header-wiring)と同じく
// 子を vi.mock で差し替え、mock.calls で実際に渡された props を見る。
// - props の名前の集合(spread で余計なものが混ざったり、抜けたりしないこと)
// - 合成ハンドラ(新規スレッド = ドロワーを閉じてから開始、CLI セッション再開 =
//   再開してからドロワーを閉じる、添付の削除 = 今の会話キーで消す)が本物の処理まで
//   届いていること
// - DOM の ref が取り違えられていないこと(ヘッダー/ドロワーの閉じるボタンへの
//   フォーカスの行き来で見る)
import type { ChangeEvent } from 'react';
import { act, cleanup, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatAgentDto, ChatThreadDto, ChatTurnStatusDto } from '../api';
import { installFakeHistory } from '../test/fakeHistory';
import { writePersistedChatThreadState } from '../chatThreadStorage';

vi.mock('./chat/ChatPanelHeader', () => ({ ChatPanelHeader: vi.fn(() => null) }));
vi.mock('./chat/ChatProjectBar', () => ({ ChatProjectBar: vi.fn(() => null) }));
vi.mock('./chat/ChatThreadSwitcher', () => ({ ChatThreadSwitcher: vi.fn(() => null) }));
vi.mock('./chat/ChatThreadDrawer', () => ({ ChatThreadDrawer: vi.fn(() => null) }));
vi.mock('./chat/ChatSettingsPanel', () => ({ ChatSettingsPanel: vi.fn(() => null) }));
vi.mock('./chat/ChatMessageList', () => ({ ChatMessageList: vi.fn(() => null) }));
vi.mock('./chat/ChatComposer', () => ({ ChatComposer: vi.fn(() => null) }));

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
  acknowledgeChatTurn,
  fetchChatAgents,
  fetchChatThreads,
  fetchChatTurnStatus,
  fetchDiscoveredChatSessions,
  fetchPlatformSupport,
} from '../api';
import { resetPlatformSupportCache } from './PlatformLimitationNotice';
import { ChatPanelHeader } from './chat/ChatPanelHeader';
import { ChatProjectBar } from './chat/ChatProjectBar';
import { ChatThreadSwitcher } from './chat/ChatThreadSwitcher';
import { ChatThreadDrawer } from './chat/ChatThreadDrawer';
import { ChatSettingsPanel } from './chat/ChatSettingsPanel';
import { ChatMessageList } from './chat/ChatMessageList';
import { ChatComposer } from './chat/ChatComposer';
import {
  CLAUDE_AGENT,
  CODEX_IMAGE_AGENT,
  PROJECT_A,
  PROJECT_B,
  makeFileList,
  makeImageFile,
  renderChatPanel,
} from './ChatPanel-test-support';

function lastProps<P>(mock: { mock: { calls: readonly (readonly [P, ...unknown[]])[] } }, name: string): P {
  const call = mock.mock.calls.at(-1);
  if (call === undefined) throw new Error(`${name} was never rendered`);
  return call[0];
}
const header = () => lastProps(vi.mocked(ChatPanelHeader), 'ChatPanelHeader');
const projectBar = () => lastProps(vi.mocked(ChatProjectBar), 'ChatProjectBar');
const switcher = () => lastProps(vi.mocked(ChatThreadSwitcher), 'ChatThreadSwitcher');
const drawer = () => lastProps(vi.mocked(ChatThreadDrawer), 'ChatThreadDrawer');
const settings = () => lastProps(vi.mocked(ChatSettingsPanel), 'ChatSettingsPanel');
const messageList = () => lastProps(vi.mocked(ChatMessageList), 'ChatMessageList');
const composer = () => lastProps(vi.mocked(ChatComposer), 'ChatComposer');

function rowKeys(rows: unknown): (string | null)[] {
  if (!Array.isArray(rows)) throw new Error('rows is not an array');
  return rows.map((row: { key: string | null }) => row.key);
}

const OPEN_A = { sessionId: 'sess-vm-a', agentId: 'claude', title: 'vm marker A', pinned: false, updatedAt: '2026-01-03T00:00:00Z' };
const OPEN_B = { sessionId: 'sess-vm-b', agentId: 'claude', title: 'vm marker B', pinned: true, updatedAt: '2026-01-02T00:00:00Z' };
const CLOSED_C = { sessionId: 'sess-vm-c', agentId: 'claude', title: 'vm marker C', pinned: false, updatedAt: '2026-01-01T00:00:00Z' };

function persistOpenThreads() {
  writePersistedChatThreadState(PROJECT_A.id, {
    activeSessionIds: [OPEN_A.sessionId, OPEN_B.sessionId],
    selectedSessionId: OPEN_A.sessionId,
  });
}

describe('ChatPanel child props wiring (pinned before bdboard-sso1.83 第15c段)', () => {
  beforeEach(() => {
    installFakeHistory({});
    localStorage.clear();
    resetPlatformSupportCache();
    vi.mocked(fetchPlatformSupport).mockResolvedValue({ platform: 'darwin', limitations: [] });
    vi.mocked(fetchChatAgents).mockResolvedValue([CLAUDE_AGENT, CODEX_IMAGE_AGENT]);
    vi.mocked(fetchChatThreads).mockResolvedValue([OPEN_A, OPEN_B, CLOSED_C]);
    vi.mocked(fetchChatTurnStatus).mockResolvedValue({ state: 'idle' });
    vi.mocked(acknowledgeChatTurn).mockResolvedValue();
    vi.mocked(fetchDiscoveredChatSessions).mockResolvedValue({ sessions: [] });
  });

  afterEach(() => {
    // bdboard-1ga8 と同じ作法: モックを reset する前にアンマウントし、E8 のポーリングが
    // 次のテストへ持ち越されないようにする。
    try {
      cleanup();
    } finally {
      vi.unstubAllGlobals();
      vi.resetAllMocks();
      vi.restoreAllMocks();
    }
  });

  it('passes exactly the same prop names to every child (no extra or missing keys)', async () => {
    renderChatPanel([PROJECT_A], { initialProjectId: PROJECT_A.id, leaveSettingsCollapsed: true });
    await waitFor(() => expect(settings().agents).toHaveLength(2));

    const keys = (value: object) => Object.keys(value).sort();
    expect(keys(header())).toEqual(['closeButtonRef', 'isMaximized', 'onClose', 'onToggleMaximize']);
    expect(keys(projectBar())).toEqual([
      'isSending', 'onProjectSelectChange', 'projectSelectionHint', 'projectSelectionHintId', 'projects',
      'selectedProjectId', 'selectedProjectName', 'showProjectSelect', 'ticketProjectFallbackNotice',
    ]);
    expect(keys(switcher())).toEqual([
      'currentThreadTitle', 'hasClosedThreads', 'hasNoDisplayedOpenThreads', 'onNewThread', 'onToggleDrawer',
      'openThreadsCount', 'threadDrawerOpen',
    ]);
    expect(keys(drawer())).toEqual([
      'closeButtonRef', 'closedRows', 'drawerRef', 'hasOpenRows', 'hasPinnedRows', 'hasVisibleClosedThreads',
      'isSending', 'onClose', 'onCloseDiscoveredSessions', 'onResumeDiscoveredSession',
      'onToggleDiscoveredSessions', 'open', 'openRows', 'pinnedRows', 'selectedProjectId',
      'showDiscoveredSessions',
    ]);
    expect(keys(settings())).toEqual([
      'agents', 'effectiveModelId', 'isSending', 'onAgentChange', 'onModelChange', 'selectedAgent',
      'selectedAgentId', 'showModelSelect', 'summaryParts', 'threadError',
    ]);
    expect(keys(messageList())).toEqual([
      'activeStreamingText', 'backgroundTurnProjectId', 'backgroundTurnStatus', 'currentConversationKey',
      'currentMessages', 'isSending', 'isTicketOnBoard', 'loadingHistoryFor', 'messagesRef', 'onOpenTicket',
      'onScroll', 'selectedProjectId', 'sendElapsedSeconds',
    ]);
    const c = composer();
    expect(keys(c)).toEqual([
      'actions', 'disabled', 'formRef', 'hasAttachments', 'inputRef', 'notices', 'onChange', 'onKeyDown',
      'onPaste', 'onSubmit', 'quickCommands', 'value',
    ]);
    expect(keys(c.quickCommands)).toEqual(['isHistoryPending', 'isSending', 'onQuickCommand', 'selectedProjectId']);
    expect(keys(c.notices)).toEqual([
      'agentUnavailableHintId', 'attachmentError', 'attachments', 'hasUnresolvedProjectRecovery',
      'hasUnsupportedAttachments', 'isSending', 'onRemoveAttachment', 'selectedAgentUnavailable',
    ]);
    expect(keys(c.actions)).toEqual([
      'ariaDescribedBy', 'chatUnsupported', 'fileInputRef', 'isSending', 'onImageFileChange', 'submitDisabled',
    ]);
  });

  it('wires the project bar to the real project selection (and E5 onProjectIdChange)', async () => {
    const onProjectIdChange = vi.fn();
    const projects = [PROJECT_A, PROJECT_B];
    renderChatPanel(projects, { onProjectIdChange, leaveSettingsCollapsed: true });
    await waitFor(() => expect(vi.mocked(ChatProjectBar)).toHaveBeenCalled());

    expect(projectBar().projects).toBe(projects);
    expect(projectBar().showProjectSelect).toBe(true);
    expect(projectBar().selectedProjectId).toBe('');
    expect(projectBar().selectedProjectName).toBeUndefined();
    expect(projectBar().projectSelectionHintId).toBe('chat-project-unselected-hint');
    expect(projectBar().projectSelectionHint).not.toBeNull();
    expect(projectBar().isSending).toBe(false);
    expect(projectBar().ticketProjectFallbackNotice).toBeNull();

    act(() => {
      projectBar().onProjectSelectChange(PROJECT_B.id);
    });
    expect(projectBar().selectedProjectId).toBe(PROJECT_B.id);
    expect(projectBar().selectedProjectName).toBe('Project Beta');
    expect(projectBar().projectSelectionHintId).toBeNull();
    expect(onProjectIdChange).toHaveBeenLastCalledWith(PROJECT_B.id);
    expect(drawer().selectedProjectId).toBe(PROJECT_B.id);
    expect(messageList().selectedProjectId).toBe(PROJECT_B.id);
    expect(composer().quickCommands.selectedProjectId).toBe(PROJECT_B.id);
  });

  it('builds the drawer rows and wires the switcher/drawer toggles to the real drawer state', async () => {
    persistOpenThreads();
    renderChatPanel([PROJECT_A], { initialProjectId: PROJECT_A.id, leaveSettingsCollapsed: true });
    await waitFor(() => expect(switcher().currentThreadTitle).toBe(OPEN_A.title));

    expect(switcher().openThreadsCount).toBe(2);
    expect(switcher().hasNoDisplayedOpenThreads).toBe(false);
    expect(switcher().hasClosedThreads).toBe(true);
    expect(switcher().threadDrawerOpen).toBe(false);
    expect(drawer().open).toBe(false);

    act(() => {
      switcher().onToggleDrawer();
    });
    expect(switcher().threadDrawerOpen).toBe(true);
    expect(drawer().open).toBe(true);

    const d = drawer();
    expect(d.hasPinnedRows).toBe(true);
    expect(rowKeys(d.pinnedRows)).toEqual([OPEN_B.sessionId]);
    expect(d.hasOpenRows).toBe(true);
    expect(rowKeys(d.openRows)).toEqual([OPEN_A.sessionId]);
    expect(d.hasVisibleClosedThreads).toBe(true);
    expect(rowKeys(d.closedRows)).toEqual([CLOSED_C.sessionId]);
    expect(d.isSending).toBe(false);

    expect(d.showDiscoveredSessions).toBe(false);
    act(() => {
      drawer().onToggleDiscoveredSessions();
    });
    expect(drawer().showDiscoveredSessions).toBe(true);
    act(() => {
      drawer().onCloseDiscoveredSessions();
    });
    expect(drawer().showDiscoveredSessions).toBe(false);

    act(() => {
      drawer().onClose();
    });
    expect(drawer().open).toBe(false);
    expect(switcher().threadDrawerOpen).toBe(false);
  });

  it('wires onNewThread to close the drawer and start a new draft thread', async () => {
    persistOpenThreads();
    renderChatPanel([PROJECT_A], { initialProjectId: PROJECT_A.id, leaveSettingsCollapsed: true });
    await waitFor(() => expect(switcher().currentThreadTitle).toBe(OPEN_A.title));
    act(() => {
      switcher().onToggleDrawer();
    });
    expect(drawer().open).toBe(true);
    const keyBefore = messageList().currentConversationKey;

    act(() => {
      switcher().onNewThread();
    });
    expect(drawer().open).toBe(false);
    expect(switcher().currentThreadTitle).not.toBe(OPEN_A.title);
    expect(messageList().currentConversationKey).not.toBe(keyBefore);
  });

  it('wires onResumeDiscoveredSession to resume the session and then close the drawer', async () => {
    persistOpenThreads();
    renderChatPanel([PROJECT_A], { initialProjectId: PROJECT_A.id, leaveSettingsCollapsed: true });
    await waitFor(() => expect(switcher().currentThreadTitle).toBe(OPEN_A.title));
    act(() => {
      switcher().onToggleDrawer();
    });
    expect(drawer().open).toBe(true);

    act(() => {
      drawer().onResumeDiscoveredSession('sess-vm-discovered', 'claude', []);
    });
    expect(drawer().open).toBe(false);
    await waitFor(() => expect(switcher().openThreadsCount).toBe(3));
    expect(messageList().currentConversationKey).toContain('sess-vm-discovered');
  });

  it('wires the settings panel to the real agent/model state', async () => {
    renderChatPanel([PROJECT_A], { initialProjectId: PROJECT_A.id, leaveSettingsCollapsed: true });
    await waitFor(() => expect(settings().agents).toHaveLength(2));

    expect(settings().selectedAgentId).toBe(CLAUDE_AGENT.id);
    expect(settings().selectedAgent?.id).toBe(CLAUDE_AGENT.id);
    expect(settings().threadError).toBeNull();
    expect(settings().isSending).toBe(false);
    expect(settings().summaryParts).toEqual(['チャット設定', 'Project Alpha', OPEN_A.title, 'Claude']);

    act(() => {
      settings().onAgentChange(CODEX_IMAGE_AGENT.id);
    });
    expect(settings().selectedAgentId).toBe(CODEX_IMAGE_AGENT.id);
    expect(settings().selectedAgent?.id).toBe(CODEX_IMAGE_AGENT.id);
    // エージェントを変えると新しい下書きスレッドになる(handleAgentChange の既存の挙動)。
    expect(settings().summaryParts).toEqual(['チャット設定', 'Project Alpha', '新規', 'Codex']);

    act(() => {
      settings().onModelChange('gpt-5');
    });
    expect(settings().effectiveModelId).toBe('gpt-5');
  });

  it('wires the message list to the real conversation and passes the ticket callbacks through', async () => {
    const isTicketOnBoard = vi.fn(() => true);
    const onOpenTicket = vi.fn();
    renderChatPanel([PROJECT_A], {
      initialProjectId: PROJECT_A.id,
      leaveSettingsCollapsed: true,
      isTicketOnBoard,
      onOpenTicket,
    });
    await waitFor(() => expect(settings().agents).toHaveLength(2));

    const m = messageList();
    expect(m.isTicketOnBoard).toBe(isTicketOnBoard);
    expect(m.onOpenTicket).toBe(onOpenTicket);
    expect(m.currentMessages).toEqual([]);
    expect(m.currentConversationKey).toBe(OPEN_A.sessionId);
    expect(m.loadingHistoryFor).toBeNull();
    expect(m.isSending).toBe(false);
    expect(m.backgroundTurnStatus).toEqual({ state: 'idle' });
    expect(m.activeStreamingText).toBe('');
    expect(m.sendElapsedSeconds).toBe(0);
    expect(typeof m.onScroll).toBe('function');
  });

  it('wires the composer disabled flag, attachment removal and the DOM refs', async () => {
    renderChatPanel([PROJECT_A], { initialProjectId: PROJECT_A.id, leaveSettingsCollapsed: true });
    await waitFor(() => expect(settings().agents).toHaveLength(2));
    act(() => {
      settings().onAgentChange(CODEX_IMAGE_AGENT.id);
    });

    const first = composer();
    expect(first.disabled).toBe(false);
    expect(first.hasAttachments).toBe(false);

    act(() => {
      composer().actions.onImageFileChange({
        target: { files: makeFileList([makeImageFile('vm-marker.png')]) },
      } as unknown as ChangeEvent<HTMLInputElement>);
    });
    await waitFor(() => expect(composer().notices.attachments).toHaveLength(1));
    expect(composer().hasAttachments).toBe(true);
    const attachment = composer().notices.attachments[0];
    if (attachment === undefined) throw new Error('attachment missing');

    act(() => {
      composer().notices.onRemoveAttachment(attachment.id);
    });
    expect(composer().notices.attachments).toHaveLength(0);
    expect(composer().hasAttachments).toBe(false);

    // DOM の ref: レンダーをまたいで同じオブジェクトで、互いに別物。
    const last = composer();
    const refs = [
      header().closeButtonRef,
      drawer().drawerRef,
      drawer().closeButtonRef,
      messageList().messagesRef,
      last.formRef,
      last.inputRef,
      last.actions.fileInputRef,
    ];
    expect(new Set(refs).size).toBe(refs.length);
    expect(last.formRef).toBe(first.formRef);
    expect(last.inputRef).toBe(first.inputRef);
    expect(last.actions.fileInputRef).toBe(first.actions.fileInputRef);
  });

  it('routes focus between the header and drawer close buttons through the right refs', async () => {
    vi.mocked(ChatPanelHeader).mockImplementation((props) => (
      <button type="button" ref={props.closeButtonRef}>
        vm-header-close
      </button>
    ));
    vi.mocked(ChatThreadDrawer).mockImplementation((props) =>
      props.open ? (
        <div ref={props.drawerRef}>
          <button type="button" ref={props.closeButtonRef}>
            vm-drawer-close
          </button>
        </div>
      ) : null,
    );
    renderChatPanel([PROJECT_A], { initialProjectId: PROJECT_A.id, leaveSettingsCollapsed: true });
    await waitFor(() => expect(document.activeElement?.textContent).toBe('vm-header-close'));

    act(() => {
      switcher().onToggleDrawer();
    });
    await waitFor(() => expect(document.activeElement?.textContent).toBe('vm-drawer-close'));

    act(() => {
      drawer().onClose();
    });
    await waitFor(() => expect(document.activeElement?.textContent).toBe('vm-header-close'));
  });
});
