// bdboard-e8jj: merge-pr が置いた再実行の予約 holder を、再実行の holder (retry: true、同じ since) が見えた時点で
// merge-pr 自身が消す監視 (scripts/merge-pr/reservation-watch.mjs) の単体。finish を通した確認は
// scripts/merge-pr.load-retry.test.mjs。実ファイルは一時ディレクトリの中だけで、本物のスロットの置き場には触れない。
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { reserveVerifySlot } from './verify-slot.mjs';
import { HOLDER_FORMAT } from './verify-slot-queue.mjs';
import { retryHolderAppeared, watchRetryHolder } from './merge-pr/reservation-watch.mjs';
import { waitUntil } from './merge-pr.test-support.mjs';

const SINCE = 1_700_000_000_000;
const INTERVAL_MS = 5;
const NEGATIVE_WAIT_MS = 120; // 監視が動かないことの確認 (INTERVAL_MS の 20 周以上)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 再実行の verify が書く holder の形 (scripts/verify-slot.mjs の newHolder)。
const retryHolder = (extra = {}) => ({ v: HOLDER_FORMAT, pid: 202, joinedAt: SINCE + 10, queuedAt: SINCE + 10, since: SINCE, priority: 'landed', retry: true, ...extra });

let dir;
let reservationPath;
let otherPath;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'reservation-watch-'));
  reservationPath = path.join(dir, 'holder-101.json');
  otherPath = path.join(dir, 'holder-202.json');
  writeFileSync(reservationPath, JSON.stringify({ v: HOLDER_FORMAT, pid: 101, joinedAt: SINCE + 1, since: SINCE, priority: 'landed', reserved: true }));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('retryHolderAppeared', () => {
  it('is false while only the reservation itself is there, even if it looked like a retry holder', () => {
    expect(retryHolderAppeared(dir, reservationPath, SINCE)).toBe(false);
    writeFileSync(reservationPath, JSON.stringify(retryHolder({ pid: 101 })));
    expect(retryHolderAppeared(dir, reservationPath, SINCE)).toBe(false);
  });

  it('is true for a readable retry holder of landed priority with the same since', () => {
    writeFileSync(otherPath, JSON.stringify(retryHolder()));
    expect(retryHolderAppeared(dir, reservationPath, SINCE)).toBe(true);
  });

  it.each([
    ['another since', retryHolder({ since: SINCE + 1 })],
    ['no since', retryHolder({ since: undefined })],
    ['not a retry (another landed waiter)', retryHolder({ retry: undefined })],
    ['a reservation of another process', retryHolder({ retry: undefined, reserved: true })],
    ['an old-format holder (no v)', retryHolder({ v: undefined })],
    ['merge priority', retryHolder({ priority: 'merge' })],
    ['pr priority', retryHolder({ priority: 'pr' })],
  ])('is false for %s', (_name, holder) => {
    writeFileSync(otherPath, JSON.stringify(holder));
    expect(retryHolderAppeared(dir, reservationPath, SINCE)).toBe(false);
  });

  it('ignores an unreadable or half-written holder, files that are not holders, and a missing directory', () => {
    writeFileSync(otherPath, '{"v":2,"retry":tr');
    writeFileSync(path.join(dir, 'holder-303.json.404.tmp'), JSON.stringify(retryHolder()));
    writeFileSync(path.join(dir, 'notes.json'), JSON.stringify(retryHolder()));
    expect(retryHolderAppeared(dir, reservationPath, SINCE)).toBe(false);
    expect(retryHolderAppeared(path.join(dir, 'missing'), reservationPath, SINCE)).toBe(false);
  });
});

