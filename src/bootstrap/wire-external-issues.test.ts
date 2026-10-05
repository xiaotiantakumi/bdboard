import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVirtualTimers } from '../application/issue-report/external-issue-poll-test-support.js';
import { createHarness } from '../application/issue-report/external-issue-test-support.js';
import { createFakeGhAndBd, createTempMaintainerRoot } from './external-issues-wiring-test-support.js';
import { wireExternalIssues, type WireExternalIssuesDeps } from './wire-external-issues.js';

/** bdboard-4y8q.9.4: 配線。メンテナ環境だけで動き、gh は 1 時間 12 回の枠を通る。 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('wireExternalIssues', () => {
  let root = '';
  let removeRoot: () => Promise<void> = () => Promise.resolve();
  const wired: Array<{ stop: () => void }> = [];

  beforeEach(async () => {
    ({ root, remove: removeRoot } = await createTempMaintainerRoot());
  });

  afterEach(async () => {
    for (const each of wired.splice(0)) each.stop();
    vi.resetAllMocks();
    vi.restoreAllMocks();
    vi.useRealTimers();
    await removeRoot();
  });

  /** 仮想の時計・偽の gh/bd・一時のメンテナ checkout で配線する。 */
  function setup(overrides: Partial<WireExternalIssuesDeps> = {}) {
    const timers = createVirtualTimers();
    const fake = createFakeGhAndBd();
    const log = vi.fn<(message: string) => void>();
    const result = wireExternalIssues({
      repoRoot: root,
      env: {},
      commandRunner: fake.runner,
      log,
      monotonicNow: timers.now,
      timers,
      ...overrides,
    });
    wired.push(result);
    return { result, timers, fake, log };
  }

  describe('outside the maintainer environment', () => {
    it('creates nothing: no timer, no gh or bd call, no snapshot directory', async () => {
      const outsider = await fs.mkdtemp(path.join(os.tmpdir(), 'external-issues-outsider-'));
      try {
        await fs.mkdir(path.join(outsider, '.git'));
        const { result, timers, fake, log } = setup({ repoRoot: outsider });

        expect(result.enabled).toBe(false);
        expect(result.service).toBeUndefined();
        expect(timers.created).toHaveLength(0);
        expect(fake.run).not.toHaveBeenCalled();
        expect(log).not.toHaveBeenCalled();
        await expect(fs.access(path.join(outsider, 'data'))).rejects.toThrow();
        expect(() => {
          result.stop();
          result.stop();
        }).not.toThrow();
      } finally {
        await fs.rm(outsider, { recursive: true, force: true });
      }
    });

    it('treats a missing .beads as outside even when a runner is given (the default check is the .beads directory)', async () => {
      await fs.rm(path.join(root, '.beads'), { recursive: true });
      const { result, timers } = setup();
      expect(result.enabled).toBe(false);
      expect(timers.created).toHaveLength(0);
    });
  });

  describe('without a command runner', () => {
    it('stays disabled even in the maintainer environment', () => {
      const { result, timers } = setup({ commandRunner: undefined });
      expect(result.enabled).toBe(false);
      expect(result.service).toBeUndefined();
      expect(timers.created).toHaveLength(0);
    });

    it('is enabled with injected ports, which replace gh, bd and the snapshot directory', async () => {
      const harness = createHarness();
      const { result, timers } = setup({
        commandRunner: undefined,
        ports: { source: harness.source, refReader: harness.refReader, storage: harness.storage },
      });

      expect(result.enabled).toBe(true);
      await timers.advanceTo(MINUTE);
      expect(harness.source.listOpenIssues).toHaveBeenCalledTimes(1);
    });
  });

  describe('in the maintainer environment', () => {
    it('places one timer 60 seconds out, unref-ed, and calls neither gh nor bd until it fires', () => {
      const { result, timers, fake, log } = setup();

      expect(result.enabled).toBe(true);
      expect(result.service).toBeDefined();
      expect(timers.created.map((timer) => timer.delayMs)).toEqual([MINUTE]);
      expect(timers.created[0]?.unrefs).toBe(1);
      expect(fake.run).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('external issues: enabled'));
    });

    it('checks with the read-only gh and bd commands, and keeps the snapshot under data/external-issues', async () => {
      const { result, timers, fake } = setup();

      await timers.advanceTo(MINUTE);

      expect(fake.ghCalls()).toEqual([
        [
          'gh',
          [
            'api',
            '--method',
            'GET',
            '--hostname',
            'github.com',
            'repos/xiaotiantakumi/bdboard/issues?state=open&per_page=100&page=1',
            '--jq',
            expect.stringContaining('.[] | {number, title'),
          ],
        ],
      ]);
      expect(fake.bdCalls()).toEqual([['bd', ['--readonly', '-C', root, 'list', '--all', '--json', '--limit', '0', '--brief', '--no-pager']]]);
      expect(result.service?.getList()).toMatchObject({ state: 'ok', issues: [{ number: 1 }] });
      expect(await fs.readdir(path.join(root, 'data', 'external-issues'))).toHaveLength(1);
    });

    it('never gives gh a write method or a body option', async () => {
      const { timers, fake } = setup();
      await timers.advanceTo(3 * HOUR);

      expect(fake.ghCalls().length).toBeGreaterThan(0);
      for (const [command, args] of fake.ghCalls()) {
        expect(command).toBe('gh');
        expect(args.slice(0, 5)).toEqual(['api', '--method', 'GET', '--hostname', 'github.com']);
        // arrayContaining は全部が揃ったときだけ一致するので、not と組むと 1 つ混ざっても通ってしまう。1 つずつ確かめる。
        for (const forbidden of ['-X', '-f', '-F', '--field', '--raw-field', '--input', '--paginate']) {
          expect(args).not.toContain(forbidden);
        }
      }
    });

    it('uses BDBOARD_GH_PATH and BDBOARD_BD_PATH for the commands', async () => {
      const { timers, fake } = setup({ env: { BDBOARD_GH_PATH: '/example/bin/gh', BDBOARD_BD_PATH: '/example/bin/bd' } });
      await timers.advanceTo(MINUTE);
      expect(fake.ghCalls()[0]?.[0]).toBe('/example/bin/gh');
      expect(fake.bdCalls()[0]?.[0]).toBe('/example/bin/bd');
    });

    it('checks again one interval after the previous check finished', async () => {
      const { timers, fake } = setup();
      await timers.advanceTo(MINUTE + 15 * MINUTE - 1);
      expect(fake.ghCalls()).toHaveLength(1);
      await timers.advanceTo(MINUTE + 15 * MINUTE);
      expect(fake.ghCalls()).toHaveLength(2);
    });

    it('stops at shutdown: the timer is cleared, nothing runs later, and stop can be called again', async () => {
      const { result, timers, fake } = setup();

      result.stop();
      result.stop();
      await timers.advanceTo(10 * HOUR);

      expect(timers.pending()).toHaveLength(0);
      expect(timers.created[0]?.cleared).toBe(true);
      expect(fake.run).not.toHaveBeenCalled();
    });

    it('uses real unref-ed timers by default and clears them on stop', async () => {
      vi.useFakeTimers();
      const fake = createFakeGhAndBd();
      const result = wireExternalIssues({ repoRoot: root, env: {}, commandRunner: fake.runner, log: vi.fn() });
      wired.push(result);

      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(MINUTE);
      // 動き出した確認が終わるまで待つ (実行中の poll を呼ぶと、その実行の結果が返る)。
      await result.service?.poll();
      expect(fake.ghCalls()).toHaveLength(1);

      result.stop();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('writes the log with console.log when no log function is given', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const { timers, fake } = setup({ log: undefined });
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('external issues: enabled'));
      expect(timers.created).toHaveLength(1);
      expect(fake.run).not.toHaveBeenCalled();
    });

    it('defaults the clock to the monotonic one (a wall-clock jump cannot free the gh budget early)', () => {
      const before = performance.now();
      const { result } = setup({ monotonicNow: undefined });
      const reading = result.now();
      expect(reading).toBeGreaterThanOrEqual(before);
      expect(reading).toBeLessThan(before + 1000);
    });
  });

  describe('the interval', () => {
    it.each([
      ['unset', undefined, 15 * MINUTE],
      ['600000', '600000', 10 * MINUTE],
      ['1000 (below the floor)', '1000', 5 * MINUTE],
      ['0', '0', 5 * MINUTE],
      ['not a number', 'abc', 15 * MINUTE],
      ['99999999999 (above the ceiling)', '99999999999', 24 * HOUR],
    ])('takes %s as %d ms', async (_label, value, expectedMs) => {
      const { timers } = setup({ env: value === undefined ? {} : { BDBOARD_EXTERNAL_ISSUES_INTERVAL_MS: value } });
      await timers.advanceTo(MINUTE);
      // 最初の確認 (60 秒後) が終わって次が置かれた: その間隔。
      expect(timers.created.map((timer) => timer.delayMs)).toEqual([MINUTE, expectedMs]);
    });
  });

  describe('when the check fails', () => {
    it('doubles the interval up to one hour on rate limits, logs only the kind, and goes back after a good check', async () => {
      const { result, timers, fake, log } = setup();
      fake.setGhResult({ stdout: '', stderr: 'API rate limit exceeded for user (HTTP 403)', exitCode: 1 });

      await timers.advanceTo(MINUTE + 30 * MINUTE + HOUR + HOUR);
      expect(timers.created.slice(0, 4).map((timer) => timer.delayMs)).toEqual([MINUTE, 30 * MINUTE, HOUR, HOUR]);
      expect(result.service?.getList()).toMatchObject({ state: 'error', error: { kind: 'rate-limited' } });
      expect(log).toHaveBeenCalledWith('external issues: poll failed (rate-limited)');
      expect(log.mock.calls.flat().join('\n')).not.toContain('API rate limit exceeded');

      fake.setGhResult(undefined);
      await timers.advanceTo(timers.now() + HOUR);
      expect(timers.created.at(-1)?.delayMs).toBe(15 * MINUTE);
      expect(result.service?.getList().state).toBe('ok');
    });
  });

  describe('the gh call limit', () => {
    it('lets 12 gh runs through in an hour, refuses the 13th as a failed check, and starts again when the hour has passed', async () => {
      const { result, timers, fake } = setup();
      const service = result.service;
      if (service === undefined) throw new Error('expected the service');

      for (let check = 0; check < 12; check += 1) {
        expect((await service.poll()).state).toBe('ok');
      }
      expect(fake.ghCalls()).toHaveLength(12);

      const refused = await service.poll();
      expect(refused).toMatchObject({ state: 'error', error: { kind: 'failed' } });
      expect(refused.error?.detail).toContain('gh call limit reached');
      expect(fake.ghCalls()).toHaveLength(12);

      await timers.advanceTo(HOUR);
      expect((await service.poll()).state).toBe('ok');
      expect(fake.ghCalls()).toHaveLength(13);
    });

    it('does not count bd runs against the gh limit (12 good checks make 12 bd runs and no failure)', async () => {
      const { result, fake } = setup();
      for (let check = 0; check < 12; check += 1) {
        expect((await result.service?.poll())?.state).toBe('ok');
      }
      // bd も枠に数えていたら、6 回目で枠 (12) が尽きて失敗する。
      expect(fake.bdCalls()).toHaveLength(12);
      expect(fake.ghCalls()).toHaveLength(12);
    });

    it('counts every page of one check as a gh run', async () => {
      const { result, fake } = setup();
      fake.setIssueCount(300);

      await result.service?.poll();
      expect(fake.ghCalls()).toHaveLength(3);
      for (let check = 0; check < 3; check += 1) await result.service?.poll();

      // 3 ページ x 4 回 = 12。5 回目は 1 ページも始まらない。
      expect(fake.ghCalls()).toHaveLength(12);
      const refused = await result.service?.poll();
      expect(refused?.error?.detail).toContain('gh call limit reached');
      expect(fake.ghCalls()).toHaveLength(12);
    });
  });
});
