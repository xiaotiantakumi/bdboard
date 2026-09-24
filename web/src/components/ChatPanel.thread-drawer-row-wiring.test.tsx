// bdboard-sso1.83 第6段: ChatThreadDrawerOpenRow/ChatThreadDrawerClosedRow 抽出時の
// 配線テスト。#654 のレビューで「スカラーだけのモックでは配線ミスを見逃す」と
// 指摘された教訓に従い、行コンポーネントを vi.mock で差し替え、
// vi.mocked(X).mock.calls で実際に渡された props(スカラーだけでなく actions
// オブジェクトの各関数)を検証する。session-id をマーカーとして複数行を区別し、
// actions を実際に呼び出して ChatPanel 側の本物のハンドラ(select/togglePin/
// closeThread/reopenClosed のような、元実装で複数ステップをまとめていた合成
// ハンドラ)まで配線されている(スタブで終わっていない)ことを確認する。
import { act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatAgentDto, ChatThreadDto, ChatTurnStatusDto } from '../api';
import { installFakeHistory } from '../test/fakeHistory';
import { readPersistedChatThreads, writePersistedChatThreadState } from '../chatThreadStorage';

vi.mock('./chat/ChatThreadDrawerOpenRow', () => ({
  ChatThreadDrawerOpenRow: vi.fn(() => null),
}));
vi.mock('./chat/ChatThreadDrawerClosedRow', () => ({
  ChatThreadDrawerClosedRow: vi.fn(() => null),
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    fetchChatAgents: vi.fn(() => Promise.resolve<ChatAgentDto[]>([])),
    fetchChatThreads: vi.fn(() => Promise.resolve<ChatThreadDto[]>([])),
    fetchChatTurnStatus: vi.fn(() => Promise.resolve<ChatTurnStatusDto>({ state: 'idle' })),
    acknowledgeChatTurn: vi.fn(() => Promise.resolve()),
    deleteChatThread: vi.fn(() => Promise.resolve()),
    updateChatThread: vi.fn(),
    fetchDiscoveredChatSessions: vi.fn(() => Promise.resolve({ sessions: [] })),
    fetchPlatformSupport: vi.fn(() => Promise.resolve({ platform: 'darwin', limitations: [] })),
  };
});

import {
  fetchChatAgents,
  fetchChatThreads,
  fetchChatTurnStatus,
  updateChatThread,
  fetchPlatformSupport,
} from '../api';
import { resetPlatformSupportCache } from './PlatformLimitationNotice';
import { ChatThreadDrawerOpenRow } from './chat/ChatThreadDrawerOpenRow';
import { ChatThreadDrawerClosedRow } from './chat/ChatThreadDrawerClosedRow';
import { PROJECT_A, openThreadDrawer, renderChatPanel } from './ChatPanel-test-support';

const fetchChatAgentsMock = vi.mocked(fetchChatAgents);
const fetchChatThreadsMock = vi.mocked(fetchChatThreads);
const fetchChatTurnStatusMock = vi.mocked(fetchChatTurnStatus);
const updateChatThreadMock = vi.mocked(updateChatThread);
const fetchPlatformSupportMock = vi.mocked(fetchPlatformSupport);
const openRowMock = vi.mocked(ChatThreadDrawerOpenRow);
const closedRowMock = vi.mocked(ChatThreadDrawerClosedRow);

// マーカー(sessionId)で行を区別する。複数回呼ばれるので最新の呼び出しを拾う。
function lastOpenRowProps(sessionId: string) {
  const call = [...openRowMock.mock.calls].reverse().find(([props]) => props.sessionId === sessionId);
  if (call === undefined) throw new Error(`no ChatThreadDrawerOpenRow call for ${sessionId}`);
  return call[0];
}
function lastClosedRowProps(sessionId: string) {
  const call = [...closedRowMock.mock.calls]
    .reverse()
    .find(([props]) => props.thread.sessionId === sessionId);
  if (call === undefined) throw new Error(`no ChatThreadDrawerClosedRow call for ${sessionId}`);
  return call[0];
}

const OPEN_A = { sessionId: 'sess-marker-a', agentId: 'claude', title: 'marker A', pinned: false, updatedAt: '2026-01-03T00:00:00Z' };
const OPEN_B = { sessionId: 'sess-marker-b', agentId: 'claude', title: 'marker B', pinned: true, updatedAt: '2026-01-02T00:00:00Z' };
const CLOSED_C = { sessionId: 'sess-marker-c', agentId: 'claude', title: 'marker C', pinned: false, updatedAt: '2026-01-01T00:00:00Z' };

