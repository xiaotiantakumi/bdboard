/**
 * bdboard-4y8q.6.10 (レビュー F1): 保存に失敗した報告を tracker に返す `release(report)`。
 *
 * tracker は聞いた時点で throttle に記録する。保存に失敗した報告は、キーを忘れるだけでは足りない: 文が更新ごとにずれる失敗の報告は、
 * 「同じ kind の連続がちょうど 3 回になった回」だけが due で、忘れたキーは二度と due にならない (その連続が続く間は、下書きが 1 件もできない)。
 * そこで release は、連続がまだ閾値のままなら、次にその kind が見えた結果を再び due にする (owed)。
 */
import { describe, expect, it } from 'vitest';
import { createRefreshErrorTracker, selfErrorKey } from './refresh-error-tracker.js';
import type { RefreshErrorInput, RefreshErrorProject, RefreshErrorTracker, SelfErrorReport } from './refresh-error-tracker.js';
import { createSelfErrorThrottle } from './self-error-throttle.js';

const BASE = new Date('2026-10-06T00:00:00.000Z').getTime();
const MINUTE = 60_000;
const at = (offsetMs: number): Date => new Date(BASE + offsetMs);

const alpha: RefreshErrorProject = { id: 'alpha', name: 'alpha-project', rootPath: '/work/alpha', aliasPaths: [], prefixes: ['alp'] };
const beta: RefreshErrorProject = { id: 'beta', name: 'beta-project', rootPath: '/work/beta', aliasPaths: [], prefixes: ['bet'] };
const projects = [alpha, beta];

type Err = RefreshErrorInput['errors'][number];
const err = (projectId: string, kind: string, detail: string): Err => ({ projectId, kind, detail });
const result = (errors: readonly Err[] = [], refreshed: readonly string[] = []): RefreshErrorInput => ({ errors, refreshed, removed: [] });
function releaseAll(tracker: RefreshErrorTracker, reports: readonly SelfErrorReport[]): void {
  for (const report of reports) tracker.release(report);
}
/** 文が更新ごとにずれて、normalizeErrorText でも寄らない失敗 (単語が違う)。 */
const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
const shifting = (round: number, projectId = 'alpha', kind = 'unknown'): RefreshErrorInput =>
  result([err(projectId, kind, `database ${WORDS[round] ?? 'zulu'} is not reachable`)]);

describe('the shifting texts really do not fold (so only the per-kind run can report them)', () => {
  it('has a different key for every round', () => {
    const keys = new Set(WORDS.map((_word, round) => selfErrorKey('unknown', `database ${WORDS[round]} is not reachable`)));
    expect(keys.size).toBe(WORDS.length);
  });
});

