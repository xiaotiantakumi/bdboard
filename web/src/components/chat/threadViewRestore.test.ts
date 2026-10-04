// bdboard-tsen: E7(chat/useThreadListSync.ts)と applyRecoveredTurn
// (chat/useChatSessionLifecycle.ts)が共有する open/選択の復元規則。
import { describe, expect, it } from 'vitest';
import type { ChatThreadDto } from '../../api';
import { restoreThreadView, widenOpenToServerList } from './threadViewRestore';

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

describe('restoreThreadView on a first visit whose entry was written during the fetch (bdboard-0206)', () => {
  it('opens every listed thread even though a persisted entry exists, and keeps the persisted selection', () => {
    expect(
      restoreThreadView(LIST, { activeSessionIds: ['sess-2'], selectedSessionId: 'sess-2' }, true),
    ).toEqual({ open: ['sess-1', 'sess-2'], selected: 'sess-2' });
  });

  it('drops a persisted id the server does not list, like the ordinary restore', () => {
    expect(
      restoreThreadView(LIST, { activeSessionIds: ['sess-gone'], selectedSessionId: 'sess-gone' }, true),
    ).toEqual({ open: ['sess-1', 'sess-2'], selected: 'sess-1' });
  });
});

describe('widenOpenToServerList', () => {
  it('lists the server threads first, then keeps current ids the list does not carry', () => {
    expect(widenOpenToServerList(LIST, ['sess-new'])).toEqual(['sess-1', 'sess-2', 'sess-new']);
  });

  it('does not duplicate a current id the list already carries', () => {
    expect(widenOpenToServerList(LIST, ['sess-2'])).toEqual(['sess-1', 'sess-2']);
  });

  it('is the server list when nothing is open', () => {
    expect(widenOpenToServerList(LIST, [])).toEqual(['sess-1', 'sess-2']);
  });
});