describe('ChatPanel thread drawer row wiring (bdboard-sso1.83 第6段)', () => {
  beforeEach(() => {
    installFakeHistory({});
    localStorage.clear();
    resetPlatformSupportCache();
    fetchPlatformSupportMock.mockResolvedValue({ platform: 'darwin', limitations: [] });
    fetchChatAgentsMock.mockResolvedValue([
      { id: 'claude', label: 'Claude', models: [], experimental: false, capability: 'bd-only', availability: 'available', supportsStreaming: false, supportsImages: false },
    ]);
    fetchChatThreadsMock.mockResolvedValue([OPEN_A, OPEN_B, CLOSED_C]);
    fetchChatTurnStatusMock.mockResolvedValue({ state: 'idle' });
    updateChatThreadMock.mockImplementation((sessionId, _projectId, patch) =>
      Promise.resolve({
        sessionId,
        agentId: 'claude',
        title: 'marker A',
        pinned: patch.pinned ?? false,
        updatedAt: '2026-01-03T01:00:00Z',
      }),
    );
    // OPEN_A/OPEN_B だけを開いた状態として永続化し、CLOSED_C は閉じたまま残す
    // (persisted が無いと fetchChatThreads の全件が自動的に「開いている」扱いに
    // なり、閉じた行のケースを再現できないため)。
    writePersistedChatThreadState(PROJECT_A.id, {
      activeSessionIds: [OPEN_A.sessionId, OPEN_B.sessionId],
      selectedSessionId: OPEN_A.sessionId,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
    vi.restoreAllMocks();
  });

  it('wires per-row scalar and thread props, distinguished by session-id markers', async () => {
    const { container } = renderChatPanel([PROJECT_A], { initialProjectId: PROJECT_A.id });
    openThreadDrawer(container);
    await waitFor(() => expect(openRowMock).toHaveBeenCalled());
    await waitFor(() => expect(closedRowMock).toHaveBeenCalled());

    const aProps = lastOpenRowProps(OPEN_A.sessionId);
    expect(aProps.thread?.title).toBe('marker A');
    expect(aProps.agentLabel).toBe('Claude');
    expect(aProps.isSelected).toBe(true);
    expect(aProps.isRenaming).toBe(false);
    expect(aProps.isMenuOpen).toBe(false);
    expect(aProps.isConfirmingDelete).toBe(false);
    expect(aProps.renameDraft).toBe('');

    const bProps = lastOpenRowProps(OPEN_B.sessionId);
    expect(bProps.thread?.pinned).toBe(true);
    expect(bProps.isSelected).toBe(false);

    const cProps = lastClosedRowProps(CLOSED_C.sessionId);
    expect(cProps.thread.title).toBe('marker C');
  });

  it('wires the combo actions (select/togglePin+closeMenu/closeThread+closeMenu/reopenClosed) to real ChatPanel handlers', async () => {
    const { container } = renderChatPanel([PROJECT_A], { initialProjectId: PROJECT_A.id });
    openThreadDrawer(container);
    await waitFor(() => expect(openRowMock).toHaveBeenCalled());
    await waitFor(() => expect(closedRowMock).toHaveBeenCalled());

    // select: 元実装のドロワー行クリックは
    // selectThreadDrawerThread()(useThreadDrawerState の 'selectThread' action、
    // ドロワーを閉じる副作用を含む) + setSelectedThreadIds + 永続化の3ステップ。
    // ドロワーが閉じる(=行が unmount される)ところまで含めて実際に走ることを確認する。
    act(() => lastOpenRowProps(OPEN_A.sessionId).actions.select(OPEN_B.sessionId));
    expect(container.querySelector('#chat-thread-drawer')).not.toBeInTheDocument();
    expect(readPersistedChatThreads()[PROJECT_A.id]?.selectedSessionId).toBe(OPEN_B.sessionId);

    openThreadDrawer(container);
    await waitFor(() => expect(lastOpenRowProps(OPEN_B.sessionId).isSelected).toBe(true));
    expect(lastOpenRowProps(OPEN_A.sessionId).isSelected).toBe(false);

    // togglePin: メニューを開いた状態から呼ぶと、本処理(API 呼び出し)に加えて
    // メニューも閉じる(元実装の closeThreadActionMenu() 込みの合成ハンドラ)。
    act(() => lastOpenRowProps(OPEN_A.sessionId).actions.toggleMenu(OPEN_A.sessionId));
    await waitFor(() => expect(lastOpenRowProps(OPEN_A.sessionId).isMenuOpen).toBe(true));
    act(() => lastOpenRowProps(OPEN_A.sessionId).actions.togglePin(OPEN_A.sessionId, false));
    await waitFor(() =>
      expect(updateChatThreadMock).toHaveBeenCalledWith(OPEN_A.sessionId, PROJECT_A.id, { pinned: true }),
    );
    expect(lastOpenRowProps(OPEN_A.sessionId).isMenuOpen).toBe(false);

    // closeThread: メニューも閉じたうえで A を「開いている」節から外す
    // (以後は ClosedRow として描画される)。閉じる操作自体はドロワーを閉じない。
    act(() => lastOpenRowProps(OPEN_A.sessionId).actions.closeThread(OPEN_A.sessionId));
    await waitFor(() => expect(lastClosedRowProps(OPEN_A.sessionId).thread.sessionId).toBe(OPEN_A.sessionId));
    expect(readPersistedChatThreads()[PROJECT_A.id]?.activeSessionIds).not.toContain(OPEN_A.sessionId);

    // reopenClosed: 永続化された C を開き直し、選択もそちらへ移し、ドロワーを閉じる
    // (元実装どおり closeThreadDrawer() を含む)。
    act(() => lastClosedRowProps(CLOSED_C.sessionId).actions.reopenClosed(CLOSED_C.sessionId));
    expect(container.querySelector('#chat-thread-drawer')).not.toBeInTheDocument();
    expect(readPersistedChatThreads()[PROJECT_A.id]?.activeSessionIds).toContain(CLOSED_C.sessionId);

    openThreadDrawer(container);
    await waitFor(() => expect(lastOpenRowProps(CLOSED_C.sessionId).isSelected).toBe(true));
  });
});
