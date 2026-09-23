import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// bdboard-sso1.5: このファイルが検証するのは useTicketDetailController /
// useTicketDetailQueries「自体」に新しく書いた組み立てロジック
// (各セクションのフックをどうグループ化して返すか、disabled の合成、
// 各サブフックへ渡す引数) であって、各サブフック自身の内部実装ではない。
// サブフックはすべてモックし、マーカー値で戻り値の組み立てとサブフックへの
// 配線引数を直接検証する。個々のサブフックの挙動は各自の *.test.ts(x) で
// 押さえられている。

vi.mock('./useTicketDetailQueries');
vi.mock('./useTicketAgentRun');
vi.mock('../../hooks/useAutoClearedValue');
vi.mock('./useTicketQuickActions');
vi.mock('./useTicketTitleEditing');
vi.mock('./useTicketDescriptionEditing');
vi.mock('./useTicketLabels');
vi.mock('./useTicketDependencies');
vi.mock('./useTicketComment');
vi.mock('./useTicketSessionLink');
vi.mock('./useTicketFormReset');
vi.mock('../../hooks/useFocusTrap');
vi.mock('./useCommentFocusShortcut');

import { useTicketDetailQueries } from './useTicketDetailQueries';
import { useTicketAgentRun } from './useTicketAgentRun';
import { useAutoClearedValue } from '../../hooks/useAutoClearedValue';
import { useTicketQuickActions } from './useTicketQuickActions';
import { useTicketTitleEditing } from './useTicketTitleEditing';
import { useTicketDescriptionEditing } from './useTicketDescriptionEditing';
import { useTicketLabels } from './useTicketLabels';
import { useTicketDependencies } from './useTicketDependencies';
import { useTicketComment } from './useTicketComment';
import { useTicketSessionLink } from './useTicketSessionLink';
import { useTicketFormReset } from './useTicketFormReset';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useCommentFocusShortcut } from './useCommentFocusShortcut';
import {
  useTicketDetailController,
  type UseTicketDetailControllerParams,
} from './useTicketDetailController';

const queriesMock = vi.mocked(useTicketDetailQueries);
const agentRunMock = vi.mocked(useTicketAgentRun);
const autoClearedMock = vi.mocked(useAutoClearedValue);
const quickActionsMock = vi.mocked(useTicketQuickActions);
const titleMock = vi.mocked(useTicketTitleEditing);
const descriptionMock = vi.mocked(useTicketDescriptionEditing);
const labelsMock = vi.mocked(useTicketLabels);
const dependenciesMock = vi.mocked(useTicketDependencies);
const commentMock = vi.mocked(useTicketComment);
const sessionLinkMock = vi.mocked(useTicketSessionLink);
const formResetMock = vi.mocked(useTicketFormReset);
const focusTrapMock = vi.mocked(useFocusTrap);
const commentFocusShortcutMock = vi.mocked(useCommentFocusShortcut);

const MARK_DATA = {
  id: 'MARK-ticket-id',
  projectId: 'MARK-project-id',
  title: 'MARK-title',
  description: 'MARK-description',
  labels: ['MARK-current-label'],
  commentCount: 5,
} as unknown as NonNullable<ReturnType<typeof useTicketDetailQueries>['data']>;

// onCommentFocusShortcut は呼び出すと KeyboardEvent を要求するので、ここでは
// 「戻り値がこの参照そのものであること (組み立てロジックがそのまま右から左へ
// 受け渡しているか)」を同一性で検証する。
const shortcutHandler = vi.fn();

