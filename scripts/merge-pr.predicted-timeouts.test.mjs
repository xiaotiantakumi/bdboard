// bdboard-e8jj: 着地予定ツリーの verify が時間切れだけで落ちたときの記録 (scripts/merge-pr/predicted-timeouts.mjs) の単体。
// merge-pr 全体を回すテスト (scripts/merge-pr.load-retry.test.mjs) は POSIX だけなので、こちらは Windows の CI でも動かす
// (記録の読み書きは一時 git リポジトリの中だけ。偽の gh / bd は要らない)。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { forgetLoadInduced, judgePredictedFailure, rememberLoadInduced } from './merge-pr/predicted-timeouts.mjs';

const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const PR = 5;

const banner = (script, command) => `\n> bdboard@0.1.2 ${script}\n> ${command}\n`;
const vitestLog = (body, summary) =>
  `${banner('verify:steps', 'npm run check:file-size && npm run test:server')}${banner('test:server', 'vitest run')}\n RUN  v4.1.11 /repo\n\n${body}\n Test Files  ${summary}\n      Tests  4 failed | 100 passed (104)\n`;
const TIMEOUTS_ONLY = vitestLog(' FAIL  a.test.ts > one\nError: Test timed out in 5000ms.\n\n FAIL  b.test.ts > two\nError: Test timed out in 5000ms.\n', '2 failed | 100 passed (102)');
const ASSERTION = vitestLog(' FAIL  a.test.ts > one\nAssertionError: expected 1 to be 2\n', '1 failed | 1 passed (2)');

let root;
let logPath;
const stateDirectory = () => path.join(root, '.git', 'bdboard-merge');
const recordPath = (pr = PR) => path.join(stateDirectory(), `pr-${pr}-predicted-timeouts.json`);
const readRecord = (pr = PR) => JSON.parse(readFileSync(recordPath(pr), 'utf8'));
const logWith = (text) => {
  writeFileSync(logPath, text);
  return logPath;
};

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'predicted-timeouts-'));
  execFileSync('git', ['init', '-q', root]);
  logPath = path.join(root, 'verify.log');
});
afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('judgePredictedFailure', () => {
  it('reads a timeouts-only log as load-induced, and a first time when nothing is recorded', () => {
    expect(judgePredictedFailure(root, PR, HEAD, logWith(TIMEOUTS_ONLY))).toEqual({ loadInduced: true, timeouts: 2, etimedout: 0, repeated: false });
  });

  // bdboard-7qhq: 子プロセスの時間切れ (spawnSync ETIMEDOUT) の件数は、時間切れだけの失敗でも、他の失敗が混ざっていても数える。
  it('counts the spawnSync ETIMEDOUT headlines, also when the failure is not only timeouts', () => {
    const killed = ' FAIL  a.test.mjs > one\nError: spawnSync /bin/sh ETIMEDOUT\n\n FAIL  b.test.mjs > two\nError: spawnSync git ETIMEDOUT\n\n FAIL  c.test.ts > three\nError: Test timed out in 5000ms.\n';
    expect(judgePredictedFailure(root, PR, HEAD, logWith(vitestLog(killed, '3 failed | 1 passed (4)')))).toEqual({
      loadInduced: true,
      timeouts: 3,
      etimedout: 2,
      repeated: false,
    });
    const mixed = `${killed}\n FAIL  d.test.ts > four\nAssertionError: expected 1 to be 2\n`;
    expect(judgePredictedFailure(root, PR, HEAD, logWith(vitestLog(mixed, '4 failed | 1 passed (5)')))).toEqual({
      loadInduced: false,
      timeouts: 0,
      etimedout: 2,
      repeated: false,
    });
  });

  it('marks it repeated only for the recorded PR head of the same PR', () => {
    rememberLoadInduced(root, PR, HEAD);
    expect(judgePredictedFailure(root, PR, HEAD, logWith(TIMEOUTS_ONLY))).toMatchObject({ loadInduced: true, repeated: true });
    expect(judgePredictedFailure(root, PR, OTHER_HEAD, logPath)).toMatchObject({ loadInduced: true, repeated: false }); // 別の head
    expect(judgePredictedFailure(root, PR + 1, HEAD, logPath)).toMatchObject({ loadInduced: true, repeated: false }); // 別の PR
  });

  it('is never repeated for a failure that is not only timeouts, even with a record, and never writes', () => {
    rememberLoadInduced(root, PR, HEAD);
    const before = readFileSync(recordPath(), 'utf8');
    expect(judgePredictedFailure(root, PR, HEAD, logWith(ASSERTION))).toEqual({ loadInduced: false, timeouts: 0, etimedout: 0, repeated: false });
    expect(judgePredictedFailure(root, PR, HEAD, path.join(root, 'missing.log'))).toMatchObject({ loadInduced: false, repeated: false });
    expect(readFileSync(recordPath(), 'utf8')).toBe(before);
  });

  it.each([
    ['garbage', 'not json at all'],
    ['null', 'null'],
    ['an array', '[]'],
    ['a record with no head', '{"pr":5}'],
    ['a head that is not a string', '{"pr":5,"head":12345}'],
    ['an old record keyed on the tree', `{"pr":5,"tree":"${HEAD}"}`],
    ['an empty file', ''],
  ])('treats %s as no record (a first time) and rewrites it valid', (_name, content) => {
    mkdirSync(stateDirectory(), { recursive: true });
    writeFileSync(recordPath(), content);
    expect(judgePredictedFailure(root, PR, HEAD, logWith(TIMEOUTS_ONLY))).toMatchObject({ loadInduced: true, repeated: false });
    rememberLoadInduced(root, PR, HEAD);
    expect(readRecord()).toEqual({ pr: PR, head: HEAD });
    expect(judgePredictedFailure(root, PR, HEAD, logPath).repeated).toBe(true);
  });
});