describe('release(): a report whose save failed, issued by the kind run (shifting text)', () => {
  it('forgets the key and reports again on the next sighting of the kind, whatever its text is', () => {
    const throttle = createSelfErrorThrottle();
    const tracker = createRefreshErrorTracker({ throttle });
    expect(tracker.observe(shifting(0), projects, at(0))).toEqual([]);
    expect(tracker.observe(shifting(1), projects, at(MINUTE))).toEqual([]);
    const reports = tracker.observe(shifting(2), projects, at(2 * MINUTE));
    expect(reports).toHaveLength(1);
    expect(throttle.size()).toBe(1);
    releaseAll(tracker, reports);
    expect(throttle.size()).toBe(0);
    const again = tracker.observe(shifting(3), projects, at(3 * MINUTE));
    expect(again).toHaveLength(1);
    expect(again[0]?.errorText).toBe('database delta is not reachable');
  });

  it('keeps reporting on every next sighting while the saves keep failing, and stops after the first save that succeeded', () => {
    const tracker = createRefreshErrorTracker();
    const counts: number[] = [];
    for (let round = 0; round < 8; round += 1) {
      const reports = tracker.observe(shifting(round), projects, at(round * MINUTE));
      counts.push(reports.length);
      // 3 回目 (round 2) から round 4 までは保存に失敗し、round 5 の保存は成功する。
      if (round >= 2 && round <= 4) for (const report of reports) tracker.release(report);
    }
    expect(counts).toEqual([0, 0, 1, 1, 1, 1, 0, 0]);
  });

  it('does not re-arm when a refresh that succeeded came in before the release (the run started over)', () => {
    const tracker = createRefreshErrorTracker();
    tracker.observe(shifting(0), projects, at(0));
    tracker.observe(shifting(1), projects, at(MINUTE));
    const reports = tracker.observe(shifting(2), projects, at(2 * MINUTE));
    // 保存が終わらない間に、成功した更新 (alpha が refreshed に入り、errors に無い) が入った。
    tracker.observe(result([], ['alpha']), projects, at(3 * MINUTE));
    for (const report of reports) tracker.release(report);
    // 連続は数え直し: 2 回では報告しない。
    expect(tracker.observe(shifting(3), projects, at(4 * MINUTE))).toEqual([]);
    expect(tracker.observe(shifting(4), projects, at(5 * MINUTE))).toEqual([]);
    expect(tracker.observe(shifting(5), projects, at(6 * MINUTE))).toHaveLength(1);
  });

  it('forgets the debt when a refresh that succeeded comes in after the release', () => {
    const tracker = createRefreshErrorTracker();
    tracker.observe(shifting(0), projects, at(0));
    tracker.observe(shifting(1), projects, at(MINUTE));
    for (const report of tracker.observe(shifting(2), projects, at(2 * MINUTE))) tracker.release(report);
    tracker.observe(result([], ['alpha']), projects, at(3 * MINUTE));
    expect(tracker.observe(shifting(3), projects, at(4 * MINUTE))).toEqual([]);
    expect(tracker.observe(shifting(4), projects, at(5 * MINUTE))).toEqual([]);
    expect(tracker.observe(shifting(5), projects, at(6 * MINUTE))).toHaveLength(1);
  });

  it('keeps the debt across a partial refresh that did not look at the project', () => {
    const tracker = createRefreshErrorTracker();
    tracker.observe(shifting(0), projects, at(0));
    tracker.observe(shifting(1), projects, at(MINUTE));
    for (const report of tracker.observe(shifting(2), projects, at(2 * MINUTE))) tracker.release(report);
    tracker.observe(result([], ['beta']), projects, at(3 * MINUTE));
    expect(tracker.observe(shifting(3), projects, at(4 * MINUTE))).toHaveLength(1);
  });

  it('does not use up the hourly slot twice: a debt for a key that is still inside the hour stays owed', () => {
    const throttle = createSelfErrorThrottle();
    const tracker = createRefreshErrorTracker({ throttle });
    tracker.observe(shifting(0), projects, at(0));
    tracker.observe(shifting(1), projects, at(MINUTE));
    for (const report of tracker.observe(shifting(2), projects, at(2 * MINUTE))) tracker.release(report);
    // 次の文は、1 時間以内に報告済みのキー (別の経路で記録された) と同じ: throttle が止める。借りは消えない。
    throttle.shouldReport(selfErrorKey('unknown', 'database delta is not reachable'), at(2 * MINUTE));
    expect(tracker.observe(shifting(3), projects, at(3 * MINUTE))).toEqual([]);
    expect(tracker.observe(shifting(4), projects, at(4 * MINUTE))).toHaveLength(1);
  });

  it('is per project and per kind: a debt of one does not make the other due', () => {
    const tracker = createRefreshErrorTracker();
    for (let round = 0; round < 2; round += 1) tracker.observe(shifting(round, 'alpha'), projects, at(round * MINUTE));
    for (const report of tracker.observe(shifting(2, 'alpha'), projects, at(2 * MINUTE))) tracker.release(report);
    expect(tracker.observe(shifting(3, 'beta'), projects, at(3 * MINUTE))).toEqual([]);
    expect(tracker.observe(shifting(3, 'alpha', 'timeout'), projects, at(3 * MINUTE))).toEqual([]);
    expect(tracker.observe(shifting(3, 'alpha'), projects, at(4 * MINUTE))).toHaveLength(1);
  });

  it('drops the debt of a project that went away', () => {
    const tracker = createRefreshErrorTracker();
    tracker.observe(shifting(0), projects, at(0));
    tracker.observe(shifting(1), projects, at(MINUTE));
    for (const report of tracker.observe(shifting(2), projects, at(2 * MINUTE))) tracker.release(report);
    tracker.observe({ errors: [], refreshed: [], removed: ['alpha'] }, [beta], at(3 * MINUTE));
    // alpha が戻ってきても、前の連続は引き継がない。
    expect(tracker.observe(shifting(3), projects, at(4 * MINUTE))).toEqual([]);
    expect(tracker.observe(shifting(4), projects, at(5 * MINUTE))).toEqual([]);
    expect(tracker.observe(shifting(5), projects, at(6 * MINUTE))).toHaveLength(1);
  });
});

describe('release(): reports that need no debt', () => {
  it('forgets the key of a report issued by the same key three times in a row, and does not owe the kind (the same key is due again by itself)', () => {
    const throttle = createSelfErrorThrottle();
    const tracker = createRefreshErrorTracker({ throttle });
    const same = result([err('alpha', 'unknown', 'dolt server unreachable')]);
    tracker.observe(same, projects, at(0));
    tracker.observe(same, projects, at(MINUTE));
    const reports = tracker.observe(same, projects, at(2 * MINUTE));
    expect(reports).toHaveLength(1);
    releaseAll(tracker, reports);
    expect(throttle.size()).toBe(0);
    // 同じ文はもう一度報告する。別の文は、借りが無いので報告しない。
    expect(tracker.observe(shifting(0), projects, at(3 * MINUTE))).toEqual([]);
    expect(tracker.observe(same, projects, at(4 * MINUTE))).toHaveLength(1);
  });

  it('forgets the key of a deterministic kind and reports the same text again on the next refresh', () => {
    const throttle = createSelfErrorThrottle();
    const tracker = createRefreshErrorTracker({ throttle });
    const broken = result([err('alpha', 'schema-mismatch', 'bad json')]);
    const reports = tracker.observe(broken, projects, at(0));
    expect(reports).toHaveLength(1);
    releaseAll(tracker, reports);
    expect(tracker.observe(broken, projects, at(MINUTE))).toHaveLength(1);
    // 保存できたあとは 1 時間に 1 回。
    expect(tracker.observe(broken, projects, at(2 * MINUTE))).toEqual([]);
  });

  it('ignores a report this tracker did not issue, and a report released twice', () => {
    const throttle = createSelfErrorThrottle();
    const tracker = createRefreshErrorTracker({ throttle });
    tracker.release({ source: 'bd-refresh:unknown', errorText: 'x', project: { name: 'alpha-project', path: '/work/alpha' } });
    const reports = tracker.observe(result([err('alpha', 'schema-mismatch', 'bad json')]), projects, at(0));
    releaseAll(tracker, reports);
    // 2 回目の release は何もしない: そのあいだに別の経路が記録したキーを巻き込まない。
    throttle.shouldReport(selfErrorKey('schema-mismatch', 'bad json'), at(MINUTE));
    releaseAll(tracker, reports);
    expect(throttle.size()).toBe(1);
  });
});
