// bdboard-tsen: E7(chat/useThreadListSync.ts)と applyRecoveredTurn
// (chat/useChatSessionLifecycle.ts)が共有する open/選択の復元規則。
import { describe, expect, it } from 'vitest';
import type { ChatThreadDto } from '../../api';
import { restoreThreadView } from './threadViewRestore';

function thread(sessionId: string): ChatThreadDto {
  return { sessionId, agentId: 'claude', title: sessionId, pinned: false, updatedAt: '2026-01-01T00:00:00Z' };
}

const LIST = [thread('sess-1'), thread('sess-2')];

describe('restoreThreadView', () => {
  it('opens every listed thread and selects the first when nothing is persisted', () => {
    expect(restoreThreadView(LIST, undefined)).toEqual({ open: ['sess-1', 'sess-2'], selected: 'sess-1' });
  });

  it('keeps only persisted ids the server still lists, in the persisted order, and restores the selection', () => {
    expect(
      restoreThreadView(LIST, { activeSessionIds: ['sess-2', 'sess-gone', 'sess-1'], selectedSessionId: 'sess-1' }),
    ).toEqual({ open: ['sess-2', 'sess-1'], selected: 'sess-1' });
  });

  it('falls back to the first open id when the persisted selection is gone or missing', () => {
    expect(restoreThreadView(LIST, { activeSessionIds: ['sess-2'], selectedSessionId: 'sess-gone' })).toEqual({
      open: ['sess-2'],
      selected: 'sess-2',
    });
    expect(restoreThreadView(LIST, { activeSessionIds: ['sess-2'] })).toEqual({ open: ['sess-2'], selected: 'sess-2' });
  });

  it('opens nothing when every persisted id is gone, and selects nothing', () => {
    expect(restoreThreadView(LIST, { activeSessionIds: ['sess-gone'] })).toEqual({ open: [], selected: undefined });
    expect(restoreThreadView([], undefined)).toEqual({ open: [], selected: undefined });
  });
});
