import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CachedProject, SessionLinkRow } from '../../application/ports/board-cache.js';
import { MAX_TRANSCRIPT_SESSION_LINKS } from '../../domain/session.js';
import type { Project } from '../../domain/project.js';
import type { Ticket } from '../../domain/ticket.js';
import { MAX_INTERACTIONS, createSqliteBoardCache } from './sqlite-board-cache.js';

// bdboard-ma4: 一時ディレクトリに file-backed な sqlite DB を作るテストは、Windows の
// CI runner で散発的に数秒のI/Oストールを食らう (新規作成される .db/-wal/-shm への
// AV スキャンが有力)。同一 run で file-backed sqlite のテストファイルだけが 2〜9倍に
// 膨らみ、非 sqlite のファイル (chokidar 1298→1302ms 等) は無風だったことを CI ログで
// 確認している。テスト自体は軽い (ローカルでは1件あたり数十ms) ので、アサーションは
// 変えずに待ち時間だけこのファイル単位で伸ばす。全体の testTimeout を上げないのは、
// 173 のテストファイル全部で本物のハングの検知が遅くなるため。30s で必ず落ちるので
// 「無限に待つ」方向には倒していない。
vi.setConfig({ testTimeout: 30_000 });

function makeSessionLinkRow(overrides: {
  ticketId: string;
  sessionId?: string;
  projectId?: string;
  observedAt?: Date;
}): SessionLinkRow {
  return {
    projectId: overrides.projectId ?? 'proj-a',
    link: {
      ticketId: overrides.ticketId,
      sessionId: overrides.sessionId ?? 'sess-1',
      source: 'transcript',
      confidence: 0.6,
      observedAt: overrides.observedAt ?? new Date('2026-08-14T10:00:00.000Z'),
    },
  };
}

function makeProject(overrides: Partial<Project> & Pick<Project, 'id' | 'rootPath'>): Project {
  return {
    name: overrides.name ?? overrides.id,
    prefixes: overrides.prefixes ?? ['pfx'],
    aliasPaths: overrides.aliasPaths ?? [],
    ...overrides,
  };
}

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 'pfx-abc',
    projectId: 'proj-a',
    title: 'Ticket A',
    status: 'open',
    priority: 2,
    issueType: 'task',
    createdAt: new Date('2026-08-14T08:00:00.000Z'),
    updatedAt: new Date('2026-08-14T09:00:00.000Z'),
    dependencies: [],
    commentCount: 0,
    ...overrides,
  };
}

function makeEntry(overrides: {
  project?: Partial<Project> & Pick<Project, 'id' | 'rootPath'>;
  tickets?: readonly Ticket[];
  fingerprint?: string;
  fetchedAt?: Date;
  pendingDecisions?: CachedProject['pendingDecisions'];
}): CachedProject {
  const project = makeProject({
    id: 'proj-a',
    rootPath: '/z/project',
    ...(overrides.project ?? {}),
  });

  return {
    project,
    tickets: overrides.tickets ?? [makeTicket({ projectId: project.id })],
    fingerprint: overrides.fingerprint ?? 'fp-1',
    fetchedAt: overrides.fetchedAt ?? new Date('2026-08-14T10:00:00.000Z'),
    ...(overrides.pendingDecisions !== undefined
      ? { pendingDecisions: overrides.pendingDecisions }
      : {}),
  };
}

