import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { BoardCardDto } from '../../api';
import { useLaneCardPaging } from './useLaneCardPaging';
import { PAGE_SIZE } from './constants';

function makeCard(id: string): BoardCardDto {
  return {
    ticket: {
      id,
      projectId: 'proj-1',
      title: id,
      status: 'open',
      priority: 2,
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
    effectivePriority: 2,
    priorityInheritedFrom: null,
  };
}

function makeCards(count: number): BoardCardDto[] {
  return Array.from({ length: count }, (_, i) => makeCard(`ticket-${i}`));
}

// レーンの表示件数管理(useState + slice)とキーボードナビ登録(useEffect)を束ねる
// フックの単体テスト。登録先 BoardKeyboardNavProvider との実結線(registerLane が
// 呼ばれ getCardNavProps がそれを反映すること)は、このフックを内部で使う
// LaneColumn 経由で BoardKeyboardNav.test.tsx / LaneColumn.test.tsx (いずれも
// 無変更) が既にカバーしている。ここではページング状態そのものと、
// provider 不在時 (boardNav === null) に例外なく動作することを検証する。
describe('useLaneCardPaging', () => {
  it('shows only the first PAGE_SIZE cards and reports the remaining count', () => {
    const cards = makeCards(PAGE_SIZE + 10);
    const { result } = renderHook(() =>
      useLaneCardPaging('ready', cards, false),
    );

    expect(result.current.visibleCards).toHaveLength(PAGE_SIZE);
    expect(result.current.remaining).toBe(10);
  });

  it('shows all cards when there are fewer than PAGE_SIZE (remaining goes negative, matching the original un-clamped computation)', () => {
    const cards = makeCards(5);
    const { result } = renderHook(() =>
      useLaneCardPaging('ready', cards, false),
    );

    expect(result.current.visibleCards).toHaveLength(5);
    // remaining = cards.length - visibleCount = 5 - PAGE_SIZE, never clamped
    // (unchanged from the pre-split LaneColumn.tsx: only the `remaining > 0`
    // check at the call site decides whether to render the "show more" button).
    expect(result.current.remaining).toBe(5 - PAGE_SIZE);
    expect(result.current.remaining).toBeLessThan(0);
  });

  it('reveals PAGE_SIZE more cards each time showMore() is called', () => {
    const cards = makeCards(PAGE_SIZE * 2 + 5);
    const { result } = renderHook(() =>
      useLaneCardPaging('ready', cards, false),
    );

    act(() => {
      result.current.showMore();
    });

    expect(result.current.visibleCards).toHaveLength(PAGE_SIZE * 2);
    expect(result.current.remaining).toBe(5);

    act(() => {
      result.current.showMore();
    });

    // visibleCount is now 3*PAGE_SIZE, past the card count -- all cards are
    // visible and remaining goes negative (same un-clamped semantics as above).
    expect(result.current.visibleCards).toHaveLength(PAGE_SIZE * 2 + 5);
    expect(result.current.remaining).toBe(PAGE_SIZE * 2 + 5 - PAGE_SIZE * 3);
    expect(result.current.remaining).toBeLessThan(0);
  });

  it('does not crash without a BoardKeyboardNavProvider ancestor (registration is a no-op)', () => {
    const cards = makeCards(3);
    const { result, unmount } = renderHook(() =>
      useLaneCardPaging('ready', cards, false),
    );

    expect(result.current.visibleCards).toHaveLength(3);
    expect(() => unmount()).not.toThrow();
  });
});
