// bdboard-ky9l: scripts/merge-pr/verifying-record.mjs の判定表 (依存を差し替えた単体テスト)。
// 実プロセス・実 git を使った finish 全体の挙動は merge-pr.finish-identity.test.mjs にある。
import { describe, expect, it } from 'vitest';

import { groupInspectLines, groupProceedLines } from './merge-pr/verify-guard.mjs';
import { judgeVerifyGroup, judgeVerifyingPid, LEADERLESS_GROUP_MAX_AGE_MS } from './merge-pr/verifying-record.mjs';

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

  it('a group with members but a dead leader is the original group while it is within the cap: the pid cannot be reused while the group exists', () => {
    // 開始時刻の記録が無くても、開始時刻が食い違っていても、上限以内でリーダー無しなら孤児が居る。
    for (const record of [{ verifyPgid: OTHER }, { verifyPgid: OTHER, verifyPgidAt: ago(MAX_AGE_MS - 1), verifyPgidStart: 'x' }]) {
      expect(judgeVerifyGroup(record, MAX_AGE_MS, groupDeps({ leaderAlive: false, identity: 'different' }))).toMatchObject({ running: true, identity: 'leaderless' });
    }
  });

  // bdboard-h2fk: リーダー不在のグループに年齢の上限を付ける。
  describe('a leaderless group older than the cap (bdboard-h2fk)', () => {
    const leaderless = groupDeps({ leaderAlive: false, identity: 'different' });

    it('is unknown, not running: finish prints advice and goes on instead of returning 75 forever', () => {
      for (const age of [LEADERLESS_GROUP_MAX_AGE_MS + 1, 24 * 60 * 60_000]) {
        const verdict = judgeVerifyGroup({ verifyPgid: OTHER, verifyPgidAt: ago(age), verifyPgidStart: 'x' }, MAX_AGE_MS, leaderless);
        expect(verdict).toEqual({ running: false, unknown: true, identity: 'leaderless', ageMs: age });
        expect(verdict.stale).toBeUndefined(); // 「古い記録」ではない: 元の verify かが分からないだけ
      }
    });

    it('is still running at exactly the cap (the boundary stays on the side that does not start a second verify)', () => {
      expect(judgeVerifyGroup({ verifyPgid: OTHER, verifyPgidAt: ago(LEADERLESS_GROUP_MAX_AGE_MS) }, MAX_AGE_MS, leaderless)).toMatchObject({ running: true, identity: 'leaderless' });
    });

    it('the cap is 2 hours by default: over the longest realistic verify (10-20 minutes under load) with room to spare', () => {
      expect(LEADERLESS_GROUP_MAX_AGE_MS).toBe(2 * 60 * 60_000);
      expect(LEADERLESS_GROUP_MAX_AGE_MS).toBeGreaterThanOrEqual(6 * 20 * 60_000);
    });

    it('the cap can be injected through deps.leaderlessMaxAgeMs, independently of maxAgeMs', () => {
      const short = { ...leaderless, leaderlessMaxAgeMs: 1_000 };
      expect(judgeVerifyGroup({ verifyPgid: OTHER, verifyPgidAt: ago(2_000) }, MAX_AGE_MS, short)).toMatchObject({ running: false, unknown: true });
      expect(judgeVerifyGroup({ verifyPgid: OTHER, verifyPgidAt: ago(500) }, MAX_AGE_MS, short)).toMatchObject({ running: true });
      const long = { ...leaderless, leaderlessMaxAgeMs: 10 * MAX_AGE_MS };
      expect(judgeVerifyGroup({ verifyPgid: OTHER, verifyPgidAt: ago(3 * MAX_AGE_MS) }, MAX_AGE_MS, long)).toMatchObject({ running: true });
    });

    it('a record whose time cannot be read has no age to compare: it stays on the running side', () => {
      expect(judgeVerifyGroup({ verifyPgid: OTHER }, MAX_AGE_MS, leaderless)).toMatchObject({ running: true, ageMs: null });
      expect(judgeVerifyGroup({ verifyPgid: OTHER, verifyPgidAt: 'not-a-date' }, MAX_AGE_MS, leaderless)).toMatchObject({ running: true, ageMs: null });
    });

    it('does not touch a live leader: the same process is running however old, and the cap is not the unknown-identity fallback', () => {
      const old = { verifyPgid: OTHER, verifyPgidAt: ago(24 * 60 * 60_000), verifyPgidStart: 'x' };
      expect(judgeVerifyGroup(old, MAX_AGE_MS, groupDeps({ identity: 'same' }))).toMatchObject({ running: true, identity: 'same' });
      expect(judgeVerifyGroup(old, MAX_AGE_MS, groupDeps({ identity: 'unknown' }))).toMatchObject({ running: false, stale: 'aged' });
    });
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

// bdboard-h2fk: 孤児かもしれないグループへの案内の文面 (verify-guard.mjs)。
describe('advice for a possibly-orphaned verify group', () => {
  it('prints the pgid through shellQuote and always puts the pgrep check before the kill', () => {
    const [check, kill] = groupInspectLines(OTHER);
    expect(check).toContain(`pgrep -g ${OTHER} -l`);
    expect(kill).toContain(`kill -TERM -${OTHER}`);
    // 文字列の pgid (状態ファイルを手で書き換えた等) もシェルの単一引用符で囲み、コマンドとして解釈させない。
    const [quotedCheck, quotedKill] = groupInspectLines('1; echo pwned');
    expect(quotedCheck).toContain("pgrep -g '1; echo pwned' -l");
    expect(quotedKill).toContain("kill -TERM -'1; echo pwned'");
    expect(quotedKill).toContain("kill -KILL -'1; echo pwned'");
  });

  it('says nothing for a verdict that stops the caller, a stale record only ignores, and unknown is advice that checks before killing', () => {
    const record = { verifyPgid: OTHER, verifyPgidAt: ago(3 * 60 * 60_000) };
    expect(groupProceedLines(7, record, { running: false }, '着地後検証を進めます')).toEqual([]);
    const stale = groupProceedLines(7, record, { running: false, stale: 'reused' }, '着地後検証を進めます');
    expect(stale.join('\n')).toContain('別のプロセスに再利用された古い記録なので無視します');
    expect(stale.join('\n')).not.toContain('kill');
    const unknown = groupProceedLines(7, record, { running: false, unknown: true, identity: 'leaderless', ageMs: 3 * 60 * 60_000 }, '着地後検証を進めます').join('\n');
    expect(unknown).toContain('元の verify かは不明です');
    expect(unknown).toContain('止めずに、着地後検証を進めます');
    expect(unknown.indexOf(`pgrep -g ${OTHER} -l`)).toBeGreaterThan(-1);
    expect(unknown.indexOf(`kill -TERM -${OTHER}`)).toBeGreaterThan(unknown.indexOf(`pgrep -g ${OTHER} -l`));
  });
});
