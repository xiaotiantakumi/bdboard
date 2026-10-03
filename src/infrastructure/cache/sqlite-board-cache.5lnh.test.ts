import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CachedProject } from '../../application/ports/board-cache.js';
import type { Project } from '../../domain/project.js';
import { makeTicket } from '../../domain/test-support.js';
import { openCacheDatabase } from './sqlite-board-cache.js';
import { rowToCachedProject } from './sqlite-board-cache/convert.js';
import { createParseCache } from './sqlite-board-cache/parse-cache.js';
import { createReadOperations } from './sqlite-board-cache/read.js';
import type { ProjectRow } from './sqlite-board-cache/row-types.js';
import { createWriteOperations } from './sqlite-board-cache/write.js';

// bdboard-5lnh: 同期 listProjects() は `SELECT * FROM projects` で全チケットの JSON
// テキストを毎回 SQLite から読み、parseCache (bdboard-3c36) が温まっていてもそのコピー
// 代を払っていた (実測 200k 件で warm 163〜179ms、chunked の warm は 6〜13ms)。
// いまは「SELECT id, fingerprint → parseCache → 外れた分だけ getProjectStmt.get(id)」。
//
// このファイルは、その性能改善を壁時計の閾値 (mkkx 系の health-vs-stats 比のような、
// 負荷で揺れる値) に頼らず、実行された SQL 文の回数で決定的に固定する:
//   - 温まったあとは `SELECT * ...` を1回も走らせない (id, fingerprint の1回だけ)
//   - 外れた分 (無効化された project) だけ行を読む
// あわせて、変更前の実装 (`SELECT * ... ORDER BY root_path ASC` の全行を
// rowToCachedProject で変換し、壊れた行を飛ばす) との出力の同一性を固定する。

interface Execution {
  readonly sql: string;
  readonly method: string;
}

const REFS_SQL = 'SELECT id, fingerprint FROM projects ORDER BY root_path ASC';
const ROW_BY_ID_SQL = 'SELECT * FROM projects WHERE id = ?';

// db.prepare が返す Statement の all/get/run/iterate の呼び出しを (SQL 文字列つきで) 記録する。
// 呼び出しは本物に素通しするので、出力は変わらない。createReadOperations より前に呼ぶこと
// (Statement は構築時に prepare される)。
function trackExecutions(db: Database.Database): Execution[] {
  const executions: Execution[] = [];
  const realPrepare = db.prepare.bind(db) as (sql: string) => Database.Statement;
  vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
    const statement = realPrepare(sql);
    return new Proxy(statement, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== 'function') {
          return value;
        }
        const bound = (value as (...args: unknown[]) => unknown).bind(target);
        if (property === 'all' || property === 'get' || property === 'run' || property === 'iterate') {
          return (...args: unknown[]) => {
            executions.push({ sql, method: property });
            return bound(...args);
          };
        }
        return bound;
      },
    });
  }) as unknown as typeof db.prepare);
  return executions;
}

function setup() {
  const db = openCacheDatabase(':memory:');
  const executions = trackExecutions(db);
  const parseCache = createParseCache();
  const reader = createReadOperations(db, ':memory:', parseCache);
  const writer = createWriteOperations(db, parseCache);
  return { db, executions, reader, writer };
}

function makeProject(id: string, rootPath: string, overrides: Partial<Project> = {}): Project {
  return { id, name: `name-${id}`, rootPath, prefixes: ['pfx'], aliasPaths: [], ...overrides };
}

function makeEntry(
  project: Project,
  options: { readonly fingerprint?: string; readonly ticketCount?: number } = {},
): CachedProject {
  const ticketCount = options.ticketCount ?? 2;
  return {
    project,
    tickets: Array.from({ length: ticketCount }, (_, index) =>
      makeTicket({ id: `pfx-${project.id}-${index}`, projectId: project.id, title: `ticket ${index}` }),
    ),
    fingerprint: options.fingerprint ?? `fp-${project.id}`,
    fetchedAt: new Date('2026-10-03T00:00:00.000Z'),
  };
}

