// bdboard-sso1.65: useBulkActions.ts から切り出した useBulkConfirmDispatch の
// kind 分岐を直接検証する。BulkActionConfirmPanel の onConfirm は1つしか無く、
// confirmingAction.kind によって bulkLabelMutation/bulkMutation のどちらを
// 呼ぶかを分岐する (#623 のコメント参照)。ここではその分岐そのものと、
// 対象0件のときに mutate を呼ばない早期リターンを確認する。
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardCardDto } from '../../../api';
import type { useBulkLabelAction } from '../actions/useBulkLabelAction';
import type { useBulkQuickAction } from '../actions/useBulkQuickAction';
import { useBulkConfirmDispatch } from './useBulkConfirmDispatch';

function makeCard(id: string, priority = 2): BoardCardDto {
  return {
    ticket: {
      id,
      projectId: 'proj-1',
      title: `Ticket ${id}`,
      status: 'open',
      priority,
      issueType: 'task',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      commentCount: 0,
    },
    lane: 'ready',
    projectId: 'proj-1',
    blockedBy: [],
    blocks: [],
    unblocksCount: 0,
    liveness: null,
    sessions: [],
    stalled: false,
    epicProgress: null,
    deferDays: null,
    deferUrgency: null,
    effectivePriority: priority,
    priorityInheritedFrom: null,
  };
}

const bulkMutate = vi.fn();
const bulkLabelMutate = vi.fn();

const bulkMutation = {
  mutate: bulkMutate,
} as unknown as ReturnType<typeof useBulkQuickAction>['bulkMutation'];

const bulkLabelMutation = {
  mutate: bulkLabelMutate,
} as unknown as ReturnType<typeof useBulkLabelAction>['bulkLabelMutation'];

describe('useBulkConfirmDispatch', () => {
  beforeEach(() => {
    bulkMutate.mockReset();
    bulkLabelMutate.mockReset();
  });

  it('does nothing when there is no confirming action', () => {
    const { result } = renderHook(() =>
      useBulkConfirmDispatch({
        confirmingAction: null,
        selectedIds: new Set(['bd-1']),
        cardsById: new Map([['bd-1', makeCard('bd-1')]]),
        closeReason: '',
        bulkMutation,
        bulkLabelMutation,
      }),
    );

    act(() => {
      result.current.handleConfirm();
    });

    expect(bulkMutate).not.toHaveBeenCalled();
    expect(bulkLabelMutate).not.toHaveBeenCalled();
  });

  it('dispatches to bulkLabelMutation for kind "add-label", limited to ids present on the board', () => {
    const cardsById = new Map([['bd-1', makeCard('bd-1')]]);
    const { result } = renderHook(() =>
      useBulkConfirmDispatch({
        confirmingAction: { kind: 'add-label', label: 'urgent' },
        selectedIds: new Set(['bd-1', 'bd-missing']),
        cardsById,
        closeReason: '',
        bulkMutation,
        bulkLabelMutation,
      }),
    );

    act(() => {
      result.current.handleConfirm();
    });

    expect(bulkLabelMutate).toHaveBeenCalledWith({ label: 'urgent', ids: ['bd-1'] });
    expect(bulkMutate).not.toHaveBeenCalled();
  });

  it('does not call bulkLabelMutation when none of the selected ids are on the board', () => {
    const { result } = renderHook(() =>
      useBulkConfirmDispatch({
        confirmingAction: { kind: 'add-label', label: 'urgent' },
        selectedIds: new Set(['bd-missing']),
        cardsById: new Map(),
        closeReason: '',
        bulkMutation,
        bulkLabelMutation,
      }),
    );

    act(() => {
      result.current.handleConfirm();
    });

    expect(bulkLabelMutate).not.toHaveBeenCalled();
  });

  it('dispatches to bulkMutation for other kinds, building targets from selected cards', () => {
    const cardsById = new Map([['bd-1', makeCard('bd-1', 2)]]);
    const { result } = renderHook(() =>
      useBulkConfirmDispatch({
        confirmingAction: { kind: 'close' },
        selectedIds: new Set(['bd-1']),
        cardsById,
        closeReason: '見直しのため',
        bulkMutation,
        bulkLabelMutation,
      }),
    );

    act(() => {
      result.current.handleConfirm();
    });

    expect(bulkMutate).toHaveBeenCalledWith({
      action: { kind: 'close' },
      targets: [
        {
          id: 'bd-1',
          request: { action: 'close', reason: '見直しのため' },
        },
      ],
    });
    expect(bulkLabelMutate).not.toHaveBeenCalled();
  });

  it('does not call bulkMutation when no card is eligible (e.g. priority-up at priority 0)', () => {
    const cardsById = new Map([['bd-1', makeCard('bd-1', 0)]]);
    const { result } = renderHook(() =>
      useBulkConfirmDispatch({
        confirmingAction: { kind: 'priority-up' },
        selectedIds: new Set(['bd-1']),
        cardsById,
        closeReason: '',
        bulkMutation,
        bulkLabelMutation,
      }),
    );

    act(() => {
      result.current.handleConfirm();
    });

    expect(bulkMutate).not.toHaveBeenCalled();
  });
});
