import { describe, expect, it } from 'vitest';
import type { ChatThreadDto } from '../../api';
import { createThreadListFetchOrder } from './threadListFetchOrder';

function thread(sessionId: string, title: string | null = sessionId, pinned = false): ChatThreadDto {
  return { sessionId, agentId: 'claude', title, pinned, updatedAt: '2026-01-01T00:00:00Z' };
}

describe('createThreadListFetchOrder (bdboard-z9mn)', () => {
  describe('begin', () => {
    it('hands out increasing numbers per project', () => {
      const order = createThreadListFetchOrder();
      expect([order.begin('a'), order.begin('a'), order.begin('b'), order.begin('a')]).toEqual([1, 2, 1, 3]);
    });
  });

  describe('admit', () => {
    it('returns a copy of the fetched list when nothing newer was applied', () => {
      const order = createThreadListFetchOrder();
      const seq = order.begin('a');
      const fetched = [thread('s1'), thread('s2')];
      const admitted = order.admit('a', seq, fetched);
      expect(admitted).toEqual(fetched);
      expect(admitted).not.toBe(fetched);
    });

    it('drops a list that started before a list that was already applied', () => {
      const order = createThreadListFetchOrder();
      const older = order.begin('a');
      const newer = order.begin('a');
      expect(order.admit('a', newer, [thread('s1'), thread('s2')])).toBeDefined();
      expect(order.admit('a', older, [thread('s1')])).toBeUndefined();
    });

    it('applies lists in start order regardless of the order they land in', () => {
      const order = createThreadListFetchOrder();
      const first = order.begin('a');
      const second = order.begin('a');
      // 開始の古い方が先に届いても当てる(まだ新しい一覧は当たっていない)。そのあとに新しい方も当たる。
      expect(order.admit('a', first, [thread('s1')])).toEqual([thread('s1')]);
      expect(order.admit('a', second, [thread('s1'), thread('s2')])).toEqual([thread('s1'), thread('s2')]);
    });

    it('does not drop a list because of another project', () => {
      const order = createThreadListFetchOrder();
      const a = order.begin('a');
      const b1 = order.begin('b');
      const b2 = order.begin('b');
      expect(order.admit('b', b2, [thread('x')])).toBeDefined();
      expect(order.admit('a', a, [thread('s1')])).toBeDefined();
      expect(order.admit('b', b1, [thread('x')])).toBeUndefined();
    });

    it('does not let a dropped list move the applied number', () => {
      const order = createThreadListFetchOrder();
      const first = order.begin('a');
      const second = order.begin('a');
      const third = order.begin('a');
      expect(order.admit('a', third, [thread('s3')])).toBeDefined();
      expect(order.admit('a', first, [thread('s1')])).toBeUndefined();
      expect(order.admit('a', second, [thread('s2')])).toBeUndefined();
      const fourth = order.begin('a');
      expect(order.admit('a', fourth, [thread('s4')])).toEqual([thread('s4')]);
    });
  });

  describe('noteEntryWrite', () => {
    it('lays a replace write over a list that started before the write', () => {
      const order = createThreadListFetchOrder();
      const seq = order.begin('a');
      order.noteEntryWrite('a', thread('s1', 'renamed'), 'replace');
      expect(order.admit('a', seq, [thread('s1', 'old'), thread('s2')])).toEqual([thread('s1', 'renamed'), thread('s2')]);
    });

    it('does not add a replace write when the list does not have the thread', () => {
      const order = createThreadListFetchOrder();
      const seq = order.begin('a');
      order.noteEntryWrite('a', thread('gone', 'renamed'), 'replace');
      expect(order.admit('a', seq, [thread('s1')])).toEqual([thread('s1')]);
    });

    it('appends an upsert write when the list does not have the thread', () => {
      const order = createThreadListFetchOrder();
      const seq = order.begin('a');
      order.noteEntryWrite('a', thread('new', 'sent title'), 'upsert');
      expect(order.admit('a', seq, [thread('s1')])).toEqual([thread('s1'), thread('new', 'sent title')]);
    });

    it('keeps the upsert mode when a later replace write hits the same thread', () => {
      const order = createThreadListFetchOrder();
      const seq = order.begin('a');
      order.noteEntryWrite('a', thread('new', 'sent title'), 'upsert');
      order.noteEntryWrite('a', thread('new', 'renamed'), 'replace');
      expect(order.admit('a', seq, [thread('s1')])).toEqual([thread('s1'), thread('new', 'renamed')]);
    });

    it('does not lay a write over a list that started after the write', () => {
      const order = createThreadListFetchOrder();
      order.begin('a');
      order.noteEntryWrite('a', thread('s1', 'renamed'), 'replace');
      const later = order.begin('a');
      // 書き込みより後に始まった fetch はサーバーが反映済みなので、応答のまま当てる。
      expect(order.admit('a', later, [thread('s1', 'server title')])).toEqual([thread('s1', 'server title')]);
    });

    it('forgets a write once a list that started after it is applied', () => {
      const order = createThreadListFetchOrder();
      const early = order.begin('a');
      order.noteEntryWrite('a', thread('s1', 'renamed'), 'replace');
      const later = order.begin('a');
      expect(order.admit('a', later, [thread('s1', 'server title')])).toEqual([thread('s1', 'server title')]);
      // 後から届いた古い一覧は、もう捨てられる(新しい一覧が当たっている)。記録も無い。
      expect(order.admit('a', early, [thread('s1', 'old')])).toBeUndefined();
    });

    it('keeps a write for every list that started before it', () => {
      const order = createThreadListFetchOrder();
      const first = order.begin('a');
      const second = order.begin('a');
      order.noteEntryWrite('a', thread('s1', 'renamed'), 'replace');
      expect(order.admit('a', first, [thread('s1', 'old')])).toEqual([thread('s1', 'renamed')]);
      expect(order.admit('a', second, [thread('s1', 'old')])).toEqual([thread('s1', 'renamed')]);
    });

    it('keeps writes per project', () => {
      const order = createThreadListFetchOrder();
      const a = order.begin('a');
      const b = order.begin('b');
      order.noteEntryWrite('a', thread('s1', 'renamed'), 'replace');
      expect(order.admit('b', b, [thread('s1', 'other project')])).toEqual([thread('s1', 'other project')]);
      expect(order.admit('a', a, [thread('s1')])).toEqual([thread('s1', 'renamed')]);
    });
  });

  describe('forgetEntry', () => {
    it('stops laying a write over later lists', () => {
      const order = createThreadListFetchOrder();
      const seq = order.begin('a');
      order.noteEntryWrite('a', thread('new', 'sent title'), 'upsert');
      order.forgetEntry('a', 'new');
      expect(order.admit('a', seq, [thread('s1')])).toEqual([thread('s1')]);
    });

    it('also drops the thread from the applied list (bdboard-0206)', () => {
      const order = createThreadListFetchOrder();
      order.admit('a', order.begin('a'), [thread('s1'), thread('s2')]);
      order.forgetEntry('a', 's2');
      expect(order.appliedList('a')).toEqual([thread('s1')]);
    });
  });

  describe('appliedList (bdboard-0206)', () => {
    it('is undefined until a list was applied', () => {
      const order = createThreadListFetchOrder();
      order.begin('a');
      expect(order.appliedList('a')).toBeUndefined();
    });

    it('is the list the last admit returned, with the overlaid writes', () => {
      const order = createThreadListFetchOrder();
      const seq = order.begin('a');
      order.noteEntryWrite('a', thread('new'), 'upsert');
      order.admit('a', seq, [thread('s1')]);
      expect(order.appliedList('a')).toEqual([thread('s1'), thread('new')]);
    });

    it('keeps the newer list when an older one is dropped', () => {
      const order = createThreadListFetchOrder();
      const older = order.begin('a');
      const newer = order.begin('a');
      order.admit('a', newer, [thread('s1'), thread('s3')]);
      expect(order.admit('a', older, [thread('s1'), thread('s2')])).toBeUndefined();
      expect(order.appliedList('a')).toEqual([thread('s1'), thread('s3')]);
    });

    it('is per project', () => {
      const order = createThreadListFetchOrder();
      order.admit('a', order.begin('a'), [thread('s1')]);
      expect(order.appliedList('b')).toBeUndefined();
    });
  });
});
