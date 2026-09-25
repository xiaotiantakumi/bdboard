// bdboard-sso1.83 第15b段の「先に足すもの」: ChatPanel のフック配線を controller
// (chat/useChatPanelController.ts とその分割先)へ移す前に、ChatPanel が直接呼ぶ
// フックの呼び出し順を今の main に対して固定する(設計書 §4b-1/2 の「登録順は
// 変えない」を、レビューの目視だけでなくテストでも押さえる)。
// - 各フックのモジュールを vi.mock で包み、呼ばれた順に名前を記録する(本体は
//   元の実装をそのまま呼ぶので、挙動は変わらない)。
// - 1回目の render の並びが下の EXPECTED_HOOK_ORDER と一致すること、以後の
//   再レンダー(effect による state 更新、ドロワーの開閉、入力)でも毎回同じ
//   並びで呼ばれること(条件付きのフック呼び出しが無いこと)を見る。
// - ChatPanel が react から直接呼ぶ useRef / useState / useEffect / useCallback も、
//   react を包んで数える。どのファイルから呼ばれたかはスタックの呼び出し元で見分け、
//   ChatPanel.tsx(と、第15b段の移動先 chat/useChatPanel*.ts)から呼ばれたものだけを
//   記録する(ほかのフックの中の react 呼び出しは数えない)。
// vi.mock はファイル単位でホイストされるため、他の ChatPanel.*.test.tsx と同じ
// vi.mock('../api', ...) ブロックを複製している。

import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatAgentDto, ChatThreadDto, ChatTurnStatusDto } from '../api';
import { installFakeHistory } from '../test/fakeHistory';

const { hookLog, wrapHooks, wrapReactHook } = vi.hoisted(() => {
  const hookLog: string[] = [];
  const wrapHooks = <T extends object>(actual: T, names: readonly (keyof T & string)[]): T => {
    const wrapped = { ...actual } as Record<string, unknown>;
    for (const name of names) {
      const original = actual[name] as (...args: unknown[]) => unknown;
      wrapped[name] = (...args: unknown[]) => {
        hookLog.push(name);
        return original(...args);
      };
    }
    return wrapped as T;
  };
  /** ChatPanel.tsx か chat/useChatPanel*.ts から直接呼ばれた react のフックだけを記録する。 */
  const wrapReactHook = <F extends (...args: never[]) => unknown>(kind: string, original: F): F =>
    ((...args: Parameters<F>) => {
      const caller = new Error().stack?.split('\n')[2] ?? '';
      if (/[/\\](ChatPanel\.tsx|useChatPanel\w*\.ts)\b/.test(caller)) {
        hookLog.push(kind);
      }
      return original(...args);
    }) as F;
  return { hookLog, wrapHooks, wrapReactHook };
});

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useRef: wrapReactHook('useRef', actual.useRef),
    useState: wrapReactHook('useState', actual.useState),
    useEffect: wrapReactHook('useEffect', actual.useEffect),
    useCallback: wrapReactHook('useCallback', actual.useCallback),
  };
});

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
vi.mock('./PlatformLimitationNotice', async (importOriginal) =>
  wrapHooks(await importOriginal<typeof import('./PlatformLimitationNotice')>(), ['usePlatformLimitation']));
vi.mock('../hooks/useFocusTrap', async (importOriginal) =>
  wrapHooks(await importOriginal<typeof import('../hooks/useFocusTrap')>(), ['useFocusTrap']));
vi.mock('../hooks/useHistoryBackClose', async (importOriginal) =>
  wrapHooks(await importOriginal<typeof import('../hooks/useHistoryBackClose')>(), ['useHistoryBackClose']));
vi.mock('../hooks/useResizableSidePanel', async (importOriginal) =>
  wrapHooks(await importOriginal<typeof import('../hooks/useResizableSidePanel')>(), ['useResizableSidePanel']));
vi.mock('./chat/useChatConversationsState', async (importOriginal) =>
  wrapHooks(await importOriginal<typeof import('./chat/useChatConversationsState')>(), ['useChatConversationsState']));
vi.mock('./chat/useConversationKey', async (importOriginal) =>
  wrapHooks(await importOriginal<typeof import('./chat/useConversationKey')>(), ['useConversationKey']));
vi.mock('./chat/useChatSendState', async (importOriginal) =>
  wrapHooks(await importOriginal<typeof import('./chat/useChatSendState')>(), ['useChatSendState']));
