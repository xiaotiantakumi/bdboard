// bdboard-wt5c: verify スロットの holder file の読み取り (verify-slot-files.mjs の readOthers) のテスト。
//
// Windows では相手の置き換え rename と競合した読み取りが EPERM / EBUSY / EACCES で失敗する。
// その errno は macOS / Linux では自然には出ないので、readOthers の io (fs の差し替え口) に
// 失敗を注入して再現する。読めなかった相手を「書きかけ」と同じに数えないと上限 +1 本が走りうる。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { holderPath, readOthers } from './verify-slot-files.mjs';
import { MAX_SENIORITY_MS, planSlots, TIER_STEP_MS } from './verify-slot-queue.mjs';

const makeDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'verify-slot-files-test-'));

// 既に死んでいる pid (即終了する node を同期実行した pid)。
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;

// 生きている相手には、このテストのプロセス自身の pid を使う (selfPath は別の pid のファイルにする。
// readOthers は selfPath を読む前に飛ばすので、pid 0 の名前で足りる)。
const livePid = process.pid;
const selfPathIn = (dir) => holderPath(dir, 0);

const STALE_TTL_MS = 60_000;

const writeRunningHolder = (dir, pid, at = Date.now()) => {
  const filePath = holderPath(dir, pid);
  fs.writeFileSync(filePath, JSON.stringify({ v: 2, pid, joinedAt: at, queuedAt: at, acquiredAt: at, priority: 'pr' }));
  return filePath;
};

const setMtime = (filePath, mtimeMs) => fs.utimesSync(filePath, mtimeMs / 1000, mtimeMs / 1000);

const errnoError = (code) => Object.assign(new Error(`${code}: injected`), { code });

// failures.read / failures.stat: ファイル名 → 注入する errno。
const failingIo = (failures) => ({
  ...fs,
  readFileSync: (filePath, ...rest) => {
    const code = failures.read && failures.read[path.basename(filePath)];
    if (code) {
      throw errnoError(code);
    }
    return fs.readFileSync(filePath, ...rest);
  },
  statSync: (filePath, ...rest) => {
    const code = failures.stat && failures.stat[path.basename(filePath)];
    if (code) {
      throw errnoError(code);
    }
    return fs.statSync(filePath, ...rest);
  },
});

// 自分 (優先度が最上位の待ち手、slots 1) がいま走ってよいか。others は readOthers の結果。
const wouldAcquire = (others, now) => {
  const self = { v: 2, pid: -1, joinedAt: now, queuedAt: now, priority: 'landed' };
  return planSlots([self, ...others], {
    selfPid: -1,
    slots: 1,
    now,
    staleTtlMs: STALE_TTL_MS,
    tierStepMs: TIER_STEP_MS,
    maxSeniorityMs: MAX_SENIORITY_MS,
  });
};

