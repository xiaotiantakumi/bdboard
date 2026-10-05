import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVirtualTimers } from '../application/issue-report/external-issue-poll-test-support.js';
import type { CommandRunner } from '../application/ports/command-runner.js';
import { createExternalIssueRoutes, EXTERNAL_ISSUES_PATH, EXTERNAL_ISSUES_REFRESH_PATH } from '../interface/http/external-issue-routes.js';
import {
  createFakeGhAndBd,
  createTempMaintainerRoot,
  maxCallsInAnyWindow,
} from './external-issues-wiring-test-support.js';
import { wireExternalIssues } from './wire-external-issues.js';

/**
 * bdboard-4y8q.9.4 の受け入れ基準: 「gh の呼び出しは 1 時間に 12 回以下」。定期の確認・手動の refresh (60 秒に 1 回まで)・
 * ページ送り (1 回の確認で最大 3 ページ) のどの組み合わせでも、仮想の時計でどの 1 時間の窓を取っても 12 回を超えない。
 * 配線 (wireExternalIssues) とルートを本物のまま、gh と bd の起動だけを偽にして、gh の起動の時刻を数える。
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const LOCAL_ENV = { incoming: { socket: { remoteAddress: '127.0.0.1', localPort: 8787 } } };
const BUDGET_MESSAGE = 'gh call limit reached';

describe('gh runs per hour for incoming issues', () => {
  let removeRoot: () => Promise<void> = () => Promise.resolve();
  const stops: Array<() => void> = [];

  beforeEach(() => {
    removeRoot = () => Promise.resolve();
  });

  afterEach(async () => {
    for (const stop of stops.splice(0)) stop();
    await removeRoot();
  });

  interface Scenario {
    readonly env?: NodeJS.ProcessEnv;
    /** gh が持つ open issue の件数 (100 件ごとに 1 ページ。300 件で 3 ページ読む)。 */
    readonly issueCount: number;
    /** 1 分ごとに手動 refresh を送るか。 */
    readonly refreshEveryMinute: boolean;
    readonly hours: number;
  }

  async function simulate(scenario: Scenario) {
    const temp = await createTempMaintainerRoot();
    removeRoot = temp.remove;
    const timers = createVirtualTimers();
    const fake = createFakeGhAndBd();
    fake.setIssueCount(scenario.issueCount);
    const ghStartedAtMs: number[] = [];
    const runner: CommandRunner = {
      run(command, args, options) {
        if (command !== 'bd') ghStartedAtMs.push(timers.now());
        return fake.run(command, args, options);
      },
    };
    const wired = wireExternalIssues({
      repoRoot: temp.root,
      env: scenario.env ?? {},
      commandRunner: runner,
      log: vi.fn(),
      monotonicNow: timers.now,
      timers,
    });
    stops.push(wired.stop);
    const app = createExternalIssueRoutes({ service: wired.service, now: wired.now });
    const refresh = () =>
      app.request(
        EXTERNAL_ISSUES_REFRESH_PATH,
        { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost:8787' }, body: '{}' },
        LOCAL_ENV,
      );

    const refreshOutcomes: Array<{ status: number; state: string; detail: string | null }> = [];
    for (let minute = 1; minute <= scenario.hours * 60; minute += 1) {
      await timers.advanceTo(minute * MINUTE);
      if (scenario.refreshEveryMinute) {
        const res = await refresh();
        const body = (await res.json()) as { state?: string; error?: { detail: string } | null };
        refreshOutcomes.push({ status: res.status, state: body.state ?? '', detail: body.error?.detail ?? null });
      }
    }
    return { app, timers, fake, ghStartedAtMs, refreshOutcomes, wired };
  }

  it('hostile: the shortest interval, a refresh every minute, three pages each: at most 12 gh runs in any hour, and the cap is reached', async () => {
    const { ghStartedAtMs, refreshOutcomes, timers } = await simulate({
      env: { BDBOARD_EXTERNAL_ISSUES_INTERVAL_MS: '1000' },
      issueCount: 300,
      refreshEveryMinute: true,
      hours: 3,
    });

    expect(maxCallsInAnyWindow(ghStartedAtMs, HOUR)).toBe(12);
    // 3 時間を 1 時間ずつ切っても、どれも 12 回以内。
    for (let hour = 0; hour < 3; hour += 1) {
      const inHour = ghStartedAtMs.filter((at) => at >= hour * HOUR && at < (hour + 1) * HOUR);
      expect(inHour.length).toBeLessThanOrEqual(12);
    }
    expect(ghStartedAtMs.length).toBeGreaterThan(12);
    // 枠で止められた確認は、refresh の本文に「手元の上限」と出て、定期の確認は間隔を延ばす (1 時間まで)。
    expect(refreshOutcomes.some((outcome) => outcome.state === 'error' && outcome.detail?.includes(BUDGET_MESSAGE))).toBe(true);
    expect(refreshOutcomes.every((outcome) => outcome.status === 200)).toBe(true);
    expect(Math.max(...timers.created.map((timer) => timer.delayMs))).toBe(HOUR);
  }, 60_000);

  it('defaults, periodic checks only, three pages each: 12 gh runs an hour at the most, and none is refused', async () => {
    const { ghStartedAtMs, timers, wired } = await simulate({ issueCount: 300, refreshEveryMinute: false, hours: 3 });

    expect(maxCallsInAnyWindow(ghStartedAtMs, HOUR)).toBe(12);
    // 60 秒後に 1 回、その後 15 分おき: 3 時間で 12 回の確認 x 3 ページ。枠に止められたものは無い。
    expect(ghStartedAtMs).toHaveLength(36);
    expect(timers.created.map((timer) => timer.delayMs).filter((delay) => delay !== 15 * MINUTE)).toEqual([MINUTE]);
    expect(wired.service?.getList().state).toBe('ok');
  }, 60_000);

  it('manual refreshes every minute on top of the periodic checks, one page each: capped at 12 an hour, and it recovers when the hour has passed', async () => {
    const { ghStartedAtMs, refreshOutcomes } = await simulate({ issueCount: 1, refreshEveryMinute: true, hours: 3 });

    expect(maxCallsInAnyWindow(ghStartedAtMs, HOUR)).toBe(12);
    expect(ghStartedAtMs.length).toBeGreaterThan(12);
    expect(ghStartedAtMs.length).toBeLessThanOrEqual(36);
    const refused = refreshOutcomes.filter((outcome) => outcome.detail?.includes(BUDGET_MESSAGE));
    // 止められた refresh は 200 のまま「手元の上限」を本文で返し、gh は起動しない (起動の回数は上の窓の数え方に入っている)。
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.every((outcome) => outcome.status === 200)).toBe(true);
  }, 60_000);

  it('reading the list a thousand times starts no gh run', async () => {
    const { app, ghStartedAtMs } = await simulate({ issueCount: 300, refreshEveryMinute: false, hours: 1 });
    const before = ghStartedAtMs.length;

    for (let read = 0; read < 1000; read += 1) {
      await app.request(EXTERNAL_ISSUES_PATH, {}, LOCAL_ENV);
    }

    expect(ghStartedAtMs).toHaveLength(before);
  }, 60_000);
});