describe('createSqliteBoardCache', () => {
  it('round-trips put and get with dates, prefixes, and tickets', () => {
    const cache = createSqliteBoardCache(':memory:');
    const entry = makeEntry({
      project: {
        id: 'proj-a',
        rootPath: '/data/alpha',
        name: 'Alpha',
        prefixes: ['alpha', 'alp'],
      },
      tickets: [
        makeTicket({
          projectId: 'proj-a',
          assignee: 'alice',
          manualSessionId: 'sess-manual',
          dependencies: [
            {
              issueId: 'pfx-abc',
              dependsOnId: 'pfx-block',
              kind: 'blocks',
            },
          ],
        }),
      ],
      fingerprint: 'fp-alpha',
      fetchedAt: new Date('2026-08-14T11:00:00.000Z'),
    });

    cache.putProject(entry);
    const restored = cache.getProject('proj-a');

    expect(restored).toEqual(entry);
    cache.close();
  });

  it('round-trips pendingDecisions through put and get', () => {
    const cache = createSqliteBoardCache(':memory:');
    const entry = makeEntry({
      pendingDecisions: [
        {
          id: 'bdboard-human',
          kind: 'ticket',
          question: 'Approve?',
          options: [{ label: 'Yes', value: 'yes' }],
          allowFreeform: true,
        },
      ],
    });

    cache.putProject(entry);
    const restored = cache.getProject(entry.project.id);

    expect(restored?.pendingDecisions).toEqual(entry.pendingDecisions);
    cache.close();
  });

  it('reads legacy project rows without pending_decisions column data', () => {
    const legacyTmpDir = mkdtempSync(path.join(os.tmpdir(), 'bdboard-cache-no-pending-'));
    const legacyDbPath = path.join(legacyTmpDir, 'no-pending-cache.db');

    const rawDb = new Database(legacyDbPath);
    rawDb.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL,
        prefixes TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        tickets TEXT NOT NULL,
        alias_paths TEXT
      );
      CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO meta (key, value) VALUES ('schema_version', '5');
      INSERT INTO projects (
        id, name, root_path, prefixes, fingerprint, fetched_at, tickets, alias_paths
      ) VALUES (
        'legacy',
        'Legacy',
        '/legacy/root',
        '["pfx"]',
        'fp-legacy',
        '2026-08-14T10:00:00.000Z',
        '[]',
        '[]'
      );
    `);
    rawDb.close();

    const cache = createSqliteBoardCache(legacyDbPath);
    const restored = cache.getProject('legacy');

    expect(restored?.project.id).toBe('legacy');
    expect(restored?.pendingDecisions).toBeUndefined();
    cache.close();
    rmSync(legacyTmpDir, { recursive: true, force: true });
  });

  it('returns undefined for a missing project id', () => {
    const cache = createSqliteBoardCache(':memory:');

    expect(cache.getProject('missing')).toBeUndefined();
    cache.close();
  });

  it('lists projects sorted by rootPath ascending', () => {
    const cache = createSqliteBoardCache(':memory:');

    cache.putProject(
      makeEntry({
        project: { id: 'z', rootPath: '/z/last', name: 'Z' },
        fingerprint: 'fp-z',
      }),
    );
    cache.putProject(
      makeEntry({
        project: { id: 'a', rootPath: '/a/first', name: 'A' },
        fingerprint: 'fp-a',
      }),
    );
    cache.putProject(
      makeEntry({
        project: { id: 'm', rootPath: '/m/mid', name: 'M' },
        fingerprint: 'fp-m',
      }),
    );

    expect(cache.listProjects().map((entry) => entry.project.rootPath)).toEqual([
      '/a/first',
      '/m/mid',
      '/z/last',
    ]);
    cache.close();
  });

  it('replaces an existing project without increasing the count', () => {
    const cache = createSqliteBoardCache(':memory:');

    cache.putProject(
      makeEntry({
        project: { id: 'same', rootPath: '/same', name: 'Same' },
        fingerprint: 'fp-1',
      }),
    );
    cache.putProject(
      makeEntry({
        project: { id: 'same', rootPath: '/same', name: 'Same Updated' },
        fingerprint: 'fp-2',
      }),
    );

    expect(cache.listProjects()).toHaveLength(1);
    expect(cache.getProject('same')?.project.name).toBe('Same Updated');
    expect(cache.getProject('same')?.fingerprint).toBe('fp-2');
    cache.close();
  });

  it('deletes a project and clears all cached projects except cfd snapshots', () => {
    const cache = createSqliteBoardCache(':memory:');

    cache.putProject(
      makeEntry({
        project: { id: 'a', rootPath: '/a', name: 'A' },
      }),
    );
    cache.putProject(
      makeEntry({
        project: { id: 'b', rootPath: '/b', name: 'B' },
      }),
    );
    cache.putCfdSnapshot('2026-08-15', new Date('2026-08-15T09:00:00.000Z'), [
      { projectId: 'a', status: 'open', count: 3 },
    ]);

    cache.deleteProject('a');
    expect(cache.getProject('a')).toBeUndefined();
    expect(cache.getProject('b')).toBeDefined();

    cache.clear();
    expect(cache.listProjects()).toEqual([]);
    expect(cache.listCfdSnapshots()).toEqual([
      expect.objectContaining({
        projectId: 'a',
        status: 'open',
        snapshotDate: '2026-08-15',
        count: 3,
      }),
    ]);
    cache.close();
  });

  it('stores and upserts cfd snapshots by project, status, and date', () => {
    const cache = createSqliteBoardCache(':memory:');
    const firstAt = new Date('2026-08-15T09:00:00.000Z');
    const secondAt = new Date('2026-08-15T18:00:00.000Z');

    cache.putCfdSnapshot('2026-08-15', firstAt, [
      { projectId: 'proj-a', status: 'open', count: 2 },
      { projectId: 'proj-a', status: 'blocked', count: 1 },
    ]);
    cache.putCfdSnapshot('2026-08-15', secondAt, [
      { projectId: 'proj-a', status: 'open', count: 5 },
    ]);
    cache.putCfdSnapshot('2026-08-16', secondAt, [
      { projectId: 'proj-a', status: 'open', count: 1 },
    ]);

    expect(cache.getLatestCfdSnapshotDate()).toBe('2026-08-16');
    expect(cache.listCfdSnapshots()).toEqual([
      {
        projectId: 'proj-a',
        status: 'blocked',
        snapshotDate: '2026-08-15',
        snapshottedAt: firstAt,
        count: 1,
      },
      {
        projectId: 'proj-a',
        status: 'open',
        snapshotDate: '2026-08-15',
        snapshottedAt: secondAt,
        count: 5,
      },
      {
        projectId: 'proj-a',
        status: 'open',
        snapshotDate: '2026-08-16',
        snapshottedAt: secondAt,
        count: 1,
      },
    ]);
    expect(cache.listCfdSnapshots(['proj-a'])).toHaveLength(3);
    expect(cache.listCfdSnapshots([])).toEqual([]);
    cache.close();
  });

  it('prunes cfd snapshots older than the cutoff date', () => {
    const cache = createSqliteBoardCache(':memory:');
    const snapshottedAt = new Date('2026-08-18T09:00:00.000Z');

    cache.putCfdSnapshot('2025-08-17', snapshottedAt, [
      { projectId: 'proj-a', status: 'open', count: 1 },
    ]);
    cache.putCfdSnapshot('2025-08-18', snapshottedAt, [
      { projectId: 'proj-a', status: 'open', count: 2 },
    ]);
    cache.putCfdSnapshot('2026-08-18', snapshottedAt, [
      { projectId: 'proj-a', status: 'open', count: 3 },
    ]);

    expect(cache.pruneCfdSnapshots('2025-08-18')).toBe(1);
    expect(cache.listCfdSnapshots().map((row) => row.snapshotDate)).toEqual([
      '2025-08-18',
      '2026-08-18',
    ]);
    cache.close();
  });

  it('returns db file size and per-table row counts', () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'bdboard-cache-stats-'));
    const dbPath = path.join(tmpDir, 'cache.db');
    const cache = createSqliteBoardCache(dbPath);

    cache.putProject(makeEntry({}));
    cache.putCfdSnapshot('2026-08-18', new Date('2026-08-18T09:00:00.000Z'), [
      { projectId: 'proj-a', status: 'open', count: 1 },
      { projectId: 'proj-a', status: 'blocked', count: 2 },
    ]);

    const stats = cache.getCacheStats();
    expect(stats.sizeBytes).toBeGreaterThan(0);
    expect(stats.tables).toEqual([
      { name: 'projects', rowCount: 1 },
      { name: 'transcript_offsets', rowCount: 0 },
      { name: 'session_usage', rowCount: 0 },
      { name: 'meta', rowCount: 1 },
      { name: 'cfd_snapshots', rowCount: 2 },
      { name: 'session_links', rowCount: 0 },
      { name: 'chat_sessions', rowCount: 0 },
      { name: 'chat_messages', rowCount: 0 },
      { name: 'interactions', rowCount: 0 },
    ]);

    cache.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports zero bytes for in-memory databases', () => {
    const cache = createSqliteBoardCache(':memory:');
    expect(cache.getCacheStats().sizeBytes).toBe(0);
    cache.close();
  });

  it('stores and retrieves transcript offsets', () => {
    const cache = createSqliteBoardCache(':memory:');

    expect(cache.getTranscriptOffset('/tmp/transcript.jsonl')).toBeUndefined();

    cache.setTranscriptOffset('/tmp/transcript.jsonl', 4096);
    expect(cache.getTranscriptOffset('/tmp/transcript.jsonl')).toBe(4096);
    cache.close();
  });

  it('stores interactions with id dedup and lists newest first', () => {
    const cache = createSqliteBoardCache(':memory:');
    const older = {
      id: 'int-fake-sqlite-older',
      at: new Date('2026-08-14T10:00:00.000Z'),
      actor: 'example-agent-a',
      ticketId: 'bdboard-fake-01',
      field: 'priority',
      oldValue: '2',
      newValue: '1',
    };
    const newer = {
      id: 'int-fake-sqlite-newer',
      at: new Date('2026-08-14T12:00:00.000Z'),
      actor: 'example-agent-b',
      ticketId: 'bdboard-fake-02',
      field: 'status',
      oldValue: 'open',
      newValue: 'closed',
      reason: 'example sqlite reason',
    };

    cache.appendInteractions([older, newer]);
    cache.appendInteractions([older]);

    expect(cache.listInteractions()).toEqual([newer, older]);
    expect(
      cache.listInteractions({ since: new Date('2026-08-14T11:00:00.000Z') }),
    ).toEqual([newer]);
    cache.close();
  });

  // bdboard-80r: trimInteractionsToCap() の呼び出しを消した変異体が既存26テスト
  // 全パスで生存していた。双子の session_links 側は既存テストが即検出しており、
  // こちらだけ穴だったので対称のテストを足す。
  it('trims interactions older by at once the cap is exceeded', () => {
    const cache = createSqliteBoardCache(':memory:');
    const overflow = 3;
    const records = [];
    for (let i = 0; i < MAX_INTERACTIONS + overflow; i += 1) {
      records.push({
        id: `int-fake-cap-${i}`,
        at: new Date(Date.UTC(2026, 0, 1) + i * 1000),
        actor: 'example-agent-cap',
        ticketId: `bdboard-fake-${i}`,
        field: 'status',
      });
    }

    cache.appendInteractions(records);
    const listed = cache.listInteractions();

    expect(listed).toHaveLength(MAX_INTERACTIONS);
    // 古い方から溢れる。境界の1件手前/1件後ろまで見ておかないと、
    // 削除件数の off-by-one を見逃す。
    for (let i = 0; i < overflow; i += 1) {
      expect(listed.some((row) => row.id === `int-fake-cap-${i}`)).toBe(false);
    }
    expect(listed.some((row) => row.id === `int-fake-cap-${overflow}`)).toBe(true);
    expect(listed[listed.length - 1]?.id).toBe(`int-fake-cap-${overflow}`);
    cache.close();
  });

  it('keeps enforcing the interactions cap across separate append calls', () => {
    const cache = createSqliteBoardCache(':memory:');
    const make = (i: number) => ({
      id: `int-fake-split-${i}`,
      at: new Date(Date.UTC(2026, 0, 1) + i * 1000),
      actor: 'example-agent-cap',
      ticketId: `bdboard-fake-${i}`,
      field: 'status',
    });

    const first = [];
    for (let i = 0; i < MAX_INTERACTIONS; i += 1) {
      first.push(make(i));
    }
    cache.appendInteractions(first);
    expect(cache.listInteractions()).toHaveLength(MAX_INTERACTIONS);

    // キャップ到達後の追記でも溢れた分だけ古いものが落ちること。
    cache.appendInteractions([make(MAX_INTERACTIONS), make(MAX_INTERACTIONS + 1)]);
    const listed = cache.listInteractions();

    expect(listed).toHaveLength(MAX_INTERACTIONS);
    expect(listed.some((row) => row.id === 'int-fake-split-0')).toBe(false);
    expect(listed.some((row) => row.id === 'int-fake-split-1')).toBe(false);
    expect(listed.some((row) => row.id === 'int-fake-split-2')).toBe(true);
    expect(listed[0]?.id).toBe(`int-fake-split-${MAX_INTERACTIONS + 1}`);
    cache.close();
  });

  it('accumulates and aggregates session usage by model', () => {
    const cache = createSqliteBoardCache(':memory:');

    cache.addSessionUsage('sess-a', {
      model: 'claude-opus-5',
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: 100,
      cacheReadInputTokens: 20,
    });
    cache.addSessionUsage('sess-a', {
      model: 'claude-opus-5',
      inputTokens: 2,
      outputTokens: 1,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 30,
    });
    cache.addSessionUsage('sess-b', {
      model: 'claude-sonnet-5',
      inputTokens: 7,
      outputTokens: 3,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });

    expect(cache.getSessionUsage(['sess-a'])).toEqual([
      {
        model: 'claude-opus-5',
        inputTokens: 12,
        outputTokens: 6,
        cacheCreationInputTokens: 100,
        cacheReadInputTokens: 50,
      },
    ]);
    expect(cache.getSessionUsage(['sess-a', 'sess-b'])).toEqual([
      {
        model: 'claude-opus-5',
        inputTokens: 12,
        outputTokens: 6,
        cacheCreationInputTokens: 100,
        cacheReadInputTokens: 50,
      },
      {
        model: 'claude-sonnet-5',
        inputTokens: 7,
        outputTokens: 3,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
    ]);

    cache.clear();
    expect(cache.getSessionUsage(['sess-a', 'sess-b'])).toEqual([]);
    cache.close();
  });

  it('skips corrupt project rows with invalid prefixes without failing listProjects', () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'bdboard-cache-corrupt-prefixes-'));
    const dbPath = path.join(tmpDir, 'corrupt-prefixes.db');

    try {
      const cache = createSqliteBoardCache(dbPath);
      cache.putProject(
        makeEntry({
          project: { id: 'good', rootPath: '/good', name: 'Good' },
          fingerprint: 'fp-good',
        }),
      );
      cache.close();

      const rawDb = new Database(dbPath);
      rawDb
        .prepare(
          `INSERT INTO projects (
            id, name, root_path, prefixes, fingerprint, fetched_at, tickets, alias_paths
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'bad-prefixes',
          'Bad Prefixes',
          '/bad/prefixes',
          '{not valid json',
          'fp-bad',
          '2026-08-14T10:00:00.000Z',
          '[]',
          '[]',
        );
      rawDb.close();

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const reopened = createSqliteBoardCache(dbPath);

      expect(() => reopened.listProjects()).not.toThrow();
      expect(reopened.listProjects()).toHaveLength(1);
      expect(reopened.listProjects()[0]?.project.id).toBe('good');
      expect(reopened.getProject('bad-prefixes')).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        'bdboard: skipping corrupt project cache row bad-prefixes: invalid prefixes',
      );

      reopened.close();
      warnSpy.mockRestore();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('skips corrupt project rows with invalid tickets without failing listProjects', () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'bdboard-cache-corrupt-tickets-'));
    const dbPath = path.join(tmpDir, 'corrupt-tickets.db');

    try {
      const cache = createSqliteBoardCache(dbPath);
      cache.putProject(
        makeEntry({
          project: { id: 'good', rootPath: '/good', name: 'Good' },
          fingerprint: 'fp-good',
        }),
      );
      cache.close();

      const rawDb = new Database(dbPath);
      rawDb
        .prepare(
          `INSERT INTO projects (
            id, name, root_path, prefixes, fingerprint, fetched_at, tickets, alias_paths
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'bad-tickets',
          'Bad Tickets',
          '/bad/tickets',
          '["pfx"]',
          'fp-bad',
          '2026-08-14T10:00:00.000Z',
          '{not valid json',
          '[]',
        );
      rawDb.close();

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const reopened = createSqliteBoardCache(dbPath);

      expect(() => reopened.listProjects()).not.toThrow();
      expect(reopened.listProjects()).toHaveLength(1);
      expect(reopened.listProjects()[0]?.project.id).toBe('good');
      expect(reopened.getProject('bad-tickets')).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        'bdboard: skipping corrupt project cache row bad-tickets: invalid tickets',
      );

      reopened.close();
      warnSpy.mockRestore();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('round-trips aliasPaths on put and get', () => {
    const cache = createSqliteBoardCache(':memory:');
    const entry = makeEntry({
      project: {
        id: 'proj-alias',
        rootPath: '/r/main',
        name: 'Main',
        aliasPaths: ['/w/foo', '/w/bar'],
      },
    });

    cache.putProject(entry);
    const restored = cache.getProject('proj-alias');

    expect(restored?.project.aliasPaths).toEqual(['/w/foo', '/w/bar']);
    expect(cache.listProjects()[0]?.project.aliasPaths).toEqual(['/w/foo', '/w/bar']);
    cache.close();
  });

  it('upserts and lists session links, round-tripping ticket/session/project/observedAt', () => {
    const cache = createSqliteBoardCache(':memory:');

    cache.upsertSessionLinks([
      makeSessionLinkRow({ ticketId: 'pfx-b', sessionId: 'sess-2', projectId: 'proj-b' }),
      makeSessionLinkRow({ ticketId: 'pfx-a', sessionId: 'sess-1', projectId: 'proj-a' }),
    ]);

    expect(cache.listSessionLinks()).toEqual([
      makeSessionLinkRow({ ticketId: 'pfx-a', sessionId: 'sess-1', projectId: 'proj-a' }),
      makeSessionLinkRow({ ticketId: 'pfx-b', sessionId: 'sess-2', projectId: 'proj-b' }),
    ]);
    cache.close();
  });

  it('upserts by (ticketId, sessionId), replacing the stored fields instead of duplicating', () => {
    const cache = createSqliteBoardCache(':memory:');

    cache.upsertSessionLinks([
      makeSessionLinkRow({
        ticketId: 'pfx-a',
        sessionId: 'sess-1',
        observedAt: new Date('2026-08-14T10:00:00.000Z'),
      }),
    ]);
    cache.upsertSessionLinks([
      makeSessionLinkRow({
        ticketId: 'pfx-a',
        sessionId: 'sess-1',
        observedAt: new Date('2026-08-14T11:00:00.000Z'),
      }),
    ]);

    const links = cache.listSessionLinks();
    expect(links).toHaveLength(1);
    expect(links[0]?.link.observedAt).toEqual(new Date('2026-08-14T11:00:00.000Z'));
    cache.close();
  });

  it('trims session links older by observedAt once the cap is exceeded', () => {
    const cache = createSqliteBoardCache(':memory:');
    const overflow = 3;
    const rows: SessionLinkRow[] = [];
    for (let i = 0; i < MAX_TRANSCRIPT_SESSION_LINKS + overflow; i += 1) {
      rows.push(
        makeSessionLinkRow({
          ticketId: `pfx-${i}`,
          sessionId: `sess-${i}`,
          observedAt: new Date(2026, 0, 1, 0, 0, i),
        }),
      );
    }

    cache.upsertSessionLinks(rows);
    const links = cache.listSessionLinks();

    expect(links).toHaveLength(MAX_TRANSCRIPT_SESSION_LINKS);
    for (let i = 0; i < overflow; i += 1) {
      expect(links.some((row) => row.link.ticketId === `pfx-${i}`)).toBe(false);
    }
    expect(links.some((row) => row.link.ticketId === `pfx-${overflow}`)).toBe(true);
    cache.close();
  });

  // bdboard-wa9: 双子の interactions 側 (bdboard-80r) には「cap 到達後の追記」の
  // テストがあるのに、session_links 側は1バッチ経路しか見ていなかった。
  it('keeps enforcing the session link cap across separate upsert calls', () => {
    const cache = createSqliteBoardCache(':memory:');
    const make = (i: number): SessionLinkRow =>
      makeSessionLinkRow({
        ticketId: `pfx-${i}`,
        sessionId: `sess-${i}`,
        observedAt: new Date(2026, 0, 1, 0, 0, i),
      });

    const first: SessionLinkRow[] = [];
    for (let i = 0; i < MAX_TRANSCRIPT_SESSION_LINKS; i += 1) {
      first.push(make(i));
    }
    cache.upsertSessionLinks(first);
    expect(cache.listSessionLinks()).toHaveLength(MAX_TRANSCRIPT_SESSION_LINKS);

    // ちょうど cap の状態から、既存リンクの再観測と新規2件を同じバッチで積む。
    // これは実際のスキャン1回分の形でもある。溢れた2件が落ちること、かつ
    // 「落ちる2件」は挿入順ではなく observed_at で選ばれること。
    //
    // pfx-0 は最初に入った = rowid 最小だが、ここで再観測して最新にする。
    // upsert の ON CONFLICT は observed_at だけ更新して rowid を動かさないので、
    // trim が ORDER BY rowid だと「今まさに生きているセッション」を捨てて
    // しまう。session_links にしか無い意味論 (interactions 側は
    // INSERT OR IGNORE で再観測経路が存在しない) なので、双子のテストを
    // 写しただけでは塞がらない (PR#123 fable レビュー)。
    cache.upsertSessionLinks([
      makeSessionLinkRow({
        ticketId: 'pfx-0',
        sessionId: 'sess-0',
        observedAt: new Date(2026, 0, 1, 0, 0, MAX_TRANSCRIPT_SESSION_LINKS + 2),
      }),
      make(MAX_TRANSCRIPT_SESSION_LINKS),
      make(MAX_TRANSCRIPT_SESSION_LINKS + 1),
    ]);
    const links = cache.listSessionLinks();

    expect(links).toHaveLength(MAX_TRANSCRIPT_SESSION_LINKS);
    // 再観測したので生き残る。挿入順で捨てていると落ちる。
    expect(links.some((row) => row.link.ticketId === 'pfx-0')).toBe(true);
    expect(links.some((row) => row.link.ticketId === 'pfx-1')).toBe(false);
    expect(links.some((row) => row.link.ticketId === 'pfx-2')).toBe(false);
    expect(links.some((row) => row.link.ticketId === 'pfx-3')).toBe(true);
    expect(
      links.some(
        (row) => row.link.ticketId === `pfx-${MAX_TRANSCRIPT_SESSION_LINKS + 1}`,
      ),
    ).toBe(true);
    cache.close();
  });

  it('clear() removes session links along with the other rebuildable caches', () => {
    const cache = createSqliteBoardCache(':memory:');

    cache.upsertSessionLinks([makeSessionLinkRow({ ticketId: 'pfx-a' })]);
    expect(cache.listSessionLinks()).toHaveLength(1);

    cache.clear();
    expect(cache.listSessionLinks()).toEqual([]);
    cache.close();
  });

  describe('file-backed database', () => {
    let tmpDir: string;
    let dbPath: string;

    afterEach(() => {
      if (tmpDir !== undefined) {
        const resolvedTmpDir = path.resolve(tmpDir);
        const resolvedTmpRoot = path.resolve(os.tmpdir());
        expect(resolvedTmpDir.startsWith(resolvedTmpRoot)).toBe(true);
        rmSync(resolvedTmpDir, { recursive: true, force: true });
      }
    });

    it('recreates the schema when schema_version differs', () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), 'bdboard-cache-'));
      dbPath = path.join(tmpDir, 'cache.db');

      const cache = createSqliteBoardCache(dbPath);
      cache.putProject(
        makeEntry({
          project: { id: 'persisted', rootPath: '/persisted', name: 'Persisted' },
        }),
      );
      cache.close();

      const rawDb = new Database(dbPath);
      rawDb.prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run('0');
      rawDb.close();

      const reopened = createSqliteBoardCache(dbPath);
      expect(reopened.listProjects()).toEqual([]);
      reopened.close();
    });

    it('migrates legacy projects tables without alias_paths and defaults aliasPaths to []', () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), 'bdboard-cache-legacy-'));
      dbPath = path.join(tmpDir, 'legacy-cache.db');

      const rawDb = new Database(dbPath);
      rawDb.exec(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          root_path TEXT NOT NULL,
          prefixes TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          fetched_at TEXT NOT NULL,
          tickets TEXT NOT NULL
        );
        CREATE TABLE meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        INSERT INTO meta (key, value) VALUES ('schema_version', '1');
        INSERT INTO projects (
          id, name, root_path, prefixes, fingerprint, fetched_at, tickets
        ) VALUES (
          'legacy',
          'Legacy',
          '/legacy/root',
          '["pfx"]',
          'fp-legacy',
          '2026-08-14T10:00:00.000Z',
          '[]'
        );
      `);
      rawDb.close();

      const cache = createSqliteBoardCache(dbPath);

      expect(cache.getProject('legacy')?.project.aliasPaths).toEqual([]);
      expect(cache.listProjects()[0]?.project.aliasPaths).toEqual([]);

      cache.putProject(
        makeEntry({
          project: {
            id: 'legacy',
            rootPath: '/legacy/root',
            name: 'Legacy Updated',
            aliasPaths: ['/w/foo'],
          },
          fingerprint: 'fp-updated',
        }),
      );
      expect(cache.getProject('legacy')?.project.aliasPaths).toEqual(['/w/foo']);
      cache.close();
    });

    it('migrates v2 databases in place by adding cfd_snapshots', () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), 'bdboard-cache-v2-'));
      dbPath = path.join(tmpDir, 'v2-cache.db');

      const rawDb = new Database(dbPath);
      rawDb.exec(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          root_path TEXT NOT NULL,
          prefixes TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          fetched_at TEXT NOT NULL,
          tickets TEXT NOT NULL,
          alias_paths TEXT
        );
        CREATE TABLE transcript_offsets (
          file_path TEXT PRIMARY KEY,
          byte_offset INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE session_usage (
          session_id TEXT NOT NULL,
          model TEXT NOT NULL,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (session_id, model)
        );
        CREATE TABLE meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        INSERT INTO meta (key, value) VALUES ('schema_version', '2');
        INSERT INTO projects (
          id, name, root_path, prefixes, fingerprint, fetched_at, tickets, alias_paths
        ) VALUES (
          'kept',
          'Kept',
          '/kept/root',
          '["pfx"]',
          'fp-kept',
          '2026-08-14T10:00:00.000Z',
          '[]',
          '[]'
        );
      `);
      rawDb.close();

      const cache = createSqliteBoardCache(dbPath);
      cache.putCfdSnapshot('2026-08-15', new Date('2026-08-15T09:00:00.000Z'), [
        { projectId: 'kept', status: 'open', count: 4 },
      ]);

      expect(cache.getProject('kept')?.project.name).toBe('Kept');
      expect(cache.listCfdSnapshots()).toEqual([
        expect.objectContaining({
          projectId: 'kept',
          status: 'open',
          snapshotDate: '2026-08-15',
          count: 4,
        }),
      ]);
      cache.close();
    });

    it('migrates v3 databases in place by adding session_links', () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), 'bdboard-cache-v3-'));
      dbPath = path.join(tmpDir, 'v3-cache.db');

      const rawDb = new Database(dbPath);
      rawDb.exec(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          root_path TEXT NOT NULL,
          prefixes TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          fetched_at TEXT NOT NULL,
          tickets TEXT NOT NULL,
          alias_paths TEXT
        );
        CREATE TABLE transcript_offsets (
          file_path TEXT PRIMARY KEY,
          byte_offset INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE session_usage (
          session_id TEXT NOT NULL,
          model TEXT NOT NULL,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (session_id, model)
        );
        CREATE TABLE cfd_snapshots (
          project_id TEXT NOT NULL,
          status TEXT NOT NULL,
          snapshot_date TEXT NOT NULL,
          snapshotted_at TEXT NOT NULL,
          count INTEGER NOT NULL,
          PRIMARY KEY (project_id, status, snapshot_date)
        );
        CREATE TABLE meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        INSERT INTO meta (key, value) VALUES ('schema_version', '3');
        INSERT INTO projects (
          id, name, root_path, prefixes, fingerprint, fetched_at, tickets, alias_paths
        ) VALUES (
          'kept-v3',
          'Kept V3',
          '/kept-v3/root',
          '["pfx"]',
          'fp-kept-v3',
          '2026-08-14T10:00:00.000Z',
          '[]',
          '[]'
        );
        INSERT INTO cfd_snapshots (
          project_id, status, snapshot_date, snapshotted_at, count
        ) VALUES (
          'kept-v3', 'open', '2026-08-15', '2026-08-15T09:00:00.000Z', 2
        );
      `);
      rawDb.close();

      const cache = createSqliteBoardCache(dbPath);

      // v3->v4 は既存データを保ったまま session_links テーブルだけを追加する in-place
      // 移行であること(recreate されて projects/cfd_snapshots が消えないこと)を確認する。
      expect(cache.getProject('kept-v3')?.project.name).toBe('Kept V3');
      expect(cache.listCfdSnapshots()).toEqual([
        expect.objectContaining({ projectId: 'kept-v3', status: 'open', count: 2 }),
      ]);

      cache.upsertSessionLinks([makeSessionLinkRow({ ticketId: 'pfx-new', projectId: 'kept-v3' })]);
      expect(cache.listSessionLinks()).toEqual([
        makeSessionLinkRow({ ticketId: 'pfx-new', projectId: 'kept-v3' }),
      ]);
      cache.close();
    });

    it('migrates v4 databases in place by adding chat_sessions', () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), 'bdboard-cache-v4-'));
      dbPath = path.join(tmpDir, 'v4-cache.db');

      const rawDb = new Database(dbPath);
      rawDb.exec(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          root_path TEXT NOT NULL,
          prefixes TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          fetched_at TEXT NOT NULL,
          tickets TEXT NOT NULL,
          alias_paths TEXT
        );
        CREATE TABLE transcript_offsets (
          file_path TEXT PRIMARY KEY,
          byte_offset INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE session_usage (
          session_id TEXT NOT NULL,
          model TEXT NOT NULL,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (session_id, model)
        );
        CREATE TABLE cfd_snapshots (
          project_id TEXT NOT NULL,
          status TEXT NOT NULL,
          snapshot_date TEXT NOT NULL,
          snapshotted_at TEXT NOT NULL,
          count INTEGER NOT NULL,
          PRIMARY KEY (project_id, status, snapshot_date)
        );
        CREATE TABLE session_links (
          ticket_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          source TEXT NOT NULL,
          confidence REAL NOT NULL,
          observed_at TEXT NOT NULL,
          PRIMARY KEY (ticket_id, session_id)
        );
        CREATE TABLE meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        INSERT INTO meta (key, value) VALUES ('schema_version', '4');
        INSERT INTO projects (
          id, name, root_path, prefixes, fingerprint, fetched_at, tickets, alias_paths
        ) VALUES (
          'kept-v4',
          'Kept V4',
          '/kept-v4/root',
          '["pfx"]',
          'fp-kept-v4',
          '2026-08-14T10:00:00.000Z',
          '[]',
          '[]'
        );
        INSERT INTO cfd_snapshots (
          project_id, status, snapshot_date, snapshotted_at, count
        ) VALUES (
          'kept-v4', 'open', '2026-08-15', '2026-08-15T09:00:00.000Z', 3
        );
        INSERT INTO session_links (
          ticket_id, session_id, project_id, source, confidence, observed_at
        ) VALUES (
          'pfx-kept', 'sess-kept', 'kept-v4', 'transcript', 0.6, '2026-08-15T09:00:00.000Z'
        );
      `);
      rawDb.close();

      const cache = createSqliteBoardCache(dbPath);

      // v4->v5 は既存データを保ったまま chat_sessions テーブルだけを追加する in-place
      // 移行であること(recreate されて projects/cfd_snapshots/session_links が消えないこと)
      // を確認する。bdboard-3tw.83 の v3->v4 移行テストと同じ形。
      expect(cache.getProject('kept-v4')?.project.name).toBe('Kept V4');
      expect(cache.listCfdSnapshots()).toEqual([
        expect.objectContaining({ projectId: 'kept-v4', status: 'open', count: 3 }),
      ]);
      expect(cache.listSessionLinks()).toEqual([
        makeSessionLinkRow({
          ticketId: 'pfx-kept',
          sessionId: 'sess-kept',
          projectId: 'kept-v4',
          observedAt: new Date('2026-08-15T09:00:00.000Z'),
        }),
      ]);

      // chat_sessions テーブルが実際に作られ、使えることを直接 SQL で確認する
      // (BoardCache のインターフェース越しではなく、schema 移行そのものの検証として)。
      cache.close();
      const reopened = new Database(dbPath);
      reopened
        .prepare(
          `INSERT INTO chat_sessions (project_id, session_id, last_used_at) VALUES (?, ?, ?)`,
        )
        .run('kept-v4', 'chat-sess-1', '2026-08-15T09:30:00.000Z');
      const row = reopened
        .prepare(`SELECT session_id FROM chat_sessions WHERE project_id = ?`)
        .get('kept-v4') as { readonly session_id: string } | undefined;
      expect(row?.session_id).toBe('chat-sess-1');
      const versionRow = reopened
        .prepare(`SELECT value FROM meta WHERE key = 'schema_version'`)
        .get() as { readonly value: string };
      expect(versionRow.value).toBe('6');
      reopened.close();
    });

    it('adds chat_messages in place when upgrading from schema v5', () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), 'bdboard-cache-v5-to-v6-'));
      dbPath = path.join(tmpDir, 'v5-cache.db');

      const rawDb = new Database(dbPath);
      rawDb.exec(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          root_path TEXT NOT NULL,
          prefixes TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          fetched_at TEXT NOT NULL,
          tickets TEXT NOT NULL,
          alias_paths TEXT,
          pending_decisions TEXT
        );
        CREATE TABLE chat_sessions (
          project_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          last_used_at TEXT NOT NULL,
          agent_id TEXT NOT NULL DEFAULT 'claude',
          PRIMARY KEY (project_id, session_id)
        );
        CREATE TABLE meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        INSERT INTO meta (key, value) VALUES ('schema_version', '5');
        INSERT INTO projects (
          id, name, root_path, prefixes, fingerprint, fetched_at, tickets, alias_paths
        ) VALUES (
          'kept-v5',
          'Kept V5',
          '/kept-v5/root',
          '["pfx"]',
          'fp-kept-v5',
          '2026-08-14T10:00:00.000Z',
          '[]',
          '[]'
        );
        INSERT INTO chat_sessions (
          project_id, session_id, last_used_at, agent_id
        ) VALUES (
          'kept-v5', 'chat-sess-kept', '2026-08-15T09:00:00.000Z', 'claude'
        );
      `);
      rawDb.close();

      const cache = createSqliteBoardCache(dbPath);
      expect(cache.getProject('kept-v5')?.project.name).toBe('Kept V5');
      cache.close();

      const reopened = new Database(dbPath);
      reopened
        .prepare(
          `INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)`,
        )
        .run(
          'chat-sess-kept',
          'user',
          'hello',
          '2026-08-16T03:00:00.000Z',
        );
      const messageRow = reopened
        .prepare(`SELECT content FROM chat_messages WHERE session_id = ?`)
        .get('chat-sess-kept') as { readonly content: string } | undefined;
      expect(messageRow?.content).toBe('hello');
      const sessionRow = reopened
        .prepare(`SELECT session_id FROM chat_sessions WHERE project_id = ?`)
        .get('kept-v5') as { readonly session_id: string } | undefined;
      expect(sessionRow?.session_id).toBe('chat-sess-kept');
      const versionRow = reopened
        .prepare(`SELECT value FROM meta WHERE key = 'schema_version'`)
        .get() as { readonly value: string };
      expect(versionRow.value).toBe('6');
      reopened.close();
    });

    it('persists session links across reopening the database (new instance)', () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), 'bdboard-cache-session-links-'));
      dbPath = path.join(tmpDir, 'session-links-cache.db');

      const first = createSqliteBoardCache(dbPath);
      first.upsertSessionLinks([
        makeSessionLinkRow({
          ticketId: 'pfx-a',
          sessionId: 'sess-1',
          projectId: 'proj-a',
          observedAt: new Date('2026-08-14T10:00:00.000Z'),
        }),
        makeSessionLinkRow({
          ticketId: 'pfx-b',
          sessionId: 'sess-2',
          projectId: 'proj-b',
          observedAt: new Date('2026-08-14T11:00:00.000Z'),
        }),
      ]);
      first.close();

      const reopened = createSqliteBoardCache(dbPath);
      expect(reopened.listSessionLinks()).toEqual([
        makeSessionLinkRow({
          ticketId: 'pfx-a',
          sessionId: 'sess-1',
          projectId: 'proj-a',
          observedAt: new Date('2026-08-14T10:00:00.000Z'),
        }),
        makeSessionLinkRow({
          ticketId: 'pfx-b',
          sessionId: 'sess-2',
          projectId: 'proj-b',
          observedAt: new Date('2026-08-14T11:00:00.000Z'),
        }),
      ]);
      reopened.close();
    });
  });
});
