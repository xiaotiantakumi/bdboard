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
  it('reports a returning error at once, without waiting for the hour', () => {
    const tracker = createRefreshErrorTracker();
    expect(tracker.observe(result([err('alpha')]), projects, at(0))).toHaveLength(1);
    tracker.observe(result([], ['alpha']), projects, at(MINUTE));
    expect(tracker.observe(result([err('alpha')]), projects, at(2 * MINUTE))).toHaveLength(1);
  });

  it('resolves only the keys that are gone, and keeps the others throttled', () => {
    const tracker = createRefreshErrorTracker();
    expect(tracker.observe(result([err('alpha', 'unknown', 'one'), err('alpha', 'unknown', 'two')]), projects, at(0))).toHaveLength(2);
    tracker.observe(result([err('alpha', 'unknown', 'one')], ['alpha']), projects, at(MINUTE));
    const again = tracker.observe(
      result([err('alpha', 'unknown', 'one'), err('alpha', 'unknown', 'two')]),
      projects,
      at(2 * MINUTE),
    );
    expect(again.map((report) => report.errorText)).toEqual(['two']);
  });

  it('does not re-report when another project still has the same masked error', () => {
    const tracker = createRefreshErrorTracker();
    const both = result([err('alpha', 'unknown', 'in alpha-project'), err('beta', 'unknown', 'in beta-project')]);
    expect(tracker.observe(both, projects, at(0))).toHaveLength(1);
    // alpha は解消、beta は続いている。
    tracker.observe(result([err('beta', 'unknown', 'in beta-project')], ['alpha', 'beta']), projects, at(MINUTE));
    expect(tracker.observe(result([err('alpha', 'unknown', 'in alpha-project')]), projects, at(2 * MINUTE))).toHaveLength(0);
  });

  it('forgets the error of a removed project', () => {
    const tracker = createRefreshErrorTracker();
    tracker.observe(result([err('alpha', 'timeout')]), projects, at(0));
    tracker.observe(result([err('alpha', 'timeout')]), projects, at(1));
    tracker.observe(result([], [], ['alpha']), projects, at(2));
    expect(tracker.observe(result([err('alpha', 'timeout')]), projects, at(3))).toHaveLength(0);
    // 外れた後の報告済みの記憶も捨てるので、即時の kind は再び「初めて」になる。
    expect(tracker.observe(result([err('alpha', 'unknown')]), projects, at(4))).toHaveLength(1);
    tracker.observe(result([], [], ['alpha']), projects, at(5));
    expect(tracker.observe(result([err('alpha', 'unknown')]), projects, at(6))).toHaveLength(1);
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

  it('remembers at most twenty keys per project, and forgets the oldest', () => {
    const tracker = createRefreshErrorTracker();
    const many = Array.from({ length: 21 }, (_, index) => err('alpha', 'unknown', `detail-${index}`));
    expect(tracker.observe(result(many), projects, at(0))).toHaveLength(21);
    // detail-0 は捨てられて throttle からも外れたので、続いて現れたら初めてのものとして報告される。detail-1 はまだ覚えている。
    expect(tracker.observe(result([err('alpha', 'unknown', 'detail-1')]), projects, at(1))).toHaveLength(0);
    expect(tracker.observe(result([err('alpha', 'unknown', 'detail-0')]), projects, at(2))).toHaveLength(1);
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

  it('returns nothing for an empty result', () => {
    expect(createRefreshErrorTracker().observe(result(), projects, at(0))).toEqual([]);
    expect(createRefreshErrorTracker().observe(result(), [], at(0))).toEqual([]);
  });
});