// 変更前の listProjects(): 全行を SELECT * で読み、parseCache を介さず変換し、壊れた行を飛ばす。
function legacyListProjects(db: Database.Database): CachedProject[] {
  const rows = db.prepare('SELECT * FROM projects ORDER BY root_path ASC').all() as ProjectRow[];
  const results: CachedProject[] = [];
  for (const row of rows) {
    const entry = rowToCachedProject(row);
    if (entry !== null) {
      results.push(entry);
    }
  }
  return results;
}

function insertRawProject(
  db: Database.Database,
  row: { id: string; rootPath: string; prefixes: string; tickets: string; fingerprint?: string },
): void {
  db.prepare(
    `INSERT INTO projects
      (id, name, root_path, prefixes, fingerprint, fetched_at, tickets, alias_paths)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    `name-${row.id}`,
    row.rootPath,
    row.prefixes,
    row.fingerprint ?? `fp-${row.id}`,
    '2026-10-03T00:00:00.000Z',
    row.tickets,
    '[]',
  );
}

const selectStarCalls = (executions: readonly Execution[]) =>
  executions.filter((execution) => execution.sql.includes('SELECT *'));

describe('SqliteBoardCache project listing (bdboard-5lnh)', () => {
  afterEach(() => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
  });

  describe('SQL executed per call (deterministic, no wall-clock threshold)', () => {
    it('listProjects() reads rows only for projects missing from the parse cache, one get per project', () => {
      const { db, executions, reader, writer } = setup();
      writer.putProject(makeEntry(makeProject('a', '/a')));
      writer.putProject(makeEntry(makeProject('b', '/b')));
      writer.putProject(makeEntry(makeProject('c', '/c')));
      executions.length = 0;

      // Cold: putProject never registers in the parse cache, so every project is a miss.
      reader.listProjects();
      expect(executions.map((execution) => `${execution.method} ${execution.sql}`)).toEqual([
        `all ${REFS_SQL}`,
        `get ${ROW_BY_ID_SQL}`,
        `get ${ROW_BY_ID_SQL}`,
        `get ${ROW_BY_ID_SQL}`,
      ]);
      db.close();
    });

    it('listProjects() never runs SELECT * once the parse cache is warm', () => {
      const { db, executions, reader, writer } = setup();
      writer.putProject(makeEntry(makeProject('a', '/a')));
      writer.putProject(makeEntry(makeProject('b', '/b')));
      reader.listProjects(); // warm
      executions.length = 0;

      for (let call = 0; call < 5; call += 1) {
        reader.listProjects();
      }

      // The only statement executed on 5 warm calls is the id/fingerprint list: no
      // full-row read, so no ticket JSON text is copied out of SQLite.
      expect(selectStarCalls(executions)).toEqual([]);
      expect(executions).toEqual(Array.from({ length: 5 }, () => ({ sql: REFS_SQL, method: 'all' })));
      db.close();
    });

    it('re-reads only the project whose parse cache entry was invalidated', () => {
      const { db, executions, reader, writer } = setup();
      writer.putProject(makeEntry(makeProject('a', '/a')));
      writer.putProject(makeEntry(makeProject('b', '/b')));
      writer.putProject(makeEntry(makeProject('c', '/c')));
      const warm = reader.listProjects();
      writer.putProject(makeEntry(makeProject('b', '/b'), { fingerprint: 'fp-b-2', ticketCount: 5 }));
      executions.length = 0;

      const after = reader.listProjects();

      expect(executions.filter((execution) => execution.sql === ROW_BY_ID_SQL)).toHaveLength(1);
      expect(selectStarCalls(executions).every((execution) => execution.method === 'get')).toBe(true);
      expect(after).toHaveLength(3);
      expect(after[0]).toBe(warm[0]);
      expect(after[2]).toBe(warm[2]);
      expect(after[1]).not.toBe(warm[1]);
      expect(after[1]?.fingerprint).toBe('fp-b-2');
      expect(after[1]?.tickets).toHaveLength(5);
      db.close();
    });

    it('listProjectRefs() and listProjectsChunked() share the same warm path (no SELECT *)', async () => {
      const { db, executions, reader, writer } = setup();
      writer.putProject(makeEntry(makeProject('a', '/a')));
      writer.putProject(makeEntry(makeProject('b', '/b')));
      reader.listProjects(); // warm
      executions.length = 0;

      reader.listProjectRefs!();
      await reader.listProjectsChunked!();

      expect(selectStarCalls(executions)).toEqual([]);
      expect(executions).toEqual([
        { sql: REFS_SQL, method: 'all' },
        { sql: REFS_SQL, method: 'all' },
      ]);
      db.close();
    });

    it('listProjectRefs() on a cold cache parses each project once, and a following listProjects() is warm', () => {
      const { db, executions, reader, writer } = setup();
      writer.putProject(makeEntry(makeProject('a', '/a')));
      writer.putProject(makeEntry(makeProject('b', '/b')));
      executions.length = 0;

      reader.listProjectRefs!();
      expect(executions.filter((execution) => execution.sql === ROW_BY_ID_SQL)).toHaveLength(2);

      executions.length = 0;
      reader.listProjects();
      expect(selectStarCalls(executions)).toEqual([]);
      db.close();
    });

    // parseCache のヒット判定は fingerprint の一致まで見る (project-listing.ts の resolve)。
    // writer を介さない書き換え (別プロセス等) では parseCache は無効化されないので、
    // fingerprint の不一致だけが「キャッシュの b は古い」と気づく手段になる。
    it('re-reads a project rewritten behind the parse cache (fingerprint mismatch) in all three listings, one get per call', async () => {
      type Reader = ReturnType<typeof setup>['reader'];
      interface Seen {
        readonly names: readonly string[];
        readonly bTicketCount: number | undefined;
      }
      const seenOf = (entries: readonly CachedProject[]): Seen => ({
        names: entries.map((entry) => entry.project.name),
        bTicketCount: entries.find((entry) => entry.project.id === 'b')?.tickets.length,
      });
      const listings: readonly (readonly [string, (reader: Reader) => Promise<Seen>])[] = [
        ['listProjects', (reader) => Promise.resolve(seenOf(reader.listProjects()))],
        [
          'listProjectRefs',
          (reader) =>
            Promise.resolve({
              names: reader.listProjectRefs!().map((project) => project.name),
              bTicketCount: undefined,
            }),
        ],
        ['listProjectsChunked', async (reader) => seenOf(await reader.listProjectsChunked!())],
      ];

      for (const [label, list] of listings) {
        const { db, executions, reader, writer } = setup();
        writer.putProject(makeEntry(makeProject('a', '/a')));
        writer.putProject(makeEntry(makeProject('b', '/b'), { ticketCount: 3 }));
        expect(seenOf(reader.listProjects()).bTicketCount, label).toBe(3); // warm
        db.prepare(
          `UPDATE projects SET name = 'renamed-b', fingerprint = 'fp-2', tickets = '[]' WHERE id = ?`,
        ).run('b');
        executions.length = 0;

        const seen = await list(reader);

        expect(seen.names, label).toEqual(['name-a', 'renamed-b']);
        if (label !== 'listProjectRefs') {
          expect(seen.bTicketCount, label).toBe(0);
        }
        // id/fingerprint の一括取得1回 + 不一致だった b の行取得1回だけ (a は warm のまま)。
        expect(executions, label).toEqual([
          { sql: REFS_SQL, method: 'all' },
          { sql: ROW_BY_ID_SQL, method: 'get' },
        ]);

        // 読み直したあとは parseCache が新しい fingerprint で温まり、次は行を読まない。
        executions.length = 0;
        await list(reader);
        expect(executions, label).toEqual([{ sql: REFS_SQL, method: 'all' }]);
        db.close();
      }
    });
  });

  describe('output is identical to the previous SELECT * implementation', () => {
    function seed(writer: ReturnType<typeof setup>['writer']): void {
      // Inserted out of root_path order on purpose.
      writer.putProject({
        ...makeEntry(makeProject('zeta', '/z/zeta', { aliasPaths: ['/alias/zeta'], prefixes: ['zz', 'z2'] })),
        pendingDecisions: [{ id: 'decision-1', kind: 'gate', allowFreeform: true, question: 'ship?' }],
      });
      writer.putProject(makeEntry(makeProject('alpha', '/a/alpha'), { ticketCount: 4 }));
      writer.putProject(makeEntry(makeProject('mid', '/m/mid'), { ticketCount: 0 }));
    }

    it('matches for cold, warm and post-write reads, in root_path ASC order', () => {
      const { db, reader, writer } = setup();
      seed(writer);

      const expectedCold = legacyListProjects(db);
      expect(expectedCold.map((entry) => entry.project.rootPath)).toEqual(['/a/alpha', '/m/mid', '/z/zeta']);

      expect(reader.listProjects()).toEqual(expectedCold); // cold
      expect(reader.listProjects()).toEqual(expectedCold); // warm

      writer.putProject(makeEntry(makeProject('mid', '/b/mid-moved'), { fingerprint: 'fp-mid-2', ticketCount: 3 }));
      writer.deleteProject('zeta');
      const expectedAfter = legacyListProjects(db);
      expect(expectedAfter.map((entry) => entry.project.id)).toEqual(['alpha', 'mid']);
      expect(reader.listProjects()).toEqual(expectedAfter);
      expect(reader.listProjects()).toEqual(expectedAfter);
      db.close();
    });

    it('listProjectRefs() returns exactly the project of each listProjects() entry', () => {
      const { db, reader, writer } = setup();
      seed(writer);

      for (let call = 0; call < 2; call += 1) {
        const entries = reader.listProjects();
        const refs = reader.listProjectRefs!();
        expect(refs).toEqual(legacyListProjects(db).map((entry) => entry.project));
        expect(refs).toHaveLength(entries.length);
        refs.forEach((project, index) => {
          expect(project).toBe(entries[index]?.project);
        });
      }
      db.close();
    });

    it('listProjectsChunked() returns the same entries as listProjects()', async () => {
      const { db, reader, writer } = setup();
      seed(writer);

      expect(await reader.listProjectsChunked!()).toEqual(legacyListProjects(db));
      expect(await reader.listProjectsChunked!()).toEqual(reader.listProjects());
      db.close();
    });

    it('returns empty arrays for an empty cache', async () => {
      const { db, reader } = setup();
      expect(reader.listProjects()).toEqual([]);
      expect(reader.listProjectRefs!()).toEqual([]);
      expect(await reader.listProjectsChunked!()).toEqual([]);
      db.close();
    });

    it('skips corrupt rows (invalid tickets / invalid prefixes) in all three, and keeps skipping on warm reads', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { db, reader, writer } = setup();
      writer.putProject(makeEntry(makeProject('good-a', '/a')));
      insertRawProject(db, { id: 'bad-tickets', rootPath: '/b', prefixes: '["pfx"]', tickets: '{not valid json' });
      insertRawProject(db, { id: 'bad-prefixes', rootPath: '/c', prefixes: '{"not":"an array"}', tickets: '[]' });
      writer.putProject(makeEntry(makeProject('good-d', '/d')));

      const expected = legacyListProjects(db);
      expect(expected.map((entry) => entry.project.id)).toEqual(['good-a', 'good-d']);

      for (let call = 0; call < 2; call += 1) {
        expect(reader.listProjects()).toEqual(expected);
        expect(reader.listProjectRefs!()).toEqual(expected.map((entry) => entry.project));
        expect(await reader.listProjectsChunked!()).toEqual(expected);
      }
      expect(warnSpy).toHaveBeenCalled();
      db.close();
    });

    it('accepts a valid write over a corrupt row with the same id and then lists it', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { db, reader, writer } = setup();
      insertRawProject(db, { id: 'recoverable', rootPath: '/r', prefixes: '["pfx"]', tickets: '{not valid json' });
      expect(reader.listProjects()).toEqual([]);
      expect(reader.listProjectRefs!()).toEqual([]);

      writer.putProject(makeEntry(makeProject('recoverable', '/r')));
      expect(reader.listProjects().map((entry) => entry.project.id)).toEqual(['recoverable']);
      expect(reader.listProjectRefs!().map((project) => project.id)).toEqual(['recoverable']);
      db.close();
    });
  });
});