vi.mock('./chat/useThreadDrawerState', async (importOriginal) =>
  wrapHooks(await importOriginal<typeof import('./chat/useThreadDrawerState')>(), ['useThreadDrawerState']));
vi.mock('./chat/useChatNotifications', async (importOriginal) =>
  wrapHooks(await importOriginal<typeof import('./chat/useChatNotifications')>(), ['useChatNotifications']));
vi.mock('./chat/useChatThreadLists', async (importOriginal) =>
  wrapHooks(await importOriginal<typeof import('./chat/useChatThreadLists')>(), ['useChatThreadLists']));
vi.mock('./chat/useChatDraftState', async (importOriginal) =>
  wrapHooks(await importOriginal<typeof import('./chat/useChatDraftState')>(), ['useChatDraftState']));
vi.mock('./chat/useElapsedSeconds', async (importOriginal) =>
  wrapHooks(await importOriginal<typeof import('./chat/useElapsedSeconds')>(), ['useElapsedSeconds']));
vi.mock('./chat/useChatAgentModelState', async (importOriginal) =>
  wrapHooks(await importOriginal<typeof import('./chat/useChatAgentModelState')>(), ['useChatAgentModelState']));
vi.mock('./chat/useDraftPayloadRegistry', async (importOriginal) =>
  wrapHooks(await importOriginal<typeof import('./chat/useDraftPayloadRegistry')>(), ['useDraftPayloadRegistry']));
vi.mock('./chat/useDraftThreadLauncher', async (importOriginal) =>
  wrapHooks(await importOriginal<typeof import('./chat/useDraftThreadLauncher')>(), ['useDraftThreadLauncher']));
vi.mock('./chat/useAgentFromConversationSync', async (importOriginal) =>
  wrapHooks(await importOriginal<typeof import('./chat/useAgentFromConversationSync')>(), ['useAgentFromConversationSync']));
vi.mock('./chat/useAbortOnConversationChange', async (importOriginal) =>
  wrapHooks(await importOriginal<typeof import('./chat/useAbortOnConversationChange')>(), ['useAbortOnConversationChange']));
vi.mock('./chat/useColdKeyspaceAdoption', async (importOriginal) =>
  wrapHooks(await importOriginal<typeof import('./chat/useColdKeyspaceAdoption')>(), ['useColdKeyspaceAdoption']));
vi.mock('./chat/useThreadListSync', async (importOriginal) =>
  wrapHooks(await importOriginal<typeof import('./chat/useThreadListSync')>(), ['useThreadListSync']));
vi.mock('./chat/useChatSessionLifecycle', async (importOriginal) =>
  wrapHooks(await importOriginal<typeof import('./chat/useChatSessionLifecycle')>(), ['useChatSessionLifecycle']));
vi.mock('./chat/useTurnStatusRecovery', async (importOriginal) =>
  wrapHooks(await importOriginal<typeof import('./chat/useTurnStatusRecovery')>(), ['useTurnStatusRecovery']));
vi.mock('./chat/useTicketContextLaunch', async (importOriginal) =>
  wrapHooks(await importOriginal<typeof import('./chat/useTicketContextLaunch')>(), ['useTicketContextLaunch']));
vi.mock('./chat/useAgentListAndModelRestore', async (importOriginal) =>
  wrapHooks(await importOriginal<typeof import('./chat/useAgentListAndModelRestore')>(), ['useAgentListAndModelRestore']));
vi.mock('./chat/useChatHistoryLoader', async (importOriginal) =>
  wrapHooks(await importOriginal<typeof import('./chat/useChatHistoryLoader')>(), ['useChatHistoryLoader']));
vi.mock('./chat/useStickToBottomScroll', async (importOriginal) =>
  wrapHooks(await importOriginal<typeof import('./chat/useStickToBottomScroll')>(), ['useStickToBottomScroll']));
vi.mock('./chat/useChatSendCommits', async (importOriginal) =>
  wrapHooks(await importOriginal<typeof import('./chat/useChatSendCommits')>(), ['useChatSendCommits']));
vi.mock('./chat/useChatSubmit', async (importOriginal) =>
  wrapHooks(await importOriginal<typeof import('./chat/useChatSubmit')>(), ['useChatSubmit']));

