import { describe, expect, it } from 'vitest';
import { EXTERNAL_ISSUE_SNAPSHOT_MAX_COUNT } from '../../domain/external-issue-snapshot-record.js';
import { createHarness, makeIssue, type Harness } from './external-issue-test-support.js';

// bdboard-558a: gh のページ上限で一覧が毎回打ち切られると、外れた印 (missingSince) が付かず、上限のための削除の候補が無くなって
// 写しが 500 を超えて増えた。打ち切られた poll でも、今回の一覧に載っていない写しから (外れたと分かっているもの → 写しの古い順に) 消す。

/** start から count 件の issue。 */
function issues(start: number, count: number) {
  return Array.from({ length: count }, (_, index) => makeIssue(start + index));
}

/** start から count 件の番号。 */
function numbers(start: number, count: number): number[] {
  return Array.from({ length: count }, (_, index) => start + index);
}

/** 保存されている写しの番号 (昇順)。 */
function saved(h: Harness): number[] {
  return [...h.storage.files.keys()].sort((a, b) => a - b);
}

describe('snapshot cap: the number of saved snapshots stays within 500 on every poll', () => {
  it('holds when every poll is cut short by the page limit and the 300 issues on the list change each time', async () => {
    const h = createHarness();
    for (const start of [1, 301, 601]) {
      h.setIssues(issues(start, 300), { truncatedByPageLimit: true });
      const list = await h.service.poll();

      expect(list).toMatchObject({ state: 'ok', truncated: true });
      expect(h.storage.files.size).toBeLessThanOrEqual(EXTERNAL_ISSUE_SNAPSHOT_MAX_COUNT);
      // この poll で一覧に載った 300 件の写しは、消されていない。
      for (const number of numbers(start, 300)) expect(h.storage.files.has(number)).toBe(true);
      h.advance(1_000);
    }

    // 古い写しから消える: 2 回目は同じ時刻の 1..300 から番号の小さい 100 件 (1..100)、3 回目は 101..300 の 200 件と 301..400 の 100 件。
    expect(saved(h)).toEqual([...numbers(401, 200), ...numbers(601, 300)]);
    // どれも外れた印は付かない (打ち切られた poll では付けない)。
    expect([...h.storage.files.values()].every((record) => record.missingSince === null)).toBe(true);
  });

  it('removes the snapshot that was seen earliest first, not the one with the lowest number', async () => {
    const h = createHarness();
    h.setIssues(issues(1001, 250), { truncatedByPageLimit: true });
    await h.service.poll();
    h.advance(1_000);
    // 番号は小さいが、後から写しを取った 250 件。
    h.setIssues(issues(1, 250), { truncatedByPageLimit: true });
    await h.service.poll();
    h.advance(1_000);

    h.setIssues(issues(5001, 100), { truncatedByPageLimit: true });
    await h.service.poll();

    // 600 件から 100 件を消す。先に写しを取った 1001..1100 が、番号は大きくても先に消える。
    expect(saved(h)).toEqual([...numbers(1, 250), ...numbers(1101, 150), ...numbers(5001, 100)]);
  });

  it('never removes a snapshot on the current list, even when the cap is reached', async () => {
    const h = createHarness();
    h.setIssues(issues(1, EXTERNAL_ISSUE_SNAPSHOT_MAX_COUNT));
    await h.service.poll();
    h.advance(1_000);

    h.setIssues(issues(1001, 100), { truncatedByPageLimit: true });
    await h.service.poll();

    expect(saved(h)).toEqual([...numbers(101, 400), ...numbers(1001, 100)]);
  });

  it('cuts the list at 500 when the issues on it alone exceed 500, keeps those 500, and drops the older snapshots that are not on it', async () => {
    const h = createHarness();
    h.setIssues(issues(9001, 10));
    await h.service.poll();
    h.advance(1_000);

    h.setIssues(issues(1, EXTERNAL_ISSUE_SNAPSHOT_MAX_COUNT + 20));
    const list = await h.service.poll();

    expect(list).toMatchObject({ state: 'ok', truncated: true });
    expect(list.issues).toHaveLength(EXTERNAL_ISSUE_SNAPSHOT_MAX_COUNT);
    // 一覧の先頭 500 件の写しだけが残る。501 番目以降は写しを作らず、以前に写しのあった 9001..9010 は一覧に載らないので消える。
    expect(saved(h)).toEqual(numbers(1, EXTERNAL_ISSUE_SNAPSHOT_MAX_COUNT));
  });

  it('takes the snapshots that left the list first, even when an unseen one is older', async () => {
    const h = createHarness();
    h.setIssues(issues(1, 400));
    await h.service.poll();
    h.advance(1_000);
    h.setIssues([...issues(1, 400), ...issues(1001, 100)]);
    await h.service.poll();
    h.advance(1_000);
    // 1001..1100 は一覧から外れて印が付く (写しを取ったのは 1..400 より新しい)。
    h.setIssues(issues(1, 400));
    await h.service.poll();
    expect([...h.storage.files.values()].filter((record) => record.missingSince !== null)).toHaveLength(100);
    h.advance(1_000);

    h.setIssues(issues(2001, 100), { truncatedByPageLimit: true });
    await h.service.poll();

    // 600 件から 100 件を消す。写しが古い 1..100 より先に、外れたと分かっている 1001..1100 が消える。
    expect(saved(h)).toEqual([...numbers(1, 400), ...numbers(2001, 100)]);
  });

  it('keeps the rejudge mark of a rebuilt unusable snapshot on a truncated poll that has to remove others', async () => {
    const h = createHarness();
    h.setIssues(issues(1001, 450));
    await h.service.poll();
    h.advance(1_000);
    h.storage.unusable.add(42);

    h.setIssues([makeIssue(42), ...issues(2001, 100)], { truncatedByPageLimit: true });
    const list = await h.service.poll();

    // 551 件から 51 件を消す。一覧に載る 42 (使えない写しを作り直したもの) は消えず、再判定の印が付いたまま。
    expect(h.storage.files.size).toBe(EXTERNAL_ISSUE_SNAPSHOT_MAX_COUNT);
    expect(h.storage.files.get(42)).toMatchObject({ needsRejudge: true, missingSince: null });
    expect(list.issues.find((entry) => entry.number === 42)?.snapshot.needsRejudge).toBe(true);
    expect(h.storage.removes.slice().sort((a, b) => a - b)).toEqual(numbers(1001, 51));
  });
});