function setupMocks(overrides: {
  quickActions?: Partial<ReturnType<typeof useTicketQuickActions>>;
  agentRun?: { confirmingAgentRun?: boolean; startRunMutation?: { isPending: boolean } };
} = {}) {
  const queryClient = { invalidateQueries: vi.fn() };
  const undoSnackbar = { MARK: 'undo-snackbar' };
  const decision = { MARK: 'decision', reset: vi.fn() };
  queriesMock.mockReturnValue({
    queryClient,
    undoSnackbar,
    data: MARK_DATA,
    isLoading: false,
    error: null,
    projectRootPath: 'MARK-project-root',
    decision,
    comment: {
      MARK: 'queries-comment',
      commentsEnabled: true,
      shared: 'MARK-from-queries',
    },
    timeline: { MARK: 'timeline' },
    similarTickets: { MARK: 'similar-tickets' },
    inFlightOverlaps: { MARK: 'in-flight-overlaps' },
  } as unknown as ReturnType<typeof useTicketDetailQueries>);

  agentRunMock.mockReturnValue({
    confirmingAgentRun: false,
    startRunMutation: { isPending: false },
    MARK: 'agent-run',
    ...overrides.agentRun,
  } as unknown as ReturnType<typeof useTicketAgentRun>);

  autoClearedMock.mockReturnValue({
    value: { feedback: { kind: 'success', command: 'claim' }, aria: 'MARK-aria' },
    show: vi.fn(),
    hold: vi.fn(),
    clear: vi.fn(),
  });

  quickActionsMock.mockReturnValue({
    mutationPending: false,
    confirmingQuickAction: null,
    reset: vi.fn(),
    MARK: 'quick-actions',
    ...overrides.quickActions,
  } as unknown as ReturnType<typeof useTicketQuickActions>);

  titleMock.mockReturnValue({ MARK: 'title', reset: vi.fn() } as unknown as ReturnType<
    typeof useTicketTitleEditing
  >);
  descriptionMock.mockReturnValue({
    MARK: 'description',
    reset: vi.fn(),
  } as unknown as ReturnType<typeof useTicketDescriptionEditing>);
  labelsMock.mockReturnValue({
    MARK: 'labels',
    reset: vi.fn(),
  } as unknown as ReturnType<typeof useTicketLabels>);
  dependenciesMock.mockReturnValue({
    MARK: 'dependencies',
    reset: vi.fn(),
  } as unknown as ReturnType<typeof useTicketDependencies>);
  commentMock.mockReturnValue({
    MARK: 'comment',
    shared: 'MARK-from-comment',
    reset: vi.fn(),
  } as unknown as ReturnType<typeof useTicketComment>);
  sessionLinkMock.mockReturnValue({
    MARK: 'session-link',
    reset: vi.fn(),
  } as unknown as ReturnType<typeof useTicketSessionLink>);
  formResetMock.mockReturnValue(undefined);
  focusTrapMock.mockReturnValue(undefined);
  commentFocusShortcutMock.mockReturnValue(shortcutHandler);

  return { queryClient, undoSnackbar, decision };
}

function makeParams(
  overrides: Partial<UseTicketDetailControllerParams> = {},
): UseTicketDetailControllerParams {
  return {
    ticketId: 'MARK-ticket-id',
    projectRootPaths: new Map([['MARK-project-id', 'MARK-project-root']]),
    pendingDecision: undefined,
    onClose: vi.fn(),
    onTicketViewed: vi.fn(),
    availableLabels: ['MARK-available-label'],
    panelRef: { current: null },
    closeButtonRef: { current: null },
    commentTextareaRef: { current: null },
    ...overrides,
  };
}

