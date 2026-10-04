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

    it('drops a second admit of the same seq as stale (one admit per seq)', () => {
      const order = createThreadListFetchOrder();
      const seq = order.begin('a');
      expect(order.admit('a', seq, [thread('s1')])).toEqual([thread('s1')]);
      expect(order.admit('a', seq, [thread('s1'), thread('s2')])).toBeUndefined();
      expect(order.appliedList('a')).toEqual([thread('s1')]);
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

  // bdboard-gtv0: 削除前に始まった fetch の一覧に、削除したスレッドが入っていても一覧へ戻さない。
  describe('forgetEntry tombstone (bdboard-gtv0)', () => {
    it('removes the forgotten thread from a list that started before the delete', () => {
      const order = createThreadListFetchOrder();
      const seq = order.begin('a');
      order.forgetEntry('a', 's2');
      expect(order.admit('a', seq, [thread('s1'), thread('s2'), thread('s3')])).toEqual([thread('s1'), thread('s3')]);
    });

    it('keeps the forgotten thread out of the applied list as well', () => {
      const order = createThreadListFetchOrder();
      const seq = order.begin('a');
      order.forgetEntry('a', 's2');
      order.admit('a', seq, [thread('s1'), thread('s2')]);
      expect(order.appliedList('a')).toEqual([thread('s1')]);
    });

    it('trusts a list that started after the delete, even if it has the same id', () => {
      const order = createThreadListFetchOrder();
      order.begin('a');
      order.forgetEntry('a', 's2');
      const later = order.begin('a');
      // 削除より後に始まった fetch はサーバーが削除を反映済みのはず。応答に同じ id があるなら、それが現実(再作成など)。
      expect(order.admit('a', later, [thread('s1'), thread('s2')])).toEqual([thread('s1'), thread('s2')]);
    });

    it('removes the thread from every list that started before the delete, while they are still allowed to land', () => {
      const order = createThreadListFetchOrder();
      const first = order.begin('a');
      const second = order.begin('a');
      order.forgetEntry('a', 's2');
      expect(order.admit('a', first, [thread('s1'), thread('s2')])).toEqual([thread('s1')]);
      expect(order.admit('a', second, [thread('s1'), thread('s2')])).toEqual([thread('s1')]);
    });

    it('trusts a list that started after the delete when every earlier fetch had already landed', () => {
      const order = createThreadListFetchOrder();
      order.admit('a', order.begin('a'), [thread('s1'), thread('s2')]);
      order.forgetEntry('a', 's2');
      // 未着の fetch が無いときの削除。そのあとに始まった fetch の一覧に同じ id があれば、そのまま当たる。
      const later = order.begin('a');
      expect(order.admit('a', later, [thread('s1'), thread('s2')])).toEqual([thread('s1'), thread('s2')]);
    });

    it('still drops an older outstanding list after a delete when a newer list was already applied', () => {
      const order = createThreadListFetchOrder();
      const older = order.begin('a');
      const newer = order.begin('a');
      expect(order.admit('a', newer, [thread('s1'), thread('s2')])).toBeDefined();
      order.forgetEntry('a', 's2');
      // older は newer が当たっているので、削除のあとも捨てられる(一覧は書かれず、s2 は戻らない)。
      expect(order.admit('a', older, [thread('s1'), thread('s2')])).toBeUndefined();
      expect(order.appliedList('a')).toEqual([thread('s1')]);
    });

    it('applies a list that started after the delete as is once the pre-delete list has landed', () => {
      const order = createThreadListFetchOrder();
      const early = order.begin('a');
      order.forgetEntry('a', 's2');
      // 削除前に始まった early の一覧は s2 を除いて当たる。そのあとに始まった fetch の一覧は応答のまま。
      expect(order.admit('a', early, [thread('s1'), thread('s2')])).toEqual([thread('s1')]);
      const after = order.begin('a');
      expect(order.admit('a', after, [thread('s1'), thread('s2')])).toEqual([thread('s1'), thread('s2')]);
    });

    it('does not bring the forgotten thread back on a second admit of the same seq', () => {
      const order = createThreadListFetchOrder();
      const seq = order.begin('a');
      order.forgetEntry('a', 's2');
      expect(order.admit('a', seq, [thread('s1'), thread('s2')])).toEqual([thread('s1')]);
      // 同じ seq の 2 回目は stale。削除済みの id を含む応答でも、一覧へ戻らない。
      expect(order.admit('a', seq, [thread('s1'), thread('s2')])).toBeUndefined();
      expect(order.appliedList('a')).toEqual([thread('s1')]);
    });

    it('keeps the record while a list that started before the delete is still outstanding', () => {
      const order = createThreadListFetchOrder();
      const first = order.begin('a');
      const second = order.begin('a');
      order.forgetEntry('a', 's2');
      // first が当たっても、削除点(second まで払い出し済み)に届いていないので記録は残り、second の一覧からも除く。
      expect(order.admit('a', first, [thread('s1'), thread('s2')])).toEqual([thread('s1')]);
      expect(order.admit('a', second, [thread('s1'), thread('s2')])).toEqual([thread('s1')]);
      // second が当たって記録が捨てられた後に始まった fetch は応答のまま。
      expect(order.admit('a', order.begin('a'), [thread('s1'), thread('s2')])).toEqual([thread('s1'), thread('s2')]);
    });

    it('does not drop the record by a dropped (stale) list', () => {
      const order = createThreadListFetchOrder();
      const first = order.begin('a');
      const second = order.begin('a');
      const third = order.begin('a');
      expect(order.admit('a', second, [thread('s1')])).toBeDefined();
      order.forgetEntry('a', 's2');
      // first は second が当たっているので捨てられる。third は削除前に始まっているので除く。
      expect(order.admit('a', first, [thread('s1'), thread('s2')])).toBeUndefined();
      expect(order.admit('a', third, [thread('s1'), thread('s2')])).toEqual([thread('s1')]);
    });

    it('keeps a thread out when a rename response (replace write) lands after the delete', () => {
      const order = createThreadListFetchOrder();
      const seq = order.begin('a');
      order.forgetEntry('a', 's2');
      // 削除後にリネームの応答が届いて replace の書き込みが入っても、replace は一覧に無い行を足さないので、
      // 削除前に始まった一覧では除かれたまま(リネームの置き換えが削除済みの行を蘇らせない)。
      order.noteEntryWrite('a', thread('s2', 'renamed'), 'replace');
      expect(order.admit('a', seq, [thread('s1'), thread('s2', 'old')])).toEqual([thread('s1')]);
    });

    it('keeps a row upserted after the delete: the local write is newer than the delete', () => {
      const order = createThreadListFetchOrder();
      const seq = order.begin('a');
      order.noteEntryWrite('a', thread('new', 'sent title'), 'upsert');
      order.forgetEntry('a', 'new');
      // 削除のあとで同じ id を送信成功で足し直した(削除より新しい手元の事実)。削除前に始まった一覧にも重なる。
      order.noteEntryWrite('a', thread('new', 'sent again'), 'upsert');
      expect(order.admit('a', seq, [thread('s1')])).toEqual([thread('s1'), thread('new', 'sent again')]);
    });

    it('lets an upsert after the delete replace the stale row the pre-delete list carries', () => {
      const order = createThreadListFetchOrder();
      const seq = order.begin('a');
      order.forgetEntry('a', 'new');
      order.noteEntryWrite('a', thread('new', 'sent again'), 'upsert');
      // 応答にある古い行は削除の除去で消え、削除後の upsert が末尾へ足される(古い行のタイトルには戻らない)。
      expect(order.admit('a', seq, [thread('s1'), thread('new', 'stale')])).toEqual([thread('s1'), thread('new', 'sent again')]);
    });

    it('records per thread and per project', () => {
      const order = createThreadListFetchOrder();
      const a = order.begin('a');
      const b = order.begin('b');
      order.forgetEntry('a', 's2');
      expect(order.admit('b', b, [thread('s1'), thread('s2')])).toEqual([thread('s1'), thread('s2')]);
      expect(order.admit('a', a, [thread('s1'), thread('s2'), thread('s3')])).toEqual([thread('s1'), thread('s3')]);
    });

    it('re-records the delete point when the same id is forgotten again', () => {
      const order = createThreadListFetchOrder();
      const first = order.begin('a');
      order.forgetEntry('a', 's2');
      const second = order.begin('a');
      order.forgetEntry('a', 's2');
      // 2 回目の削除は second の開始より後。second の一覧からも除く。
      expect(order.admit('a', first, [thread('s1'), thread('s2')])).toEqual([thread('s1')]);
      expect(order.admit('a', second, [thread('s1'), thread('s2')])).toEqual([thread('s1')]);
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
