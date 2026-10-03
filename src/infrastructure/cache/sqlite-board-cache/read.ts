import type Database from 'better-sqlite3';
import { statSync } from 'node:fs';
import type {
  BoardCache,
  CachedProject,
  CacheStats,
  CfdSnapshotRow,
  SessionLinkRow,
} from '../../../application/ports/board-cache.js';
import type { ModelUsageTotals } from '../../../application/transcript/extract-usage.js';
import type { InteractionRecord } from '../../../domain/interaction.js';
import type { Project } from '../../../domain/project.js';
import { CACHE_TABLE_NAMES } from './schema.js';
import { createYieldGate, yieldToEventLoop } from '../../../application/board/aggregation-yield.js';
import { rowToCfdSnapshot, rowToInteraction, rowToSessionLink } from './convert.js';
import type {
  CfdSnapshotRowDb,
  InteractionRowDb,
  ProjectRow,
  SessionLinkRowDb,
  SessionUsageRow,
  TranscriptOffsetRow,
} from './row-types.js';
import { parseCachedProjectRow, type ParseCache } from './parse-cache.js';
import { createProjectListing } from './project-listing.js';

// BoardCache (アプリ層のポート) の一部を実装する。Pick で束ねることで、ポート側に
// メソッドが増減したときにここが自動追随し (増分は他モジュール側で要実装、削除は
// 型エラーで検出)、手書きコピーの2箇所が乖離する事故を防ぐ。
export type BoardCacheReadOperations = Pick<
  BoardCache,
  | 'getProject'
  | 'listProjects'
  | 'listProjectRefs'
  | 'listProjectsChunked'
  | 'getTranscriptOffset'
  | 'getSessionUsage'
  | 'listCfdSnapshots'
  | 'getLatestCfdSnapshotDate'
  | 'getCacheStats'
  | 'listSessionLinks'
  | 'listInteractions'
>;

