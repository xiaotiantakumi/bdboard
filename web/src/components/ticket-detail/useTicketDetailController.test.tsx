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
  const decisionReset = vi.fn();
  const decision = { MARK: 'decision', reset: decisionReset };
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

  const autoClearedClear = vi.fn();
  autoClearedMock.mockReturnValue({
    value: { feedback: { kind: 'success', command: 'claim' }, aria: 'MARK-aria' },
    show: vi.fn(),
    hold: vi.fn(),
    clear: autoClearedClear,
  });

  const quickActionsReset = vi.fn();
  quickActionsMock.mockReturnValue({
    mutationPending: false,
    confirmingQuickAction: null,
    reset: quickActionsReset,
    MARK: 'quick-actions',
    ...overrides.quickActions,
  } as unknown as ReturnType<typeof useTicketQuickActions>);

  const titleReset = vi.fn();
  titleMock.mockReturnValue({ MARK: 'title', reset: titleReset } as unknown as ReturnType<
    typeof useTicketTitleEditing
  >);
  const descriptionReset = vi.fn();
  descriptionMock.mockReturnValue({
    MARK: 'description',
    reset: descriptionReset,
  } as unknown as ReturnType<typeof useTicketDescriptionEditing>);
  const labelsReset = vi.fn();
  labelsMock.mockReturnValue({
    MARK: 'labels',
    reset: labelsReset,
  } as unknown as ReturnType<typeof useTicketLabels>);
  const dependenciesReset = vi.fn();
  dependenciesMock.mockReturnValue({
    MARK: 'dependencies',
    reset: dependenciesReset,
  } as unknown as ReturnType<typeof useTicketDependencies>);
  const commentReset = vi.fn();
  commentMock.mockReturnValue({
    MARK: 'comment',
    shared: 'MARK-from-comment',
    reset: commentReset,
  } as unknown as ReturnType<typeof useTicketComment>);
  const sessionLinkReset = vi.fn();
  sessionLinkMock.mockReturnValue({
    MARK: 'session-link',
    reset: sessionLinkReset,
  } as unknown as ReturnType<typeof useTicketSessionLink>);
  formResetMock.mockReturnValue(undefined);
  focusTrapMock.mockReturnValue(undefined);
  commentFocusShortcutMock.mockReturnValue(shortcutHandler);

  return {
    queryClient,
    undoSnackbar,
    decision,
    decisionReset,
    autoClearedClear,
    quickActionsReset,
    titleReset,
    descriptionReset,
    labelsReset,
    dependenciesReset,
    commentReset,
    sessionLinkReset,
  };
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
    // panelRef/closeButtonRef/commentTextareaRef はすべて { current: null } だと
    // toHaveBeenCalledWith が構造的に等しいと見なすため、useFocusTrap の
    // containerRef<->initialFocusRef 取り違えや useCommentFocusShortcut への
    // panelRef誤配線が検出できない (opus レビュー2巡目 finding A)。各 ref に
    // 固有の current を入れて区別できるようにする(モック越しなので実要素は不要)。
    panelRef: { current: 'MARK-panel-ref' as unknown as HTMLDivElement | null },
    closeButtonRef: {
      current: 'MARK-close-button-ref' as unknown as HTMLButtonElement | null,
    },
    commentTextareaRef: {
      current: 'MARK-comment-textarea-ref' as unknown as HTMLTextAreaElement | null,
    },
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

  it('computes quickActions.disabled / agentRun.actionsDisabled from the combined flags (each flag exercised in isolation, including confirmingQuickAction)', () => {
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

    // confirmingQuickAction !== null は quickActionsDisabled と
    // agentRunActionsDisabled の両方の式に含まれる。
    setupMocks({ quickActions: { confirmingQuickAction: { kind: 'claim' } } });
    const { result: confirmingQuickAction } = renderHook(() =>
      useTicketDetailController(params),
    );
    expect(confirmingQuickAction.current.quickActions.disabled).toBe(true);
    expect(confirmingQuickAction.current.agentRun.actionsDisabled).toBe(true);

    setupMocks({ agentRun: { confirmingAgentRun: true } });
    const { result: confirming } = renderHook(() => useTicketDetailController(params));
    expect(confirming.current.quickActions.disabled).toBe(true);
    expect(confirming.current.agentRun.actionsDisabled).toBe(true);

    setupMocks({ agentRun: { startRunMutation: { isPending: true } } });
    const { result: pending } = renderHook(() => useTicketDetailController(params));
    expect(pending.current.quickActions.disabled).toBe(true);
    expect(pending.current.agentRun.actionsDisabled).toBe(true);
  });

  it('calls useTicketDetailQueries with the documented arguments, including the onTicketViewed reference', () => {
    setupMocks();
    const params = makeParams();
    renderHook(() => useTicketDetailController(params));

    expect(queriesMock).toHaveBeenCalledWith({
      ticketId: 'MARK-ticket-id',
      projectRootPaths: params.projectRootPaths,
      pendingDecision: params.pendingDecision,
      onTicketViewed: params.onTicketViewed,
    });
  });

  it('sources the copy group values from useAutoClearedValue, not from a different mock', () => {
    setupMocks();
    const params = makeParams();
    const { result } = renderHook(() => useTicketDetailController(params));

    expect(result.current.copy.copyFeedback).toEqual({ kind: 'success', command: 'claim' });
    expect(result.current.copy.ariaLiveMessage).toBe('MARK-aria');
    expect(result.current.copy.handleCopyCommand).toEqual(expect.any(Function) as unknown);
    expect(result.current.copy.handleCopyNextStep).toEqual(expect.any(Function) as unknown);
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
  });

  it('drives useFocusTrap.enabled and useCommentFocusShortcut.disabled from confirmingQuickAction / confirmingAgentRun', () => {
    const params = makeParams();

    setupMocks({ quickActions: { confirmingQuickAction: { kind: 'claim' } } });
    renderHook(() => useTicketDetailController(params));
    expect(focusTrapMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false }) as unknown,
    );
    expect(commentFocusShortcutMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ disabled: true }) as unknown,
    );

    setupMocks({ agentRun: { confirmingAgentRun: true } });
    renderHook(() => useTicketDetailController(params));
    expect(focusTrapMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false }) as unknown,
    );
    expect(commentFocusShortcutMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ disabled: true }) as unknown,
    );
  });

  it('binds every useTicketFormReset reset*/clear callback to the matching sub-hook mock reference', () => {
    const {
      decisionReset,
      autoClearedClear,
      quickActionsReset,
      titleReset,
      descriptionReset,
      labelsReset,
      dependenciesReset,
      commentReset,
      sessionLinkReset,
    } = setupMocks();
    const params = makeParams();
    renderHook(() => useTicketDetailController(params));

    expect(formResetMock).toHaveBeenCalledWith({
      ticketId: 'MARK-ticket-id',
      projectRootPath: 'MARK-project-root',
      clearCopyDisplay: autoClearedClear,
      resetDecision: decisionReset,
      resetQuickActions: quickActionsReset,
      resetComment: commentReset,
      resetDependencies: dependenciesReset,
      resetLabelInput: labelsReset,
      resetTitleEditing: titleReset,
      resetDescriptionEditing: descriptionReset,
      resetSessionLink: sessionLinkReset,
    });
  });
});
