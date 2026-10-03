// bdboard-ky9l: scripts/merge-pr/verifying-record.mjs の判定表 (依存を差し替えた単体テスト)。
// 実プロセス・実 git を使った finish 全体の挙動は merge-pr.finish-identity.test.mjs にある。
import { describe, expect, it } from 'vitest';

import { judgeVerifyGroup, judgeVerifyingPid } from './merge-pr/verifying-record.mjs';

const MAX_AGE_MS = 2 * 60 * 60_000;
const NOW = Date.parse('2026-10-04T12:00:00.000Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

// 他の誰かの PID。process.pid とは違い、alive に差し替えた関数が「居る」と答える。
const OTHER = 424242;

const pidDeps = ({ identity, alive = true }) => ({ now: NOW, alive: () => alive, compare: () => identity });

describe('judgeVerifyingPid', () => {
  it('has nothing to say about a missing record, our own pid, or a pid that is gone', () => {
    expect(judgeVerifyingPid({}, MAX_AGE_MS, pidDeps({ identity: 'same' }))).toEqual({ running: false });
    expect(judgeVerifyingPid({ verifyingPid: null }, MAX_AGE_MS, pidDeps({ identity: 'same' }))).toEqual({ running: false });
    expect(judgeVerifyingPid({ verifyingPid: process.pid, verifyingAt: ago(0) }, MAX_AGE_MS, pidDeps({ identity: 'same' }))).toEqual({ running: false });
    expect(judgeVerifyingPid({ verifyingPid: OTHER, verifyingAt: ago(0) }, MAX_AGE_MS, pidDeps({ identity: 'same', alive: false }))).toEqual({ running: false });
  });

  it('same process: still running however old the record is (a verify over 2 hours, or a laptop that slept)', () => {
    for (const age of [0, MAX_AGE_MS - 1, MAX_AGE_MS + 1, 24 * 60 * 60_000]) {
      const verdict = judgeVerifyingPid({ verifyingPid: OTHER, verifyingAt: ago(age), verifyingStart: 'x' }, MAX_AGE_MS, pidDeps({ identity: 'same' }));
      expect(verdict).toMatchObject({ running: true, identity: 'same' });
      expect(verdict.stale).toBeUndefined();
    }
    // 時刻の無い記録でも、同一と分かっていれば実行中。
    expect(judgeVerifyingPid({ verifyingPid: OTHER, verifyingStart: 'x' }, MAX_AGE_MS, pidDeps({ identity: 'same' }))).toMatchObject({ running: true });
  });

  it('different process (PID reuse): a stale record even when it was written a moment ago', () => {
    for (const age of [0, 1_000, MAX_AGE_MS + 1]) {
      expect(judgeVerifyingPid({ verifyingPid: OTHER, verifyingAt: ago(age), verifyingStart: 'x' }, MAX_AGE_MS, pidDeps({ identity: 'different' }))).toMatchObject({
        running: false,
        stale: 'reused',
      });
    }
  });

  it('identity unknown: falls back to the age cut-off, and a record without a time is judged by the pid alone', () => {
    const unknown = pidDeps({ identity: 'unknown' });
    expect(judgeVerifyingPid({ verifyingPid: OTHER, verifyingAt: ago(MAX_AGE_MS - 1) }, MAX_AGE_MS, unknown)).toMatchObject({ running: true, identity: 'unknown' });
    expect(judgeVerifyingPid({ verifyingPid: OTHER, verifyingAt: ago(MAX_AGE_MS) }, MAX_AGE_MS, unknown)).toMatchObject({ running: true });
    expect(judgeVerifyingPid({ verifyingPid: OTHER, verifyingAt: ago(MAX_AGE_MS + 1) }, MAX_AGE_MS, unknown)).toMatchObject({ running: false, stale: 'aged' });
    expect(judgeVerifyingPid({ verifyingPid: OTHER }, MAX_AGE_MS, unknown)).toMatchObject({ running: true, ageMs: null });
    expect(judgeVerifyingPid({ verifyingPid: OTHER, verifyingAt: 'not-a-date' }, MAX_AGE_MS, unknown)).toMatchObject({ running: true, ageMs: null });
  });

  it('asks the comparison about the recorded start time of that pid', () => {
    const asked = [];
    judgeVerifyingPid({ verifyingPid: OTHER, verifyingAt: ago(0), verifyingStart: '2026-10-04T11:00:00.000Z' }, MAX_AGE_MS, {
      now: NOW,
      alive: () => true,
      compare: (pid, recorded) => {
        asked.push([pid, recorded]);
        return 'same';
      },
    });
    expect(asked).toEqual([[OTHER, '2026-10-04T11:00:00.000Z']]);
  });
});

describe('judgeVerifyGroup', () => {
  const groupDeps = ({ groupAlive = true, leaderAlive = true, identity = 'unknown' }) => ({
    now: NOW,
    groupAlive: () => groupAlive,
    alive: () => leaderAlive,
    compare: () => identity,
  });

  it('has nothing to say when nothing was recorded or the group is empty', () => {
    expect(judgeVerifyGroup({}, MAX_AGE_MS, groupDeps({}))).toEqual({ running: false });
    expect(judgeVerifyGroup({ verifyPgid: null }, MAX_AGE_MS, groupDeps({}))).toEqual({ running: false });
    expect(judgeVerifyGroup({ verifyPgid: OTHER, verifyPgidAt: ago(0) }, MAX_AGE_MS, groupDeps({ groupAlive: false }))).toEqual({ running: false });
  });

  it('a group with members but a dead leader is the original group: the pid cannot be reused while the group exists', () => {
    // 開始時刻の記録が無くても、時間が経っていても、リーダー無しなら孤児が居る。
    for (const record of [{ verifyPgid: OTHER }, { verifyPgid: OTHER, verifyPgidAt: ago(24 * 60 * 60_000), verifyPgidStart: 'x' }]) {
      expect(judgeVerifyGroup(record, MAX_AGE_MS, groupDeps({ leaderAlive: false, identity: 'different' }))).toMatchObject({ running: true, identity: 'leaderless' });
    }
  });

  it('a live leader is compared by its start time: same is running at any age, different is a reused pid', () => {
    const record = { verifyPgid: OTHER, verifyPgidAt: ago(MAX_AGE_MS + 60_000), verifyPgidStart: 'x' };
    expect(judgeVerifyGroup(record, MAX_AGE_MS, groupDeps({ identity: 'same' }))).toMatchObject({ running: true, identity: 'same' });
    expect(judgeVerifyGroup({ ...record, verifyPgidAt: ago(0) }, MAX_AGE_MS, groupDeps({ identity: 'different' }))).toMatchObject({ running: false, stale: 'reused' });
  });

  it('a live leader of unknown identity falls back to the age of the record', () => {
    const unknown = groupDeps({ identity: 'unknown' });
    expect(judgeVerifyGroup({ verifyPgid: OTHER, verifyPgidAt: ago(60_000) }, MAX_AGE_MS, unknown)).toMatchObject({ running: true });
    expect(judgeVerifyGroup({ verifyPgid: OTHER, verifyPgidAt: ago(MAX_AGE_MS + 1) }, MAX_AGE_MS, unknown)).toMatchObject({ running: false, stale: 'aged' });
    expect(judgeVerifyGroup({ verifyPgid: OTHER }, MAX_AGE_MS, unknown)).toMatchObject({ running: true, ageMs: null });
  });
});
