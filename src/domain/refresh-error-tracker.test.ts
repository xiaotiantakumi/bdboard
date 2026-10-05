import { describe, expect, it } from 'vitest';
import {
  REFRESH_ERROR_IMMEDIATE_KINDS,
  REFRESH_ERROR_MAX_KEYS_PER_PROJECT,
  REFRESH_ERROR_TRANSIENT_THRESHOLD,
  createRefreshErrorTracker,
  selfErrorKey,
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
const err = (projectId: string, kind = 'schema-mismatch', detail = 'failure'): Err => ({ projectId, kind, detail });
const result = (
  errors: readonly Err[] = [],
  refreshed: readonly string[] = [],
  removed: readonly string[] = [],
): RefreshErrorInput => ({ errors, refreshed, removed });

describe('constants', () => {
  it('reports only the deterministic kind at once; every other kind needs three sightings in a row', () => {
    expect(REFRESH_ERROR_IMMEDIATE_KINDS).toEqual(['schema-mismatch']);
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
      result([err('alpha', 'schema-mismatch', 'database "alpha-project" not found on dolt server at 127.0.0.1:3307')]),
      projects,
      at(0),
    );
    expect(report).toEqual({
      source: 'bd-refresh:schema-mismatch',
      errorText: 'database "<project>" not found on dolt server at 127.0.0.1:3307',
      project: { name: 'alpha-project', path: '/work/alpha' },
    });
  });

  it('reports the deterministic kind (schema-mismatch) at the first sighting', () => {
    const tracker = createRefreshErrorTracker();
    expect(tracker.observe(result([err('alpha', 'schema-mismatch')]), projects, at(0))).toHaveLength(1);
  });

  // classifyBdError は出力に `beads directory` があるだけでこの種類にする (bd の警告や `bd init` の最中にも当たる) ので、決定的とは見ない。
  it('makes not-a-beads-project wait for three sightings in a row, like the other kinds that can be transient', () => {
    const tracker = createRefreshErrorTracker();
    const seen = result([err('alpha', 'not-a-beads-project', 'beads directory not set')]);
    expect(tracker.observe(seen, projects, at(0))).toEqual([]);
    expect(tracker.observe(seen, projects, at(1))).toEqual([]);
    expect(tracker.observe(seen, projects, at(2))).toEqual([
      { source: 'bd-refresh:not-a-beads-project', errorText: 'beads directory not set', project: { name: 'alpha-project', path: '/work/alpha' } },
    ]);
    // 1 回きりで消えれば、下書きにならない。
    const once = createRefreshErrorTracker();
    expect(once.observe(seen, projects, at(0))).toEqual([]);
    expect(once.observe(result([], ['alpha']), projects, at(1))).toEqual([]);
    expect(once.observe(result([], ['alpha']), projects, at(2))).toEqual([]);
  });

  it('keeps different kinds, and different texts, apart', () => {
    const tracker = createRefreshErrorTracker();
    const reports = tracker.observe(
      result([
        err('alpha', 'schema-mismatch', 'one'),
        err('alpha', 'schema-mismatch', 'two'),
        err('alpha', 'not-a-beads-project', 'one'),
      ]),
      projects,
      at(0),
    );
    // not-a-beads-project は 1 回目では報告されない。schema-mismatch は文ごとに別の報告。
    expect(reports.map((report) => `${report.source}:${report.errorText}`)).toEqual([
      'bd-refresh:schema-mismatch:one',
      'bd-refresh:schema-mismatch:two',
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
      result([err('alpha', 'schema-mismatch', sentence('alpha-project', '/work/alpha'))]),
      projects,
      at(0),
    );
    const forBeta = createRefreshErrorTracker().observe(
      result([err('beta', 'schema-mismatch', sentence('beta-project', '/work/beta'))]),
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
        err('beta', 'schema-mismatch', sentence('beta-project', '/work/beta')),
        err('alpha', 'schema-mismatch', sentence('alpha-project', '/work/alpha')),
      ]),
      projects,
      at(0),
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]?.project).toEqual({ name: 'beta-project', path: '/work/beta' });
    expect(
      tracker.observe(result([err('alpha', 'schema-mismatch', sentence('alpha-project', '/work/alpha'))]), projects, at(MINUTE)),
    ).toHaveLength(0);
  });
});