import {
  acknowledgeChatTurn,
  fetchChatAgents,
  fetchChatThreads,
  fetchChatTurnStatus,
  fetchDiscoveredChatSessions,
  fetchPlatformSupport,
} from '../api';
import { resetPlatformSupportCache } from './PlatformLimitationNotice';
import { PROJECT_A, PROJECT_B, openThreadDrawer, renderChatPanel } from './ChatPanel-test-support';


/**
 * 設計書 §1c の登録順(H1 = usePlatformLimitation、E1 = useElapsedSeconds、
 * H2 = useChatAgentModelState 内の usePersistedState、H3 = useHistoryBackClose、
 * H4/H5 = useFocusTrap ×2、E3〜E15)を、ChatPanel が直接呼ぶフックの単位で並べたもの。
 */
const EXPECTED_HOOK_ORDER = [
  'useRef', // panelRef
  'useRef', // closeButtonRef
  'useRef', // threadDrawerRef
  'useRef', // threadDrawerCloseButtonRef
  'useRef', // messagesRef
  'useRef', // inputRef
  'useRef', // fileInputRef
  'useRef', // formRef
  'useState', // selectedProjectId
  'useChatConversationsState',
  'useConversationKey',
  'useChatSendState',
  'useThreadDrawerState',
  'useChatNotifications',
  'useChatThreadLists',
  'useChatDraftState',
  'usePlatformLimitation', // H1
  'useElapsedSeconds', // E1
  'useChatAgentModelState', // H2
  'useResizableSidePanel',
  'useState', // isChatPanelMaximized
  'useDraftPayloadRegistry',
  'useDraftThreadLauncher',
  'useHistoryBackClose', // H3
  'useFocusTrap', // H4(パネル)
  'useFocusTrap', // H5(ドロワー)
  'useAgentFromConversationSync', // E3
  'useAbortOnConversationChange', // E4
  'useEffect', // E5(onProjectIdChange)
  'useColdKeyspaceAdoption', // E6
  'useThreadListSync', // E7
  'useChatSessionLifecycle',
  'useTurnStatusRecovery', // E8
  'useTicketContextLaunch', // E9
  'useAgentListAndModelRestore', // E10 + E11
  'useChatHistoryLoader', // E12 + E13
  'useStickToBottomScroll', // E14 + E15
  'useChatSendCommits',
  'useChatSubmit',
  'useCallback', // handleQuickCommand
];

/** 記録を1レンダーぶん(EXPECTED_HOOK_ORDER の長さ)ずつに切る。 */
function splitIntoRenders(log: readonly string[]): string[][] {
  const renders: string[][] = [];
  for (let start = 0; start < log.length; start += EXPECTED_HOOK_ORDER.length) {
    renders.push(log.slice(start, start + EXPECTED_HOOK_ORDER.length));
  }
  return renders;
}

describe('ChatPanel hook call order (bdboard-sso1.83 第15b段の前提)', () => {
  beforeEach(() => {
    hookLog.length = 0;
    installFakeHistory({});
    localStorage.clear();
    resetPlatformSupportCache();
    vi.mocked(fetchPlatformSupport).mockResolvedValue({ platform: 'darwin', limitations: [] });
    vi.mocked(fetchChatAgents).mockResolvedValue([]);
    vi.mocked(fetchChatThreads).mockResolvedValue([]);
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

  it('calls its hooks in the registration order of design doc §1c on the first render', () => {
    renderChatPanel([PROJECT_A, PROJECT_B], { initialProjectId: 'proj-a', leaveSettingsCollapsed: true });

    expect(splitIntoRenders(hookLog)[0]).toEqual(EXPECTED_HOOK_ORDER);
  });

  it('calls the same hooks in the same order on every re-render', async () => {
    const user = userEvent.setup();
    const { container } = renderChatPanel([PROJECT_A, PROJECT_B], { initialProjectId: 'proj-a' });
    await waitFor(() => {
      expect(screen.getByLabelText('対象プロジェクト')).toHaveValue('proj-a');
    });

    openThreadDrawer(container);
    await user.keyboard('{Escape}');
    await user.type(screen.getByRole('textbox', { name: 'メッセージ' }), 'ab');
    await user.selectOptions(screen.getByLabelText('対象プロジェクト'), 'proj-b');

    const renders = splitIntoRenders(hookLog);
    expect(renders.length).toBeGreaterThan(4);
    expect(hookLog.length % EXPECTED_HOOK_ORDER.length).toBe(0);
    for (const render of renders) {
      expect(render).toEqual(EXPECTED_HOOK_ORDER);
    }
  });
});
