import { describe, expect, it } from 'vitest';
import { planQuickActionUndo } from './quickActionUndo';

describe('planQuickActionUndo', () => {
  it('maps claim to an unclaim undo request', () => {
    const plan = planQuickActionUndo({ action: 'claim' });

    expect(plan).toEqual({
      message: '着手しました',
      undoRequest: { action: 'claim' },
    });
  });

  it('maps close to a reopen undo request', () => {
    const plan = planQuickActionUndo({ action: 'close', reason: 'shipped' });

    expect(plan).toEqual({
      message: '完了にしました',
      undoRequest: { action: 'close' },
    });
  });

  it('maps defer to an undefer undo request', () => {
    const plan = planQuickActionUndo({
      action: 'defer',
      untilDate: '2026-08-22',
    });

    expect(plan).toEqual({
      message: '延期しました',
      undoRequest: { action: 'defer' },
    });
  });

  it('maps priority to a restore-previous-value undo request when previousPriority is known', () => {
    const plan = planQuickActionUndo({ action: 'priority', priority: 1 }, 3);

    expect(plan).toEqual({
      message: '優先度を P1 に変更しました',
      undoRequest: {
        action: 'priority',
        previousPriority: 3,
        expectedCurrentPriority: 1,
      },
    });
  });

  it('returns null for priority when previousPriority is unknown, instead of guessing', () => {
    const plan = planQuickActionUndo({ action: 'priority', priority: 1 });

    expect(plan).toBeNull();
  });

  it('maps undefer to a re-defer undo request when previousDeferUntil is known', () => {
    const plan = planQuickActionUndo(
      { action: 'undefer' },
      undefined,
      '2026-08-10',
    );

    expect(plan).toEqual({
      message: '保留を解除しました',
      undoRequest: { action: 'undefer', untilDate: '2026-08-10' },
    });
  });

  it('returns null for undefer when previousDeferUntil is unknown', () => {
    const plan = planQuickActionUndo({ action: 'undefer' });

    expect(plan).toBeNull();
  });
});