describe('details that differ only in numbers (ports, times, counts)', () => {
  const unreachable = (port: number): string =>
    `error: failed to open database: dolt server unreachable at 127.0.0.1:${port}: dial tcp 127.0.0.1:${port}: connect: connection refused`;

  it('reports the same error once even when each project has its own Dolt port', () => {
    const tracker = createRefreshErrorTracker();
    const both = result([err('alpha', 'unknown', unreachable(60995)), err('beta', 'unknown', unreachable(61292))]);
    // unknown は 3 回続けて見えてから (alpha も beta も 3 回目)。同じキーなので、報告は 1 件だけ。
    expect(tracker.observe(both, projects, at(0))).toHaveLength(0);
    expect(tracker.observe(both, projects, at(1))).toHaveLength(0);
    const reports = tracker.observe(both, projects, at(2));
    expect(reports).toHaveLength(1);
    // 報告する文は寄せない (ポートは読み手に見せる文に残る)。
    expect(reports[0]?.errorText).toBe(unreachable(60995));
  });

  it('counts a Dolt error whose port changes from one refresh to the next as the same, continuing error', () => {
    const tracker = createRefreshErrorTracker();
    const counts = [60995, 61292, 61300].map(
      (port, round) => tracker.observe(result([err('alpha', 'unknown', unreachable(port))]), projects, at(round * MINUTE)).length,
    );
    expect(counts).toEqual([0, 0, 1]);
  });

  it('keeps throttling an error whose text carries a value that changes on every run', () => {
    const tracker = createRefreshErrorTracker();
    const counts = [0, 1, 2, 3].map(
      (round) => tracker.observe(result([err('alpha', 'schema-mismatch', `failed at 2026-10-05T00:0${round}:00Z after ${1000 + round}ms`)]), projects, at(round * MINUTE)).length,
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

describe('kinds that need three sightings in a row (everything but the deterministic kinds)', () => {
  for (const kind of ['lock-contention', 'timeout', 'bd-not-found', 'unknown', 'a-kind-added-later']) {
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

// bdboard-f2ob: Dolt サーバーが起動直後でまだ繋がらない (connection refused) 文は classify-bd-error のどの種類にも当たらず 'unknown' になる。
// 形を 1 つずつ分類器に教えるのではなく、「続いたかどうか」で見る: 1 回だけなら報告せず、3 回続けば報告し、成功を挟めば数え直す。
describe('a connection refused to the Dolt server (kind unknown, bdboard-f2ob)', () => {
  const refused = (port: number): string =>
    `error: failed to open database: dolt server unreachable at 127.0.0.1:${port}: dial tcp 127.0.0.1:${port}: connect: connection refused / the dolt server may not be running. try: bd dolt start`;
  const failing = (port = 60995): RefreshErrorInput => result([err('alpha', 'unknown', refused(port))]);

  it('is not reported when it happens once and then goes away', () => {
    const tracker = createRefreshErrorTracker();
    expect(tracker.observe(failing(), projects, at(0))).toEqual([]);
    // 次のリフレッシュは成功 (alpha が refreshed に入って errors に無い)。
    expect(tracker.observe(result([], ['alpha']), projects, at(5 * MINUTE))).toEqual([]);
    // そのあとのリフレッシュも静か。1 回きりのエラーは、あとから下書きにならない。
    for (let round = 2; round < 8; round += 1) {
      expect(tracker.observe(result([], ['alpha']), projects, at(round * 5 * MINUTE))).toEqual([]);
    }
  });

  it('is not reported when it happens twice in a row', () => {
    const tracker = createRefreshErrorTracker();
    expect(tracker.observe(failing(), projects, at(0))).toEqual([]);
    expect(tracker.observe(failing(), projects, at(5 * MINUTE))).toEqual([]);
  });

  it('is reported when it happens three times in a row, with the kind in the source and the text as it was', () => {
    const tracker = createRefreshErrorTracker();
    expect(tracker.observe(failing(60995), projects, at(0))).toEqual([]);
    expect(tracker.observe(failing(61292), projects, at(5 * MINUTE))).toEqual([]);
    expect(tracker.observe(failing(61300), projects, at(10 * MINUTE))).toEqual([
      { source: 'bd-refresh:unknown', errorText: refused(61300), project: { name: 'alpha-project', path: '/work/alpha' } },
    ]);
    // 続いていても、報告は 1 時間に 1 回 (6.2 の間引き)。
    expect(tracker.observe(failing(), projects, at(15 * MINUTE))).toEqual([]);
    expect(tracker.observe(failing(), projects, at(10 * MINUTE + HOUR))).toHaveLength(1);
  });

  it('starts counting again after a refresh that succeeded in between', () => {
    const tracker = createRefreshErrorTracker();
    tracker.observe(failing(), projects, at(0));
    tracker.observe(failing(), projects, at(1));
    tracker.observe(result([], ['alpha']), projects, at(2));
    // 成功の前の 2 回は数えない: 成功のあと 2 回続いても、まだ報告しない。
    expect(tracker.observe(failing(), projects, at(3))).toEqual([]);
    expect(tracker.observe(failing(), projects, at(4))).toEqual([]);
    expect(tracker.observe(failing(), projects, at(5))).toHaveLength(1);
  });

  it('does not count a refresh that did not look at the project as a success or as a failure', () => {
    const tracker = createRefreshErrorTracker();
    tracker.observe(failing(), projects, at(0));
    // beta だけが更新された結果 (alpha は reused のまま) は、alpha の数を変えない。
    tracker.observe(result([], ['beta']), projects, at(1));
    tracker.observe(failing(), projects, at(2));
    expect(tracker.observe(failing(), projects, at(3))).toHaveLength(1);
  });

  it('does not ask the throttle before the third sighting, so a one-off failure cannot use up the hourly slot', () => {
    const throttle = createSelfErrorThrottle();
    const tracker = createRefreshErrorTracker({ throttle });
    tracker.observe(failing(), projects, at(0));
    tracker.observe(failing(), projects, at(1));
    expect(throttle.size()).toBe(0);
  });

  it('is counted per kind: three failed refreshes in a row are reported once even when the text changes in between', () => {
    const tracker = createRefreshErrorTracker();
    const other = result([err('alpha', 'unknown', 'something else broke')]);
    expect(tracker.observe(failing(), projects, at(0))).toEqual([]);
    expect(tracker.observe(other, projects, at(1))).toEqual([]);
    // unknown の失敗が 3 回続いたこの回に、いま見えている文で 1 回だけ報告する。
    expect(tracker.observe(failing(), projects, at(2))).toEqual([
      { source: 'bd-refresh:unknown', errorText: refused(60995), project: { name: 'alpha-project', path: '/work/alpha' } },
    ]);
    // 続いている間は、新しい文が出ても報告しない (文が毎回ずれる失敗で、更新ごとに下書きが増えないように)。
    expect(tracker.observe(other, projects, at(3))).toEqual([]);
    expect(tracker.observe(failing(), projects, at(4))).toEqual([]);
  });
});

// 文の一部が実行ごとに変わり、normalizeErrorText でも寄らない失敗 (bd が Go の panic で落ちたときの pc=0x… はアドレス空間の配置の
// ランダム化で毎回変わる)。キーごとに数えると 3 回に届かず、続いていても報告されない (bdboard-f2ob のレビュー)。
describe('a failure whose text changes on every refresh in a way normalizeErrorText cannot fold', () => {
  const panic = (pc: string): Err =>
    err('alpha', 'unknown', `panic: runtime error: invalid memory address or nil pointer dereference [signal sigsegv: segmentation violation code=0x2 addr=0x0 pc=${pc}]`);
  const pcs = ['0x1029f4b2c', '0x104ab4b2c', '0x10c3e8b2c', '0x10de14b2c', '0x1077a0b2c', '0x101fe8b2c'];

  it('really does not fold (so a count per text would never reach three)', () => {
    const keys = new Set(pcs.map((pc) => panic(pc).detail).map((detail) => selfErrorKey('unknown', detail)));
    expect(keys.size).toBe(pcs.length);
  });

  it('is reported once, on the third failed refresh in a row, and not again while it lasts', () => {
    const tracker = createRefreshErrorTracker();
    const counts = pcs.map((pc, round) => tracker.observe(result([panic(pc)]), projects, at(round * 5 * MINUTE)).length);
    expect(counts).toEqual([0, 0, 1, 0, 0, 0]);
  });

  it('is not reported when it goes away after two refreshes, and starts a new run after a success', () => {
    const tracker = createRefreshErrorTracker();
    tracker.observe(result([panic(pcs[0] ?? '')]), projects, at(0));
    tracker.observe(result([panic(pcs[1] ?? '')]), projects, at(1));
    expect(tracker.observe(result([], ['alpha']), projects, at(2))).toEqual([]);
    expect(tracker.observe(result([panic(pcs[2] ?? '')]), projects, at(3))).toEqual([]);
    expect(tracker.observe(result([panic(pcs[3] ?? '')]), projects, at(4))).toEqual([]);
    expect(tracker.observe(result([panic(pcs[4] ?? '')]), projects, at(5))).toHaveLength(1);
  });

  it('does not join different kinds into one run', () => {
    const tracker = createRefreshErrorTracker();
    const counts = ['timeout', 'lock-contention', 'unknown', 'timeout', 'lock-contention'].map(
      (kind, round) => tracker.observe(result([err('alpha', kind, `failed ${String.fromCharCode(0x61 + round)}`)]), projects, at(round)).length,
    );
    expect(counts).toEqual([0, 0, 0, 0, 0]);
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
    expect(tracker.observe(result([err('alpha', 'schema-mismatch', 'one'), err('alpha', 'schema-mismatch', 'two')]), projects, at(0))).toHaveLength(2);
    tracker.observe(result([err('alpha', 'schema-mismatch', 'one')], ['alpha']), projects, at(MINUTE));
    const within = tracker.observe(
      result([err('alpha', 'schema-mismatch', 'one'), err('alpha', 'schema-mismatch', 'two')]),
      projects,
      at(2 * MINUTE),
    );
    expect(within).toEqual([]);
    const after = tracker.observe(
      result([err('alpha', 'schema-mismatch', 'one'), err('alpha', 'schema-mismatch', 'two')]),
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
    const both = result([err('alpha', 'schema-mismatch', 'in alpha-project'), err('beta', 'schema-mismatch', 'in beta-project')]);
    expect(tracker.observe(both, projects, at(0))).toHaveLength(1);
    // alpha は解消、beta は続いている。
    tracker.observe(result([err('beta', 'schema-mismatch', 'in beta-project')], ['alpha', 'beta']), projects, at(MINUTE));
    expect(tracker.observe(result([err('alpha', 'schema-mismatch', 'in alpha-project')]), projects, at(2 * MINUTE))).toHaveLength(0);
  });

  it('forgets the run of sightings of a removed project, but not its hourly throttle', () => {
    const tracker = createRefreshErrorTracker();
    tracker.observe(result([err('alpha', 'timeout')]), projects, at(0));
    tracker.observe(result([err('alpha', 'timeout')]), projects, at(1));
    tracker.observe(result([], [], ['alpha']), projects, at(2));
    expect(tracker.observe(result([err('alpha', 'timeout')]), projects, at(3))).toHaveLength(0);
    expect(tracker.observe(result([err('alpha', 'schema-mismatch')]), projects, at(4))).toHaveLength(1);
    tracker.observe(result([], [], ['alpha']), projects, at(5));
    expect(tracker.observe(result([err('alpha', 'schema-mismatch')]), projects, at(6))).toHaveLength(0);
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
    // 3 回目: timeout の失敗の連続がここで 3 回に届き、この回に見えた別の文 (v) だけが報告される (kind ごとの数え)。
    expect(reports([timeout(21)], 2)).toBe(1);
    // 4 回目: b は 3 回目で報告、a は 2 回目。捨てられていなければ a も 3 回目になって 2 件になる。
    expect(reports([timeout(1), timeout(0)], 3)).toBe(1);
  });

  it('handles a very long detail without shortening the reported text', () => {
    const tracker = createRefreshErrorTracker();
    const detail = `head ${'z'.repeat(50_000)} tail`;
    const reports = tracker.observe(result([err('alpha', 'schema-mismatch', detail)]), projects, at(0));
    expect(reports[0]?.errorText).toBe(detail);
    expect(tracker.observe(result([err('alpha', 'schema-mismatch', detail)]), projects, at(1))).toHaveLength(0);
  });

  it('tells long details apart by their head, their length and their tail', () => {
    const tracker = createRefreshErrorTracker();
    const first = `${'a'.repeat(2000)}X${'b'.repeat(2000)}`;
    const second = `${'a'.repeat(2000)}Y${'b'.repeat(2001)}`;
    expect(tracker.observe(result([err('alpha', 'schema-mismatch', first)]), projects, at(0))).toHaveLength(1);
    expect(tracker.observe(result([err('alpha', 'schema-mismatch', second)]), projects, at(1))).toHaveLength(1);
  });

  it('folds a key longer than 1024 characters into its head (768), its length and its tail (256)', () => {
    const long = (head: string, middle: string, tail: string): string => `${head}${'h'.repeat(800)}${middle}${'t'.repeat(300)}${tail}`;
    const tracker = createRefreshErrorTracker();
    const original = long('', 'x'.repeat(500), '');
    expect(tracker.observe(result([err('alpha', 'schema-mismatch', original)]), projects, at(0))).toHaveLength(1);
    // 先頭 768 と末尾 256 の外 (中) だけが違い、長さが同じなら、同じキーになる (既知の限界)。
    const middleOnly = long('', `${'x'.repeat(250)}${'y'.repeat(5)}${'x'.repeat(245)}`, '');
    expect(tracker.observe(result([err('alpha', 'schema-mismatch', middleOnly)]), projects, at(1))).toHaveLength(0);
    // 先頭・末尾・長さのどれかが違えば別のキー。
    expect(tracker.observe(result([err('alpha', 'schema-mismatch', long('g', 'x'.repeat(499), ''))]), projects, at(2))).toHaveLength(1);
    expect(tracker.observe(result([err('alpha', 'schema-mismatch', long('', 'x'.repeat(500), 'q'))]), projects, at(3))).toHaveLength(1);
    expect(tracker.observe(result([err('alpha', 'schema-mismatch', long('', 'x'.repeat(501), ''))]), projects, at(4))).toHaveLength(1);
    // 報告する文は畳まない。
    expect(tracker.observe(result([err('beta', 'schema-mismatch', long('k', 'x'.repeat(499), ''))]), projects, at(5))[0]?.errorText).toBe(
      long('k', 'x'.repeat(499), ''),
    );
  });

  it('returns nothing for an empty result', () => {
    expect(createRefreshErrorTracker().observe(result(), projects, at(0))).toEqual([]);
    expect(createRefreshErrorTracker().observe(result(), [], at(0))).toEqual([]);
  });
});
