import { describe, expect, it, vi } from 'vitest';
import {
  clearUnobservedOriginFor,
  createReplacedThreadMarks,
  discardUnobservedOriginOnSettle,
  markUnobservedSend,
  persistedOpenBaseAfterCommit,
  planReplacedThread,
  takeUnobservedOrigin,
  withHistoryLoaded,
  withoutKey,
} from './replacedThread';

// bdboard-drfb / bdboard-w9hv: 送信の成功(commitSuccess)と turn-status 回収(applyRecoveredTurn)が
// 共有する「置き換え」の規則。フック越しの挙動は useChatSendCommits.test.tsx /
// useChatSessionLifecycle.test.tsx / ChatPanel.thread-ops-and-messages.test.tsx が見る。

describe('planReplacedThread', () => {
  it('replaces an open real thread whose session changed, and moves the new session to the end', () => {
    expect(planReplacedThread({ convKey: 'B', newSessionId: 'C', open: ['A', 'B'], sessionGone: false })).toEqual({
      replacedKey: 'B',
      nextOpen: ['A', 'C'],
      goneSessionId: undefined,
    });
  });

  it('reports the gone session id only when the failure was unknown-chat-session', () => {
    expect(planReplacedThread({ convKey: 'B', newSessionId: 'C', open: ['A', 'B'], sessionGone: true })).toMatchObject({
      replacedKey: 'B',
      goneSessionId: 'B',
    });
  });

  it('does not replace a key that is not open (a draft key), but still reports the gone id', () => {
    expect(planReplacedThread({ convKey: 'draft-1', newSessionId: 'C', open: ['A', 'B'], sessionGone: true })).toEqual({
      replacedKey: undefined,
      nextOpen: ['A', 'B', 'C'],
      goneSessionId: 'draft-1',
    });
  });

  it('does not replace anything when the session did not change, and keeps the order but moves it to the end', () => {
    expect(planReplacedThread({ convKey: 'B', newSessionId: 'B', open: ['B', 'A'], sessionGone: true })).toEqual({
      replacedKey: undefined,
      nextOpen: ['A', 'B'],
      goneSessionId: undefined,
    });
  });

  it('treats an unknown origin (undefined) and an unknown open list (undefined) as "nothing to replace"', () => {
    expect(planReplacedThread({ convKey: undefined, newSessionId: 'C', open: ['A'], sessionGone: false })).toEqual({
      replacedKey: undefined,
      nextOpen: ['A', 'C'],
      goneSessionId: undefined,
    });
    expect(planReplacedThread({ convKey: 'B', newSessionId: 'C', open: undefined, sessionGone: true })).toEqual({
      replacedKey: undefined,
      nextOpen: ['C'],
      goneSessionId: 'B',
    });
  });
});

describe('persistedOpenBaseAfterCommit', () => {
  const readPersistedOpen = vi.fn(() => ['X', 'B', 'C']);
  const replaced = planReplacedThread({ convKey: 'B', newSessionId: 'C', open: ['A', 'B'], sessionGone: false });
  const notReplaced = planReplacedThread({ convKey: 'B', newSessionId: 'B', open: ['A', 'B'], sessionGone: false });

  it('uses the in-memory next open when the project is restored and the live open is known (bdboard-7feq)', () => {
    readPersistedOpen.mockClear();
    expect(
      persistedOpenBaseAfterCommit({ restored: true, liveOpen: ['A', 'B'], plan: replaced, newSessionId: 'C', readPersistedOpen }),
    ).toEqual(['A', 'C']);
    expect(readPersistedOpen).not.toHaveBeenCalled();
  });

  it('drops the replaced thread and the new session from the persisted entry when not restored yet', () => {
    expect(
      persistedOpenBaseAfterCommit({ restored: false, liveOpen: undefined, plan: replaced, newSessionId: 'C', readPersistedOpen }),
    ).toEqual(['X']);
    expect(
      persistedOpenBaseAfterCommit({ restored: true, liveOpen: undefined, plan: replaced, newSessionId: 'C', readPersistedOpen }),
    ).toEqual(['X']);
  });

  it('leaves the base undefined (the persisted entry as is) when not restored and nothing was replaced', () => {
    readPersistedOpen.mockClear();
    expect(
      persistedOpenBaseAfterCommit({ restored: false, liveOpen: ['A'], plan: notReplaced, newSessionId: 'B', readPersistedOpen }),
    ).toBeUndefined();
    expect(readPersistedOpen).not.toHaveBeenCalled();
  });
});

