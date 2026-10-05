import { describe, expect, it } from 'vitest';
import {
  REFRESH_ERROR_MAX_KEYS_PER_PROJECT,
  REFRESH_ERROR_TRANSIENT_KINDS,
  REFRESH_ERROR_TRANSIENT_THRESHOLD,
  createRefreshErrorTracker,
} from './refresh-error-tracker.js';
import type { RefreshErrorInput, RefreshErrorProject } from './refresh-error-tracker.js';
import { createSelfErrorThrottle } from './self-error-throttle.js';

const BASE = new Date('2026-10-05T00:00:00.000Z').getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const at = (offsetMs: number): Date => new Date(BASE + offsetMs);

const alpha: RefreshErrorProject = {
  id: 'alpha',
  name: 'alpha-project',
  rootPath: '/work/alpha',
  aliasPaths: [],
  prefixes: ['alp'],
};
const beta: RefreshErrorProject = {
  id: 'beta',
  name: 'beta-project',
  rootPath: '/work/beta',
  aliasPaths: [],
  prefixes: ['bet'],
};
const projects = [alpha, beta];

type Err = RefreshErrorInput['errors'][number];
const err = (projectId: string, kind = 'unknown', detail = 'failure'): Err => ({ projectId, kind, detail });
const result = (
  errors: readonly Err[] = [],
  refreshed: readonly string[] = [],
  removed: readonly string[] = [],
): RefreshErrorInput => ({ errors, refreshed, removed });

describe('constants', () => {
  it('treats lock-contention and timeout as transient, needing three sightings', () => {
    expect(REFRESH_ERROR_TRANSIENT_KINDS).toEqual(['lock-contention', 'timeout']);
    expect(REFRESH_ERROR_TRANSIENT_THRESHOLD).toBe(3);
    expect(REFRESH_ERROR_MAX_KEYS_PER_PROJECT).toBe(20);
  });
});