export function createReadOperations(
  db: Database.Database,
  dbPath: string,
  parseCache: ParseCache,
): BoardCacheReadOperations {
  const getProjectStmt = db.prepare(`SELECT * FROM projects WHERE id = ?`);
  // bdboard-5lnh: listProjects / listProjectRefs / listProjectsChunked 共通の解決手順
  // (id, fingerprint の一括取得 → parseCache → 外れた分だけ getProjectStmt.get)。
  const listing = createProjectListing(db, getProjectStmt, parseCache);
  const getTranscriptOffsetStmt = db.prepare(`SELECT byte_offset FROM transcript_offsets WHERE file_path = ?`);
  const listCfdSnapshotsAllStmt = db.prepare(
    `SELECT project_id, status, snapshot_date, snapshotted_at, count FROM cfd_snapshots ORDER BY snapshot_date ASC, project_id ASC, status ASC`,
  );
  const getLatestCfdSnapshotDateStmt = db.prepare(`SELECT MAX(snapshot_date) AS snapshot_date FROM cfd_snapshots`);
  const countTableRowsStmts = Object.fromEntries(
    CACHE_TABLE_NAMES.map((tableName) => [
      tableName,
      db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`),
    ]),
  ) as Record<(typeof CACHE_TABLE_NAMES)[number], Database.Statement>;
  const listSessionLinksStmt = db.prepare(
    `SELECT ticket_id, session_id, project_id, source, confidence, observed_at FROM session_links ORDER BY ticket_id ASC, session_id ASC`,
  );
  const listInteractionsAllStmt = db.prepare(`
    SELECT id, at, actor, ticket_id, field, old_value, new_value, reason
    FROM interactions
    ORDER BY at DESC, id ASC
  `);

  const listEntries = (): readonly CachedProject[] => {
    const results: CachedProject[] = [];
    for (const key of listing.listKeys()) {
      const entry = listing.resolve(key);
      if (entry !== null) {
        results.push(entry);
      }
    }
    return results;
  };

  return {
    getProject(projectId: string): CachedProject | undefined {
      const row = getProjectStmt.get(projectId) as ProjectRow | undefined;
      if (row === undefined) {
        return undefined;
      }
      return parseCachedProjectRow(row, parseCache) ?? undefined;
    },

    // bdboard-5lnh: 以前は `SELECT * FROM projects` で全チケットの JSON テキストを毎回
    // コピーしていたため、parseCache が温まっていても 200k 件で 163〜179ms 同期ブロック
    // した。いまは listing.listKeys() (id, fingerprint だけ) → parseCache → 外れた分だけ
    // 行を読む、の同期のままの手順。1 + (外れた件数) 本の文は各々が自分の autocommit
    // スナップショットで走るので、全体で1つのスナップショットではない。ただし await を
    // 挟まない同期呼び出しなので、同じ接続からの書き込み (projects への書き込みは現状
    // すべてこの接続) は途中に割り込めない。
    listProjects(): readonly CachedProject[] {
      return listEntries();
    },

    // bdboard-5lnh: project (定義) だけを返す射影。コストは listProjects() と同じ
    // (listEntries() の結果から project を取り出すだけ。parseCache が温まっていれば速く、
    // cold なら全件パースする)。順序・「壊れた行は飛ばす」扱いも listProjects() と同じ。
    listProjectRefs(): readonly Project[] {
      return listEntries().map((entry) => entry.project);
    },

    // bdboard-mkkx: listProjects() は SQLite からの読み出しと、行ごとの
    // チケットJSONパース (rowToCachedProject -> deserializeTickets) を1回の
    // 同期処理で行っており、チケット数が多い (実測: 200,000件で590-613ms) と
    // その間イベントループを塞ぐ (bdboard-ve1y で chunk 化した集計ループの
    // 手前で、集計自体より大きなブロックが起きうる)。bdboard-5lnh 以降、この
    // ブロックは parseCache が cold (未パース / putProject 等で無効化直後) のときだけ
    // 起きる。温まっていれば listProjects() は約 0.2ms で、以下はその cold 時の話。
    //
    // stmt.all() で一括取得すると、行の読み出し自体 (SQLite の各行の TEXT
    // 列をJSの文字列としてコピーする部分) がまだチャンク化されずに残る。
    // 実際、200,000件をプロジェクト単位で分けても all() 自体が全プロジェクト
    // 分のJSON文字列 (数十MB) をまとめて取り出すため、最初の yield に到達する
    // 前にこの一括読み出しだけでイベントループを長時間塞いでしまい、
    // 意味のある改善にならなかった (手元の計測で確認済み)。
    //
    // 最初は stmt.iterate() (SQLite の cursor を1行ずつ step するレイジー
    // イテレータ) を await を挟んで回す実装だったが、opusレビューで指摘され
    // 実測でも再現した重大なバグがあった: better-sqlite3 は cursor が
    // 開いたまま (iterate() を最後まで回し切る/break する前) の間、
    // 同じ DB コネクション上での**書き込み**系ステートメントの実行を
    // "This database connection is busy executing a query" で拒否する
    // (SELECT 系の読み出しは通る — コネクション全体ではなく書き込みだけが
    // ブロックされる)。listProjectsChunked() は行ごとに await で
    // イベントループへ制御を返すため、その yield の合間に他のリクエスト
    // (定期リフレッシュの putProject、CFDスナップショットの
    // pruneCfdSnapshots、トランスクリプト取り込みの
    // setTranscriptOffset/appendInteractions 等) が同じ DB コネクション
    // に対して書き込もうとすると、この統計API呼び出しの最中ずっと例外に
    // なりうる。単独の Statement オブジェクトの同時 iterate 不可
    // ("This **statement** is busy executing a query"、別オブジェクトなら
    // 回避可) とは別の、コネクション単位の問題なので、Statement を毎回
    // 新規 prepare するだけでは直らない。
    //
    // そこで cursor を await をまたいで開いたままにしない設計に変更した:
    // (1) まず `id` 列だけを ORDER BY root_path ASC で一括取得する
    // (`.all()`。id 文字列だけなのでチケットJSONを含む行全体の一括取得とは
    // 違い軽い)。(2) 各 id ごとに `getProjectStmt.get(id)` (1行だけ取得して
    // 即座に完了する呼び出し。iterate() と違って呼び出しの間に "開いたまま"
    // の状態を残さない) でその行を取得し、JSON をパースする。(2)の1件ごとに
    // bdboard-ve1y の YieldGate/yieldToEventLoop を再利用してイベントループ
    // へ制御を返す。これで cursor 自体はどのステップでも await をまたがず、
    // yield の合間は DB コネクションが空いているので他の書き込みが通る。
    //
    // JSON.parse は途中で中断できないので、これ以上細かい粒度 (チケット単位)
    // でのチャンク化はできない — チャンク境界は「プロジェクト単位」になる
    // (受け入れ基準が許容する粒度)。listProjects() と同じ行順
    // (ORDER BY root_path ASC) で処理するので、戻り値の順序は変わらない。
    // bdboard-5lnh: (1)(2) の手順 (id, fingerprint の一括取得 → parseCache →
    // 外れた分だけ getProjectStmt.get) は同期版 listProjects() / listProjectRefs()
    // と共通の project-listing.ts に切り出した。違いは yield を挟むかどうかだけ。
    //
    // トレードオフ: (1)の id 一覧取得は1回のスナップショットなので、
    // listProjectsChunked() の実行中に削除された project は該当 id の
    // get() が undefined を返しスキップされる (await を挟まない同期版
    // listProjects() / listProjectRefs() と違い、yield の合間に同じ接続からの書き込みが
    // 割り込めるため、途中で書き込みが入らないという保証は無い)。実行中に新規追加
    // された project は (1)の時点の一覧に含まれないため結果に現れない。
    // どちらも「統計表示が一瞬だけ古いスナップショットを見る」程度の実害で、
    // このAPIの用途 (定期ポーリングされる集計) では許容できる。
    async listProjectsChunked(): Promise<readonly CachedProject[]> {
      const results: CachedProject[] = [];
      const gate = createYieldGate(1);
      for (const key of listing.listKeys()) {
        const entry = listing.resolve(key);
        if (entry !== null) {
          results.push(entry);
        }
        if (gate.shouldYield()) {
          await yieldToEventLoop();
        }
      }
      return results;
    },

    getTranscriptOffset(filePath: string): number | undefined {
      const row = getTranscriptOffsetStmt.get(filePath) as TranscriptOffsetRow | undefined;
      return row?.byte_offset;
    },

    getSessionUsage(sessionIds: readonly string[]): readonly ModelUsageTotals[] {
      if (sessionIds.length === 0) {
        return [];
      }

      const placeholders = sessionIds.map(() => '?').join(', ');
      const rows = db
        .prepare(
          `SELECT
            model,
            SUM(input_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens,
            SUM(cache_creation_input_tokens) AS cache_creation_input_tokens,
            SUM(cache_read_input_tokens) AS cache_read_input_tokens
          FROM session_usage
          WHERE session_id IN (${placeholders})
          GROUP BY model
          ORDER BY model ASC`,
        )
        .all(...sessionIds) as SessionUsageRow[];

      return rows.map((row) => ({
        model: row.model,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cacheCreationInputTokens: row.cache_creation_input_tokens,
        cacheReadInputTokens: row.cache_read_input_tokens,
      }));
    },

    listCfdSnapshots(projectIds?: readonly string[]): readonly CfdSnapshotRow[] {
      if (projectIds === undefined) {
        const rows = listCfdSnapshotsAllStmt.all() as CfdSnapshotRowDb[];
        return rows.map(rowToCfdSnapshot);
      }

      if (projectIds.length === 0) {
        return [];
      }

      const placeholders = projectIds.map(() => '?').join(', ');
      const rows = db
        .prepare(
          `SELECT project_id, status, snapshot_date, snapshotted_at, count
          FROM cfd_snapshots
          WHERE project_id IN (${placeholders})
          ORDER BY snapshot_date ASC, project_id ASC, status ASC`,
        )
        .all(...projectIds) as CfdSnapshotRowDb[];

      return rows.map(rowToCfdSnapshot);
    },

    getLatestCfdSnapshotDate(): string | undefined {
      const row = getLatestCfdSnapshotDateStmt.get() as
        | { readonly snapshot_date: string | null }
        | undefined;
      if (row?.snapshot_date === undefined || row.snapshot_date === null) {
        return undefined;
      }
      return row.snapshot_date;
    },

    getCacheStats(): CacheStats {
      const sizeBytes =
        dbPath === ':memory:'
          ? 0
          : statSync(dbPath, { throwIfNoEntry: false })?.size ?? 0;
      const tables = CACHE_TABLE_NAMES.map((name) => {
        const row = countTableRowsStmts[name].get() as { readonly count: number };
        return { name, rowCount: row.count };
      });
      return { sizeBytes, tables };
    },

    listSessionLinks(): readonly SessionLinkRow[] {
      const rows = listSessionLinksStmt.all() as SessionLinkRowDb[];
      return rows.map(rowToSessionLink);
    },

    listInteractions(options?: { readonly since?: Date }): readonly InteractionRecord[] {
      const since = options?.since;
      if (since === undefined) {
        const rows = listInteractionsAllStmt.all() as InteractionRowDb[];
        return rows.map(rowToInteraction);
      }

      const sinceIso = since.toISOString();
      const rows = db
        .prepare(
          `SELECT id, at, actor, ticket_id, field, old_value, new_value, reason
          FROM interactions
          WHERE at >= ?
          ORDER BY at DESC, id ASC`,
        )
        .all(sinceIso) as InteractionRowDb[];

      return rows.map(rowToInteraction);
    },
  };
}