describe('useTicketDetailController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('groups sub-hook return values under the documented keys and passes through the queries groups unchanged', () => {
    const { decision } = setupMocks();
    const params = makeParams();
    const { result } = renderHook(() => useTicketDetailController(params));

    expect(result.current.data).toBe(MARK_DATA);
    expect(result.current.title).toEqual({ MARK: 'title', reset: expect.any(Function) as unknown });
    expect(result.current.description).toEqual({
      MARK: 'description',
      reset: expect.any(Function) as unknown,
    });
    expect(result.current.dependencies).toEqual({
      MARK: 'dependencies',
      reset: expect.any(Function) as unknown,
    });
    expect(result.current.sessionLink).toEqual({
      MARK: 'session-link',
      reset: expect.any(Function) as unknown,
    });
    expect(result.current.decision).toBe(decision);
    expect(result.current.timeline).toEqual({ MARK: 'timeline' });
    expect(result.current.similarTickets).toEqual({ MARK: 'similar-tickets' });
    expect(result.current.inFlightOverlaps).toEqual({ MARK: 'in-flight-overlaps' });
    // labels グループは currentLabels (data.labels からの派生) と
    // useTicketLabels の戻り値を合成したもの。
    expect(result.current.labels).toEqual({
      currentLabels: ['MARK-current-label'],
      MARK: 'labels',
      reset: expect.any(Function) as unknown,
    });
    expect(result.current.onCommentFocusShortcut).toBe(shortcutHandler);
  });

  it('merges queries.comment and useTicketComment with the local hook winning on overlapping keys', () => {
    setupMocks();
    const params = makeParams();
    const { result } = renderHook(() => useTicketDetailController(params));

    // 両方に 'shared' キーがある: {...queries.comment, ...comment} の順で
    // 展開するので、後勝ちの useTicketComment 側の値になるはず。
    expect(result.current.comment).toMatchObject({
      commentsEnabled: true,
      MARK: 'comment',
      shared: 'MARK-from-comment',
    });
  });

  it('computes quickActions.disabled / agentRun.actionsDisabled from the combined flags, overriding any pass-through field with the same key', () => {
    setupMocks();
    const params = makeParams();
    const { result: allFalse } = renderHook(() => useTicketDetailController(params));
    expect(allFalse.current.quickActions.disabled).toBe(false);
    expect(allFalse.current.agentRun.actionsDisabled).toBe(false);

    setupMocks({ quickActions: { mutationPending: true } });
    const { result: mutationPending } = renderHook(() =>
      useTicketDetailController(params),
    );
    // mutationPending は quickActionsDisabled のみに効き、
    // agentRunActionsDisabled の式には含まれない。
    expect(mutationPending.current.quickActions.disabled).toBe(true);
    expect(mutationPending.current.agentRun.actionsDisabled).toBe(false);

    setupMocks({ agentRun: { confirmingAgentRun: true } });
    const { result: confirming } = renderHook(() => useTicketDetailController(params));
    expect(confirming.current.quickActions.disabled).toBe(true);
    expect(confirming.current.agentRun.actionsDisabled).toBe(true);

    setupMocks({ agentRun: { startRunMutation: { isPending: true } } });
    const { result: pending } = renderHook(() => useTicketDetailController(params));
    expect(pending.current.quickActions.disabled).toBe(true);
    expect(pending.current.agentRun.actionsDisabled).toBe(true);
  });

  it('wires the panel refs into useFocusTrap/useCommentFocusShortcut and calls each sub-hook with the documented arguments', () => {
    setupMocks();
    const params = makeParams();
    renderHook(() => useTicketDetailController(params));

    expect(agentRunMock).toHaveBeenCalledWith(
      'MARK-ticket-id',
      MARK_DATA,
      'MARK-project-root',
    );
    expect(quickActionsMock).toHaveBeenCalledWith(
      'MARK-ticket-id',
      MARK_DATA,
      expect.objectContaining({ MARK: 'undo-snackbar' }) as unknown,
    );
    expect(titleMock).toHaveBeenCalledWith('MARK-ticket-id', 'MARK-title');
    expect(descriptionMock).toHaveBeenCalledWith(
      'MARK-ticket-id',
      true,
      'MARK-description',
    );
    expect(labelsMock).toHaveBeenCalledWith(
      'MARK-ticket-id',
      ['MARK-current-label'],
      ['MARK-available-label'],
    );
    expect(dependenciesMock).toHaveBeenCalledWith('MARK-ticket-id', MARK_DATA);
    expect(commentMock).toHaveBeenCalledWith('MARK-ticket-id');
    expect(sessionLinkMock).toHaveBeenCalledWith('MARK-ticket-id');

    expect(focusTrapMock).toHaveBeenCalledWith({
      containerRef: params.panelRef,
      initialFocusRef: params.closeButtonRef,
      onEscape: params.onClose,
      enabled: true,
    });
    expect(commentFocusShortcutMock).toHaveBeenCalledWith({
      textareaRef: params.commentTextareaRef,
      disabled: false,
    });
    expect(formResetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketId: 'MARK-ticket-id',
        projectRootPath: 'MARK-project-root',
      }) as unknown,
    );
  });
});