describe('withHistoryLoaded / withoutKey', () => {
  it('marks the loaded id and removes the replaced key without touching the input', () => {
    const loaded = { A: true, B: true } as const;
    const next = withHistoryLoaded({ ...loaded }, 'C', 'B');
    expect(next).toEqual({ A: true, C: true });
    expect(loaded).toEqual({ A: true, B: true });
  });

  it('keeps every other flag when nothing was replaced', () => {
    expect(withHistoryLoaded({ A: true, B: true }, 'C', undefined)).toEqual({ A: true, B: true, C: true });
  });

  it('returns a copy without the key, or the same record when the key is absent', () => {
    const record = { A: 1, B: 2 };
    expect(withoutKey(record, 'B')).toEqual({ A: 1 });
    expect(record).toEqual({ A: 1, B: 2 });
    expect(withoutKey(record, 'Z')).toBe(record);
    expect(withoutKey(record, undefined)).toBe(record);
  });
});

describe('unobserved send origins', () => {
  it('remembers the send key only for a send without a session id', () => {
    const marks = createReplacedThreadMarks();
    markUnobservedSend(marks, 'proj-a', 'B', undefined);
    markUnobservedSend(marks, 'proj-b', 'D', 'D');
    expect(marks.unobservedOrigins).toEqual({ 'proj-a': 'B' });
  });

  it('hands the origin over once, per project, and clears its gone mark', () => {
    const marks = createReplacedThreadMarks();
    markUnobservedSend(marks, 'proj-a', 'B', undefined);
    marks.goneKeys.add('B');
    marks.goneKeys.add('other');
    expect(takeUnobservedOrigin(marks, 'proj-b')).toBeUndefined();
    expect(takeUnobservedOrigin(marks, 'proj-a')).toBe('B');
    expect(takeUnobservedOrigin(marks, 'proj-a')).toBeUndefined();
    expect([...marks.goneKeys]).toEqual(['other']);
  });

  it('clears the record only when it belongs to the committed send key, in that project only', () => {
    const marks = createReplacedThreadMarks();
    markUnobservedSend(marks, 'proj-a', 'B', undefined);
    markUnobservedSend(marks, 'proj-b', 'B', undefined);
    clearUnobservedOriginFor(marks, 'proj-a', 'other');
    expect(marks.unobservedOrigins).toEqual({ 'proj-a': 'B', 'proj-b': 'B' });
    clearUnobservedOriginFor(marks, 'proj-a', 'B');
    expect(marks.unobservedOrigins).toEqual({ 'proj-b': 'B' });
    clearUnobservedOriginFor(marks, 'proj-a', 'B');
    expect(marks.unobservedOrigins).toEqual({ 'proj-b': 'B' });
  });
});

// bdboard-0u16: 中断した送信のターンが回収できる完了を残さず終わった(turn-status が idle / failed を
// 返した)なら、残っている起点の記録は古い。捨てないと、後の無関係な回収(開いていない既知のセッション)が
// その起点を「置き換えられた」と判定して無関係なスレッドを閉じてしまう。
describe('discardUnobservedOriginOnSettle', () => {
  it.each(['idle', 'failed'] as const)('drops the project record when turn-status is %s, for that project only', (state) => {
    const marks = createReplacedThreadMarks();
    markUnobservedSend(marks, 'proj-a', 'B', undefined);
    markUnobservedSend(marks, 'proj-b', 'D', undefined);
    discardUnobservedOriginOnSettle(marks, 'proj-a', state);
    expect(marks.unobservedOrigins).toEqual({ 'proj-b': 'D' });
  });

  it.each(['processing', 'completed'] as const)('keeps the record while turn-status is %s (the turn may still be recovered)', (state) => {
    const marks = createReplacedThreadMarks();
    markUnobservedSend(marks, 'proj-a', 'B', undefined);
    discardUnobservedOriginOnSettle(marks, 'proj-a', state);
    expect(marks.unobservedOrigins).toEqual({ 'proj-a': 'B' });
  });

  it('is a no-op without a record, and leaves the gone marks alone', () => {
    const marks = createReplacedThreadMarks();
    marks.goneKeys.add('B');
    discardUnobservedOriginOnSettle(marks, 'proj-a', 'idle');
    expect(marks.unobservedOrigins).toEqual({});
    expect([...marks.goneKeys]).toEqual(['B']);
  });
});