describe('an error that keeps appearing', () => {
  it('is reported once even if it shows up ten times in a row', () => {
    const tracker = createRefreshErrorTracker();
    const counts: number[] = [];
    for (let round = 0; round < 10; round += 1) {
      counts.push(tracker.observe(result([err('alpha')]), projects, at(round * MINUTE)).length);
    }
    expect(counts).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('is reported a second time after an hour, and only then', () => {
    const tracker = createRefreshErrorTracker();
    expect(tracker.observe(result([err('alpha')]), projects, at(0))).toHaveLength(1);
    expect(tracker.observe(result([err('alpha')]), projects, at(HOUR - 1))).toHaveLength(0);
    expect(tracker.observe(result([err('alpha')]), projects, at(HOUR))).toHaveLength(1);
    expect(tracker.observe(result([err('alpha')]), projects, at(HOUR + MINUTE))).toHaveLength(0);
  });

  it('describes the report with the source, the masked text and the project', () => {
    const tracker = createRefreshErrorTracker();
    const [report] = tracker.observe(
      result([err('alpha', 'not-a-beads-project', 'database "alpha-project" not found on dolt server at 127.0.0.1:3307')]),
      projects,
      at(0),
    );
    expect(report).toEqual({
      source: 'bd-refresh:not-a-beads-project',
      errorText: 'database "<project>" not found on dolt server at 127.0.0.1:3307',
      project: { name: 'alpha-project', path: '/work/alpha' },
    });
  });

  it('reports other kinds at the first sighting too', () => {
    for (const kind of ['bd-not-found', 'not-a-beads-project', 'schema-mismatch', 'unknown', 'something-new']) {
      const tracker = createRefreshErrorTracker();
      expect(tracker.observe(result([err('alpha', kind)]), projects, at(0))).toHaveLength(1);
    }
  });

  it('keeps different kinds, and different texts, apart', () => {
    const tracker = createRefreshErrorTracker();
    const reports = tracker.observe(
      result([err('alpha', 'unknown', 'one'), err('alpha', 'unknown', 'two'), err('alpha', 'schema-mismatch', 'one')]),
      projects,
      at(0),
    );
    expect(reports.map((report) => `${report.source}:${report.errorText}`)).toEqual([
      'bd-refresh:unknown:one',
      'bd-refresh:unknown:two',
      'bd-refresh:schema-mismatch:one',
    ]);
  });

  it('counts a repeated error inside one result once', () => {
    const tracker = createRefreshErrorTracker();
    const twice = result([err('alpha', 'timeout'), err('alpha', 'timeout')]);
    expect(tracker.observe(twice, projects, at(0))).toHaveLength(0);
    expect(tracker.observe(twice, projects, at(1))).toHaveLength(0);
    expect(tracker.observe(twice, projects, at(2))).toHaveLength(1);
  });
});

describe('the same error in different projects', () => {
  const sentence = (name: string, root: string): string => `database "${name}" not found at ${root}`;

  it('has the same masked text, so the two reports have the same key', () => {
    const forAlpha = createRefreshErrorTracker().observe(
      result([err('alpha', 'unknown', sentence('alpha-project', '/work/alpha'))]),
      projects,
      at(0),
    );
    const forBeta = createRefreshErrorTracker().observe(
      result([err('beta', 'unknown', sentence('beta-project', '/work/beta'))]),
      projects,
      at(0),
    );
    expect(forAlpha[0]?.errorText).toBe('database "<project>" not found at <project-root>');
    expect(forBeta[0]?.errorText).toBe(forAlpha[0]?.errorText);
  });

  it('is reported once for the project that came first', () => {
    const tracker = createRefreshErrorTracker();
    const reports = tracker.observe(
      result([
        err('beta', 'unknown', sentence('beta-project', '/work/beta')),
        err('alpha', 'unknown', sentence('alpha-project', '/work/alpha')),
      ]),
      projects,
      at(0),
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]?.project).toEqual({ name: 'beta-project', path: '/work/beta' });
    expect(
      tracker.observe(result([err('alpha', 'unknown', sentence('alpha-project', '/work/alpha'))]), projects, at(MINUTE)),
    ).toHaveLength(0);
  });
});

describe('details that differ only in numbers (ports, times, counts)', () => {
  const unreachable = (port: number): string =>
    `error: failed to open database: dolt server unreachable at 127.0.0.1:${port}: dial tcp 127.0.0.1:${port}: connect: connection refused`;

  it('reports the same error once even when each project has its own Dolt port', () => {
    const tracker = createRefreshErrorTracker();
    const reports = tracker.observe(result([err('alpha', 'unknown', unreachable(60995)), err('beta', 'unknown', unreachable(61292))]), projects, at(0));
    expect(reports).toHaveLength(1);
    // 報告する文は寄せない (ポートは読み手に見せる文に残る)。
    expect(reports[0]?.errorText).toBe(unreachable(60995));
  });

  it('keeps throttling an error whose text carries a value that changes on every run', () => {
    const tracker = createRefreshErrorTracker();
    const counts = [0, 1, 2, 3].map(
      (round) => tracker.observe(result([err('alpha', 'unknown', `failed at 2026-10-05T00:0${round}:00Z after ${1000 + round}ms`)]), projects, at(round * MINUTE)).length,
    );
    expect(counts).toEqual([1, 0, 0, 0]);
  });

  it('lets a transient kind reach its threshold although the elapsed time differs each time', () => {
    const tracker = createRefreshErrorTracker();
    const counts = [0, 1, 2].map(
      (round) => tracker.observe(result([err('alpha', 'timeout', `timed out after ${30_000 + round}ms`)]), projects, at(round * MINUTE)).length,
    );
    expect(counts).toEqual([0, 0, 1]);
  });
});

describe('transient kinds (lock-contention and timeout)', () => {
  for (const kind of ['lock-contention', 'timeout']) {
    it(`reports ${kind} on the third sighting, not before, then follows the throttle`, () => {
      const tracker = createRefreshErrorTracker();
      const seen = result([err('alpha', kind)]);
      expect(tracker.observe(seen, projects, at(0))).toHaveLength(0);
      expect(tracker.observe(seen, projects, at(MINUTE))).toHaveLength(0);
      expect(tracker.observe(seen, projects, at(2 * MINUTE))).toHaveLength(1);
      expect(tracker.observe(seen, projects, at(3 * MINUTE))).toHaveLength(0);
      expect(tracker.observe(seen, projects, at(2 * MINUTE + HOUR))).toHaveLength(1);
    });
  }

  it('starts counting again when the error went away in between', () => {
    const tracker = createRefreshErrorTracker();
    const seen = result([err('alpha', 'timeout')]);
    tracker.observe(seen, projects, at(0));
    tracker.observe(seen, projects, at(1));
    // alpha が refreshed に入って errors に無い = 解消。
    tracker.observe(result([], ['alpha']), projects, at(2));
    expect(tracker.observe(seen, projects, at(3))).toHaveLength(0);
    expect(tracker.observe(seen, projects, at(4))).toHaveLength(0);
    expect(tracker.observe(seen, projects, at(5))).toHaveLength(1);
  });

  it('counts sightings in results where the project is not refreshed, and where it is refreshed but still has the error', () => {
    const tracker = createRefreshErrorTracker();
    expect(tracker.observe(result([err('alpha', 'timeout')]), projects, at(0))).toHaveLength(0);
    expect(tracker.observe(result([err('alpha', 'timeout')], ['alpha']), projects, at(1))).toHaveLength(0);
    expect(tracker.observe(result([err('alpha', 'timeout')], ['beta']), projects, at(2))).toHaveLength(1);
  });

  it('does not ask the throttle before the third sighting, so the third is not swallowed', () => {
    const throttle = createSelfErrorThrottle();
    const tracker = createRefreshErrorTracker({ throttle });
    tracker.observe(result([err('alpha', 'timeout')]), projects, at(0));
    tracker.observe(result([err('alpha', 'timeout')]), projects, at(1));
    expect(throttle.size()).toBe(0);
    expect(tracker.observe(result([err('alpha', 'timeout')]), projects, at(2))).toHaveLength(1);
    expect(throttle.size()).toBe(1);
  });

  it('counts a transient error per project', () => {
    const tracker = createRefreshErrorTracker();
    tracker.observe(result([err('alpha', 'timeout')]), projects, at(0));
    tracker.observe(result([err('beta', 'timeout')]), projects, at(1));
    // alpha は 2 回目、beta は 2 回目。どちらもまだ 3 回に届かない。
    expect(tracker.observe(result([err('alpha', 'timeout'), err('beta', 'timeout')]), projects, at(2))).toHaveLength(0);
    // alpha が 3 回目で報告。beta の 3 回目は同じキーなので throttle に従って報告されない。
    expect(tracker.observe(result([err('alpha', 'timeout'), err('beta', 'timeout')]), projects, at(3))).toHaveLength(1);
  });
});

describe('a partial refresh', () => {
  it('does not wipe the state of projects that were not refreshed', () => {
    const tracker = createRefreshErrorTracker();
    tracker.observe(result([err('alpha', 'timeout')]), projects, at(0));
    tracker.observe(result([err('alpha', 'timeout')]), projects, at(1));
    // beta だけが refreshed に入った結果 (alpha は据え置きで errors にも出ない)。
    tracker.observe(result([], ['beta']), projects, at(2));
    expect(tracker.observe(result([err('alpha', 'timeout')]), projects, at(3))).toHaveLength(1);
  });

  it('does not report a continuing error again just because another project was refreshed', () => {
    const tracker = createRefreshErrorTracker();
    expect(tracker.observe(result([err('alpha')]), projects, at(0))).toHaveLength(1);
    expect(tracker.observe(result([], ['beta']), projects, at(1))).toHaveLength(0);
    expect(tracker.observe(result([err('alpha')]), projects, at(2))).toHaveLength(0);
  });

  it('does not wipe the state of a project that is only reused', () => {
    const tracker = createRefreshErrorTracker();
    expect(tracker.observe(result([err('alpha')]), projects, at(0))).toHaveLength(1);
    // RefreshResult は reused も持つ。tracker は reused を見ず、状態も変えない。
    const withReused = { ...result(), reused: ['alpha'] };
    expect(tracker.observe(withReused, projects, at(1))).toHaveLength(0);
    expect(tracker.observe(result([err('alpha')]), projects, at(2))).toHaveLength(0);
  });
});

describe('resolution', () => {
  it('does not report a returning error again within the hour (an error that comes and goes is still one per hour)', () => {
    const tracker = createRefreshErrorTracker();
    expect(tracker.observe(result([err('alpha')]), projects, at(0))).toHaveLength(1);
    tracker.observe(result([], ['alpha']), projects, at(MINUTE));
    expect(tracker.observe(result([err('alpha')]), projects, at(2 * MINUTE))).toHaveLength(0);
    tracker.observe(result([], ['alpha']), projects, at(3 * MINUTE));
    expect(tracker.observe(result([err('alpha')]), projects, at(4 * MINUTE))).toHaveLength(0);
    expect(tracker.observe(result([err('alpha')]), projects, at(HOUR))).toHaveLength(1);
  });

  it('resolves only the keys that are gone, and keeps every key throttled for the hour', () => {
    const tracker = createRefreshErrorTracker();
    expect(tracker.observe(result([err('alpha', 'unknown', 'one'), err('alpha', 'unknown', 'two')]), projects, at(0))).toHaveLength(2);
    tracker.observe(result([err('alpha', 'unknown', 'one')], ['alpha']), projects, at(MINUTE));
    const within = tracker.observe(
      result([err('alpha', 'unknown', 'one'), err('alpha', 'unknown', 'two')]),
      projects,
      at(2 * MINUTE),
    );
    expect(within).toEqual([]);
    const after = tracker.observe(
      result([err('alpha', 'unknown', 'one'), err('alpha', 'unknown', 'two')]),
      projects,
      at(HOUR),
    );
    expect(after.map((report) => report.errorText)).toEqual(['one', 'two']);
  });

  it('resets only the run of consecutive sightings of a transient kind, not its hourly throttle', () => {
    const tracker = createRefreshErrorTracker();
    const seen = result([err('alpha', 'timeout')]);
    for (const offset of [0, 1]) tracker.observe(seen, projects, at(offset));
    expect(tracker.observe(seen, projects, at(2))).toHaveLength(1);
    // 解消のあと、また 3 回続けて見えても、前の報告から 1 時間たつまでは報告しない。
    tracker.observe(result([], ['alpha']), projects, at(3));
    for (const offset of [4, 5, 6]) expect(tracker.observe(seen, projects, at(offset))).toHaveLength(0);
    // 数え直しは効いている: 1 時間後でも 3 回続けて見えるまでは報告しない。
    tracker.observe(result([], ['alpha']), projects, at(HOUR));
    expect(tracker.observe(seen, projects, at(HOUR + 1))).toHaveLength(0);
    expect(tracker.observe(seen, projects, at(HOUR + 2))).toHaveLength(0);
    expect(tracker.observe(seen, projects, at(HOUR + 3))).toHaveLength(1);
  });

  it('does not re-report when another project still has the same masked error', () => {
    const tracker = createRefreshErrorTracker();
    const both = result([err('alpha', 'unknown', 'in alpha-project'), err('beta', 'unknown', 'in beta-project')]);
    expect(tracker.observe(both, projects, at(0))).toHaveLength(1);
    // alpha は解消、beta は続いている。
    tracker.observe(result([err('beta', 'unknown', 'in beta-project')], ['alpha', 'beta']), projects, at(MINUTE));
    expect(tracker.observe(result([err('alpha', 'unknown', 'in alpha-project')]), projects, at(2 * MINUTE))).toHaveLength(0);
  });

  it('forgets the run of sightings of a removed project, but not its hourly throttle', () => {
    const tracker = createRefreshErrorTracker();
    tracker.observe(result([err('alpha', 'timeout')]), projects, at(0));
    tracker.observe(result([err('alpha', 'timeout')]), projects, at(1));
    tracker.observe(result([], [], ['alpha']), projects, at(2));
    expect(tracker.observe(result([err('alpha', 'timeout')]), projects, at(3))).toHaveLength(0);
    expect(tracker.observe(result([err('alpha', 'unknown')]), projects, at(4))).toHaveLength(1);
    tracker.observe(result([], [], ['alpha']), projects, at(5));
    expect(tracker.observe(result([err('alpha', 'unknown')]), projects, at(6))).toHaveLength(0);
  });

  it('keeps the state of other projects when one is removed', () => {
    const tracker = createRefreshErrorTracker();
    tracker.observe(result([err('beta', 'timeout')]), projects, at(0));
    tracker.observe(result([err('beta', 'timeout')]), projects, at(1));
    tracker.observe(result([], [], ['alpha']), projects, at(2));
    expect(tracker.observe(result([err('beta', 'timeout')]), projects, at(3))).toHaveLength(1);
  });
});

describe('unknown projects', () => {
  it('neither reports nor remembers an error of a project that is not in the list', () => {
    const tracker = createRefreshErrorTracker();
    expect(tracker.observe(result([err('ghost', 'timeout')]), projects, at(0))).toHaveLength(0);
    expect(tracker.observe(result([err('ghost')]), projects, at(1))).toHaveLength(0);
    const withGhost = [...projects, { ...alpha, id: 'ghost', name: 'ghost-project', rootPath: '/work/ghost' }];
    // 覚えていなかったので、一覧に入ってからの最初の 1 回が「1 回目」になる。
    expect(tracker.observe(result([err('ghost', 'timeout')]), withGhost, at(2))).toHaveLength(0);
    expect(tracker.observe(result([err('ghost')]), withGhost, at(3))).toHaveLength(1);
  });

  it('drops the state of a project that has left the list without ever being cached (it is not in removed)', () => {
    const tracker = createRefreshErrorTracker();
    const withGhost = [...projects, { ...alpha, id: 'ghost', name: 'ghost-project', rootPath: '/work/ghost' }];
    tracker.observe(result([err('ghost', 'timeout')]), withGhost, at(0));
    tracker.observe(result([err('ghost', 'timeout')]), withGhost, at(1));
    // ghost は探索から消えた。キャッシュに入ったことが無いので removed には出ない。
    tracker.observe(result([err('alpha')]), projects, at(2));
    // 戻ってきても、前の 2 回は数えない (残っていれば、この 1 回が 3 回目になって報告される)。
    expect(tracker.observe(result([err('ghost', 'timeout')]), withGhost, at(3))).toHaveLength(0);
  });
});

describe('options and limits', () => {
  it('shares its reporting slots with whoever else uses the throttle it is given', () => {
    const shared = createSelfErrorThrottle();
    const first = createRefreshErrorTracker({ throttle: shared });
    const second = createRefreshErrorTracker({ throttle: shared });
    expect(first.observe(result([err('alpha')]), projects, at(0))).toHaveLength(1);
    expect(second.observe(result([err('alpha')]), projects, at(1))).toHaveLength(0);
    expect(second.observe(result([err('alpha')]), projects, at(HOUR))).toHaveLength(1);
  });

  it('remembers at most twenty keys per project: the oldest one loses its run of sightings', () => {
    const tracker = createRefreshErrorTracker();
    // キーは数字を寄せるので、数字ではなく英字で別々の文にする (detail-a … detail-u)。
    const timeout = (index: number): Err => err('alpha', 'timeout', `detail-${String.fromCharCode(0x61 + index)}`);
    const reports = (round: readonly Err[], offset: number): number =>
      tracker.observe(result(round), projects, at(offset)).length;
    // 1 回目: a … u の 21 個。u を足したところで最も古い a が捨てられる。
    expect(reports(Array.from({ length: 21 }, (_, index) => timeout(index)), 0)).toBe(0);
    // 2 回目: b は 2 回目、a は数え直しの 1 回目 (足したところで c が捨てられる)。
    expect(reports([timeout(1), timeout(0)], 1)).toBe(0);
    // 3 回目: b は 3 回目で報告、a は 2 回目。捨てられていなければ a も 3 回目になって 2 件になる。
    expect(reports([timeout(1), timeout(0)], 2)).toBe(1);
  });

  it('handles a very long detail without shortening the reported text', () => {
    const tracker = createRefreshErrorTracker();
    const detail = `head ${'z'.repeat(50_000)} tail`;
    const reports = tracker.observe(result([err('alpha', 'unknown', detail)]), projects, at(0));
    expect(reports[0]?.errorText).toBe(detail);
    expect(tracker.observe(result([err('alpha', 'unknown', detail)]), projects, at(1))).toHaveLength(0);
  });

  it('tells long details apart by their head, their length and their tail', () => {
    const tracker = createRefreshErrorTracker();
    const first = `${'a'.repeat(2000)}X${'b'.repeat(2000)}`;
    const second = `${'a'.repeat(2000)}Y${'b'.repeat(2001)}`;
    expect(tracker.observe(result([err('alpha', 'unknown', first)]), projects, at(0))).toHaveLength(1);
    expect(tracker.observe(result([err('alpha', 'unknown', second)]), projects, at(1))).toHaveLength(1);
  });

  it('folds a key longer than 1024 characters into its head (768), its length and its tail (256)', () => {
    const long = (head: string, middle: string, tail: string): string => `${head}${'h'.repeat(800)}${middle}${'t'.repeat(300)}${tail}`;
    const tracker = createRefreshErrorTracker();
    const original = long('', 'x'.repeat(500), '');
    expect(tracker.observe(result([err('alpha', 'unknown', original)]), projects, at(0))).toHaveLength(1);
    // 先頭 768 と末尾 256 の外 (中) だけが違い、長さが同じなら、同じキーになる (既知の限界)。
    const middleOnly = long('', `${'x'.repeat(250)}${'y'.repeat(5)}${'x'.repeat(245)}`, '');
    expect(tracker.observe(result([err('alpha', 'unknown', middleOnly)]), projects, at(1))).toHaveLength(0);
    // 先頭・末尾・長さのどれかが違えば別のキー。
    expect(tracker.observe(result([err('alpha', 'unknown', long('g', 'x'.repeat(499), ''))]), projects, at(2))).toHaveLength(1);
    expect(tracker.observe(result([err('alpha', 'unknown', long('', 'x'.repeat(500), 'q'))]), projects, at(3))).toHaveLength(1);
    expect(tracker.observe(result([err('alpha', 'unknown', long('', 'x'.repeat(501), ''))]), projects, at(4))).toHaveLength(1);
    // 報告する文は畳まない。
    expect(tracker.observe(result([err('beta', 'unknown', long('k', 'x'.repeat(499), ''))]), projects, at(5))[0]?.errorText).toBe(
      long('k', 'x'.repeat(499), ''),
    );
  });

  it('returns nothing for an empty result', () => {
    expect(createRefreshErrorTracker().observe(result(), projects, at(0))).toEqual([]);
    expect(createRefreshErrorTracker().observe(result(), [], at(0))).toEqual([]);
  });
});