describe('readOthers', () => {
  it('returns readable holders as they are and notes its own file', () => {
    const dir = makeDir();
    const selfPath = selfPathIn(dir);
    fs.writeFileSync(selfPath, '{}');
    writeRunningHolder(dir, livePid, 1_000);
    const { others, sawSelf } = readOthers(dir, selfPath);
    expect(sawSelf).toBe(true);
    expect(others).toEqual([{ v: 2, pid: livePid, joinedAt: 1_000, queuedAt: 1_000, acquiredAt: 1_000, priority: 'pr' }]);
  });

  it.each(['EPERM', 'EBUSY', 'EACCES'])(
    'counts a live holder it cannot read (%s, e.g. mid-rename on Windows) as running, and keeps its file',
    (code) => {
      const dir = makeDir();
      const filePath = writeRunningHolder(dir, livePid);
      const mtime = Date.now() - 10_000; // 書きかけの猶予 (5 秒) より古くても消さない
      setMtime(filePath, mtime);
      const now = Date.now();
      const io = failingIo({ read: { [path.basename(filePath)]: code } });
      const { others } = readOthers(dir, selfPathIn(dir), { io, now });
      expect(others).toHaveLength(1);
      expect(others[0]).toMatchObject({ pid: livePid, unreadable: true });
      expect(Math.abs(others[0].acquiredAt - mtime)).toBeLessThan(1_000); // 年齢は mtime から
      expect(fs.existsSync(filePath)).toBe(true);
      // 唯一の枠を読めない相手が使っているので、優先度が最上位の待ち手でも取らない (取ると上限 +1)。
      const plan = wouldAcquire(others, now);
      expect(plan.acquire).toBe(false);
      expect(plan.running.map((entry) => entry.pid)).toEqual([livePid]);
    },
  );

  it('treats ENOENT as a holder that released after readdir', () => {
    const dir = makeDir();
    const filePath = writeRunningHolder(dir, livePid);
    const io = failingIo({ read: { [path.basename(filePath)]: 'ENOENT' } });
    expect(readOthers(dir, selfPathIn(dir), { io }).others).toEqual([]);
  });

  it('still skips a half-written (unparsable) holder, and removes it only after the grace period', () => {
    const dir = makeDir();
    const filePath = holderPath(dir, livePid);
    fs.writeFileSync(filePath, '{"pid": 12');
    expect(readOthers(dir, selfPathIn(dir)).others).toEqual([]);
    expect(fs.existsSync(filePath)).toBe(true); // 書きかけかもしれないので消さない
    setMtime(filePath, Date.now() - 10_000);
    expect(readOthers(dir, selfPathIn(dir)).others).toEqual([]);
    expect(fs.existsSync(filePath)).toBe(false); // 猶予を過ぎたら壊れたファイルとして回収
  });

  it('does not count, and reclaims, an unreadable leftover of a dead pid', () => {
    const dir = makeDir();
    const filePath = writeRunningHolder(dir, deadPid());
    const io = failingIo({ read: { [path.basename(filePath)]: 'EPERM' } });
    expect(readOthers(dir, selfPathIn(dir), { io }).others).toEqual([]);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('lets an unreadable live holder go stale by its mtime, so it cannot block the slot forever', () => {
    const dir = makeDir();
    const filePath = writeRunningHolder(dir, livePid);
    const now = Date.now();
    setMtime(filePath, now - STALE_TTL_MS - 5_000);
    const io = failingIo({ read: { [path.basename(filePath)]: 'EACCES' } });
    const plan = wouldAcquire(readOthers(dir, selfPathIn(dir), { io, now }).others, now);
    expect(plan.stale.map((entry) => entry.pid)).toEqual([livePid]);
    expect(plan.acquire).toBe(true);
    expect(fs.existsSync(filePath)).toBe(true); // 生きている pid のファイルは消さない (stale の holder と同じ)
  });

  it('ages a holder it can neither read nor stat from the first failure, and forgets it once readable or gone', () => {
    const dir = makeDir();
    const filePath = writeRunningHolder(dir, livePid);
    const name = path.basename(filePath);
    const io = failingIo({ read: { [name]: 'EBUSY' }, stat: { [name]: 'EBUSY' } });
    const unreadableSince = new Map();
    const t0 = 1_000_000;
    expect(readOthers(dir, selfPathIn(dir), { io, now: t0, unreadableSince }).others[0].acquiredAt).toBe(t0);
    const later = t0 + STALE_TTL_MS + 1;
    const { others } = readOthers(dir, selfPathIn(dir), { io, now: later, unreadableSince });
    expect(others[0].acquiredAt).toBe(t0); // 読めないまま staleTtlMs を過ぎた
    const plan = wouldAcquire(others, later);
    expect(plan.stale.map((entry) => entry.pid)).toEqual([livePid]);
    expect(plan.acquire).toBe(true);

    readOthers(dir, selfPathIn(dir), { now: later, unreadableSince }); // 読めた
    expect(unreadableSince.size).toBe(0);
    readOthers(dir, selfPathIn(dir), { io, now: later, unreadableSince });
    expect(unreadableSince.size).toBe(1);
    fs.unlinkSync(filePath);
    readOthers(dir, selfPathIn(dir), { io, now: later, unreadableSince }); // 消えた
    expect(unreadableSince.size).toBe(0);
  });
});