describe('watchRetryHolder', () => {
  // removes: false は unlink が失敗し続ける環境 (release は呼ばれるがファイルが残る。本物の release も unlinkQuietly で失敗を飲み込む)。
  const watch = (overrides = {}, { removes = true } = {}) => {
    const reservation = {
      path: reservationPath,
      released: 0,
      release() {
        this.released += 1;
        if (removes) {
          rmSync(reservationPath, { force: true });
        }
      },
    };
    const stop = watchRetryHolder({ reservation, since: SINCE, intervalMs: INTERVAL_MS, ...overrides });
    return { reservation, stop };
  };

  it('releases the reservation once, as soon as the retry holder shows, and stops when the file is gone', async () => {
    const { reservation, stop } = watch();
    await sleep(NEGATIVE_WAIT_MS);
    expect(reservation.released).toBe(0); // 再実行の holder がまだ無い間は何もしない
    writeFileSync(otherPath, JSON.stringify(retryHolder()));
    await waitUntil(() => reservation.released > 0);
    await sleep(NEGATIVE_WAIT_MS);
    expect(reservation.released).toBe(1); // 消えたので止まる (再実行の holder は見え続けている)
    expect(existsSync(reservationPath)).toBe(false);
    stop();
    stop(); // 冪等
  });

  it('keeps releasing every poll while the file is still there (the unlink keeps failing), and stops once it is gone', async () => {
    const { reservation, stop } = watch({}, { removes: false });
    writeFileSync(otherPath, JSON.stringify(retryHolder()));
    await waitUntil(() => reservation.released >= 4); // 1 回で諦めない
    rmSync(reservationPath); // 一過性が解けて消えた
    await sleep(INTERVAL_MS * 6); // 動いていた周が終わるのを待つ
    const settled = reservation.released;
    await sleep(NEGATIVE_WAIT_MS);
    expect(reservation.released).toBe(settled); // 消えた後は呼ばない
    stop();
  });

  it('stops retrying the release when stop() is called (the caller finally is the bound)', async () => {
    const { reservation, stop } = watch({}, { removes: false });
    writeFileSync(otherPath, JSON.stringify(retryHolder()));
    await waitUntil(() => reservation.released >= 2);
    stop();
    const atStop = reservation.released;
    await sleep(NEGATIVE_WAIT_MS);
    expect(reservation.released).toBe(atStop);
    expect(existsSync(reservationPath)).toBe(true); // 残りは finally の release が消す
  });

  it('keeps the reservation for a holder that is not this retry', async () => {
    const { reservation, stop } = watch();
    writeFileSync(otherPath, JSON.stringify(retryHolder({ since: SINCE + 1 })));
    await sleep(NEGATIVE_WAIT_MS);
    stop();
    expect(reservation.released).toBe(0);
  });

  it('does nothing after stop()', async () => {
    const { reservation, stop } = watch();
    stop();
    writeFileSync(otherPath, JSON.stringify(retryHolder()));
    await sleep(NEGATIVE_WAIT_MS);
    expect(reservation.released).toBe(0);
  });

  it('is a no-op when there is no reservation file path (slot gating disabled)', () => {
    const stop = watchRetryHolder({ reservation: { path: undefined, release: () => {} }, since: SINCE, intervalMs: INTERVAL_MS });
    expect(() => stop()).not.toThrow();
  });

  it('survives a release that throws and tries again on the next poll (the finally of the caller is the bound)', async () => {
    const reservation = { path: reservationPath, tries: 0, release() { this.tries += 1; throw new Error('boom'); } };
    const stop = watchRetryHolder({ reservation, since: SINCE, intervalMs: INTERVAL_MS });
    writeFileSync(otherPath, JSON.stringify(retryHolder()));
    await waitUntil(() => reservation.tries >= 3);
    stop();
    const atStop = reservation.tries;
    await sleep(NEGATIVE_WAIT_MS);
    expect(reservation.tries).toBe(atStop);
  });

  it('removes a real reservation from reserveVerifySlot (its since is the one merge-pr passes) and its exit hook', async () => {
    rmSync(reservationPath);
    const exitHooks = process.listenerCount('exit');
    const reservation = await reserveVerifySlot({ dir, slots: 2, priority: 'landed', queueSince: SINCE });
    try {
      expect(reservation.path).toBe(path.join(dir, `holder-${process.pid}.json`));
      expect(JSON.parse(readFileSync(reservation.path, 'utf8'))).toMatchObject({ reserved: true, priority: 'landed', since: SINCE });
      const stop = watchRetryHolder({ reservation, since: SINCE, intervalMs: INTERVAL_MS });
      writeFileSync(path.join(dir, 'holder-999999.json'), JSON.stringify(retryHolder({ pid: 999999 })));
      await waitUntil(() => !existsSync(reservation.path));
      stop();
      expect(process.listenerCount('exit')).toBe(exitHooks);
    } finally {
      reservation.release();
    }
  });
});
