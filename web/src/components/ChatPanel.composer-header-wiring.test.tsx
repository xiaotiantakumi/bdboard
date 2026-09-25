// bdboard-sso1.83 第7段: ChatComposer/ChatPanelHeader 抽出時の配線テスト。
// #654 のレビューで「スカラーだけのモックでは配線ミスを見逃す」と指摘された教訓
// (#674 の thread-drawer-row-wiring と同じ手法)に従い、2つの presentational
// コンポーネントを vi.mock で差し替え、vi.mocked(X).mock.calls で実際に渡された
// props(スカラーだけでなく quickCommands/notices/actions オブジェクトの各関数)
// を検証する。区別可能なマーカー文字列/ファイル名を各テストの入力に使い、
// ChatPanel 側の本物のハンドラ(setInput/applyQuickCommandPrompt/
// handleImageFileChange/setIsChatPanelMaximized/requestClose)まで配線されて
// いる(スタブで終わっていない)ことを確認する。
import type { ChangeEvent } from 'react';
import { act, cleanup, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatAgentDto, ChatThreadDto, ChatTurnStatusDto } from '../api';
import { installFakeHistory } from '../test/fakeHistory';
import { CHAT_QUICK_COMMANDS } from '../chatQuickCommands';

vi.mock('./chat/ChatComposer', () => ({
  ChatComposer: vi.fn(() => null),
}));
vi.mock('./chat/ChatPanelHeader', () => ({
  ChatPanelHeader: vi.fn(() => null),
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
  fetchPlatformSupport,
} from '../api';
import { resetPlatformSupportCache } from './PlatformLimitationNotice';
import { ChatComposer } from './chat/ChatComposer';
import { ChatPanelHeader } from './chat/ChatPanelHeader';
import {
  PROJECT_A,
  CODEX_IMAGE_AGENT,
  makeFileList,
  makeImageFile,
  renderChatPanel,
} from './ChatPanel-test-support';

const fetchChatAgentsMock = vi.mocked(fetchChatAgents);
const fetchChatThreadsMock = vi.mocked(fetchChatThreads);
const fetchChatTurnStatusMock = vi.mocked(fetchChatTurnStatus);
const fetchPlatformSupportMock = vi.mocked(fetchPlatformSupport);
const composerMock = vi.mocked(ChatComposer);
const headerMock = vi.mocked(ChatPanelHeader);

function lastComposerProps() {
  const call = composerMock.mock.calls.at(-1);
  if (call === undefined) throw new Error('ChatComposer was never rendered');
  return call[0];
}

function lastHeaderProps() {
  const call = headerMock.mock.calls.at(-1);
  if (call === undefined) throw new Error('ChatPanelHeader was never rendered');
  return call[0];
}

describe('ChatPanel composer/header wiring (bdboard-sso1.83 第7段)', () => {
  beforeEach(() => {
    installFakeHistory({});
    localStorage.clear();
    resetPlatformSupportCache();
    fetchPlatformSupportMock.mockResolvedValue({ platform: 'darwin', limitations: [] });
    fetchChatAgentsMock.mockResolvedValue([CODEX_IMAGE_AGENT]);
    fetchChatThreadsMock.mockResolvedValue([]);
    fetchChatTurnStatusMock.mockResolvedValue({ state: 'idle' });
  });

  afterEach(() => {
    // bdboard-1ga8 と同じ作法: モックを reset する前にアンマウントし、E8 のポーリングが
    // 次のテストへ持ち越されないようにする。
    try {
      cleanup();
    } finally {
      vi.resetAllMocks();
      vi.restoreAllMocks();
    }
  });

  it('wires ChatPanelHeader maximize toggle to the real panel width state, and close to the real requestClose (marker: header)', async () => {
    const { onClose, container } = renderChatPanel([PROJECT_A]);
    await waitFor(() => expect(headerMock).toHaveBeenCalled());

    expect(lastHeaderProps().isMaximized).toBe(false);
    const panel = container.querySelector('.chat-panel');
    expect(panel).not.toBeNull();
    expect(panel?.className).not.toContain('is-maximized');

    act(() => {
      lastHeaderProps().onToggleMaximize();
    });
    expect(lastHeaderProps().isMaximized).toBe(true);
    expect(panel?.className).toContain('is-maximized');

    expect(onClose).not.toHaveBeenCalled();
    act(() => {
      lastHeaderProps().onClose();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('wires ChatComposer textarea value/onChange to the real draft state for the current conversation (marker: composer-input)', async () => {
    renderChatPanel([PROJECT_A]);
    await waitFor(() => expect(composerMock).toHaveBeenCalled());
    expect(lastComposerProps().value).toBe('');

    act(() => {
      lastComposerProps().onChange({
        target: { value: 'stage7-marker-hello' },
      } as unknown as ChangeEvent<HTMLTextAreaElement>);
    });

    expect(lastComposerProps().value).toBe('stage7-marker-hello');
  });

  it('wires ChatComposer quickCommands.onQuickCommand to the real prefill handler (marker: composer-quick-command)', async () => {
    renderChatPanel([PROJECT_A]);
    await waitFor(() => expect(composerMock).toHaveBeenCalled());
    const command = CHAT_QUICK_COMMANDS[0];
    if (command === undefined) throw new Error('no quick commands defined');

    act(() => {
      lastComposerProps().quickCommands.onQuickCommand(command);
    });

    expect(lastComposerProps().value).toBe(command.prompt);
  });

  it('wires ChatComposer actions.onImageFileChange to real attachment ingestion (marker: composer-image)', async () => {
    renderChatPanel([PROJECT_A]);
    await waitFor(() => expect(composerMock).toHaveBeenCalled());

    const file = makeImageFile('stage7-marker.png');
    act(() => {
      lastComposerProps().actions.onImageFileChange({
        target: { files: makeFileList([file]) },
      } as unknown as ChangeEvent<HTMLInputElement>);
    });

    await waitFor(() =>
      expect(lastComposerProps().notices.attachments.map((attachment) => attachment.name)).toContain(
        'stage7-marker.png',
      ),
    );
  });

  it('computes actions.submitDisabled from the real input/attachment state (marker: composer-submit-disabled)', async () => {
    renderChatPanel([PROJECT_A]);
    await waitFor(() => expect(composerMock).toHaveBeenCalled());

    // 入力も添付も無い最初は送信ボタンが無効。
    expect(lastComposerProps().actions.submitDisabled).toBe(true);

    act(() => {
      lastComposerProps().onChange({
        target: { value: 'stage7-marker-submit' },
      } as unknown as ChangeEvent<HTMLTextAreaElement>);
    });

    expect(lastComposerProps().actions.submitDisabled).toBe(false);
  });

  it('computes actions.ariaDescribedBy from the real project/agent hint ids (marker: composer-aria-describedby)', async () => {
    // projectSelectionHintId/agentUnavailableHintId の組み立て(joinDescribedBy)
    // が、引数の入れ替えや脱落なく ChatComposer まで配線されていることを
    // 確認する。プロジェクト未選択(複数プロジェクトで initialProjectId 未指定)
    // では projectSelectionHintId だけが立つ。
    renderChatPanel([PROJECT_A, { ...PROJECT_A, id: 'proj-b', name: 'Project B' }]);
    await waitFor(() => expect(composerMock).toHaveBeenCalled());

    expect(lastComposerProps().actions.ariaDescribedBy).toBe('chat-project-unselected-hint');
  });
});