describe('rememberLoadInduced / forgetLoadInduced', () => {
  it('writes { pr, head } atomically into the state directory, replaces an earlier head, and leaves no temporary file', () => {
    rememberLoadInduced(root, PR, HEAD);
    expect(readRecord()).toEqual({ pr: PR, head: HEAD });
    rememberLoadInduced(root, PR, OTHER_HEAD);
    expect(readRecord()).toEqual({ pr: PR, head: OTHER_HEAD });
    expect(readdirSync(stateDirectory())).toEqual([`pr-${PR}-predicted-timeouts.json`]);
  });

  it('forgets only its own PR record, and forgetting a missing record is fine', () => {
    rememberLoadInduced(root, PR, HEAD);
    rememberLoadInduced(root, PR + 1, HEAD);
    forgetLoadInduced(root, PR);
    expect(existsSync(recordPath())).toBe(false);
    expect(existsSync(recordPath(PR + 1))).toBe(true);
    expect(() => forgetLoadInduced(root, PR)).not.toThrow();
    expect(judgePredictedFailure(root, PR, HEAD, logWith(TIMEOUTS_ONLY)).repeated).toBe(false); // 成功で消した後は、また 1 回目
  });

  it('does not stop the procedure when it cannot write: one warning line with the error code only, no temporary file left', () => {
    mkdirSync(recordPath(), { recursive: true }); // 記録の場所にディレクトリがあると rename が失敗する
    const written = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    expect(() => rememberLoadInduced(root, PR, HEAD)).not.toThrow();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/^merge-pr: 警告: .*pr-5-predicted-timeouts\.json\) を書けませんでした \([A-Z]+\)。.*exit 75 の上限が効きません。\n$/);
    expect(readdirSync(stateDirectory())).toEqual([`pr-${PR}-predicted-timeouts.json`]); // 一時ファイルは消してある
    expect(judgePredictedFailure(root, PR, HEAD, logWith(TIMEOUTS_ONLY)).repeated).toBe(false); // 書けなかったので次も 1 回目
  });
});
