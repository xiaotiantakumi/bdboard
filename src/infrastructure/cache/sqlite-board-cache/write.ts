import type Database from 'better-sqlite3';
import type { BoardCache, CachedProject, SessionLinkRow } from '../../../application/ports/board-cache.js';
import type { ModelUsageTotals } from '../../../application/transcript/extract-usage.js';
import type { InteractionRecord } from '../../../domain/interaction.js';
import { serializeTickets } from '../ticket-serialization.js';
import type { ParseCache } from './parse-cache.js';
import { createLinksWriteOperations } from './write-links.js';

export { MAX_INTERACTIONS } from './write-links.js';

// BoardCache (アプリ層のポート) の一部を実装する。read.ts と同じ理由で Pick を使う
// (BoardCacheReadOperations のコメント参照)。
export type BoardCacheWriteOperations = Pick<
  BoardCache,
  | 'putProject'
  | 'deleteProject'
  | 'clear'
  | 'setTranscriptOffset'
  | 'addSessionUsage'
  | 'putCfdSnapshot'
  | 'pruneCfdSnapshots'
  | 'upsertSessionLinks'
  | 'appendInteractions'
>;

export function createWriteOperations(db: Database.Database, parseCache: ParseCache): BoardCacheWriteOperations {
  const putProjectStmt = db.prepare(`
    INSERT OR REPLACE INTO projects (
      id, name, root_path, prefixes, fingerprint, fetched_at, tickets, alias_paths, pending_decisions
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const deleteProjectStmt = db.prepare(`DELETE FROM projects WHERE id = ?`);
  const setTranscriptOffsetStmt = db.prepare(`
    INSERT OR REPLACE INTO transcript_offsets (file_path, byte_offset, updated_at)
    VALUES (?, ?, ?)
  `);
  const addSessionUsageStmt = db.prepare(`
    INSERT INTO session_usage (
      session_id,
      model,
      input_tokens,
      output_tokens,
      cache_creation_input_tokens,
      cache_read_input_tokens
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, model) DO UPDATE SET
      input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens,
      cache_creation_input_tokens = cache_creation_input_tokens + excluded.cache_creation_input_tokens,
      cache_read_input_tokens = cache_read_input_tokens + excluded.cache_read_input_tokens
  `);
  const putCfdSnapshotStmt = db.prepare(`
    INSERT OR REPLACE INTO cfd_snapshots (
      project_id, status, snapshot_date, snapshotted_at, count
    ) VALUES (?, ?, ?, ?, ?)
  `);
  const pruneCfdSnapshotsStmt = db.prepare(`
    DELETE FROM cfd_snapshots WHERE snapshot_date < ?
  `);

  const linksWriteOperations = createLinksWriteOperations(db);

  return {
    putProject(entry: CachedProject): void {
      putProjectStmt.run(
        entry.project.id,
        entry.project.name,
        entry.project.rootPath,
        JSON.stringify(entry.project.prefixes),
        entry.fingerprint,
        entry.fetchedAt.toISOString(),
        serializeTickets(entry.tickets),
        JSON.stringify(entry.project.aliasPaths),
        entry.pendingDecisions !== undefined
          ? JSON.stringify(entry.pendingDecisions)
          : null,
      );
      parseCache.delete(entry.project.id);
    },

    deleteProject(projectId: string): void {
      deleteProjectStmt.run(projectId);
      parseCache.delete(projectId);
    },

    clear(): void {
      // cfd_snapshots / chat_sessions / chat_messages は意図的に除外:
      // - cfd_snapshots: 削除すると再構築不能な唯一の時系列データ。
      // - chat_sessions: session_usage/session_links と違い、bd/transcript の再スキャンで
      //   復元できるデータではない (このチャット機能が実際に発行したセッションIDだけを
      //   記憶する security 目的の台帳)。再スキャンで復元してしまうと「このアプリ経由で
      //   始めたセッションのみ resume を許す」という isKnown() の検証意図が崩れるため、
      //   clear() で一律に消してよい対象ではない。
      // - chat_messages: 会話本文は bd/transcript から復元できない。
      // 他のテーブルは元データ(bd/transcript)から再構築可能。
      db.exec(
        `DELETE FROM projects; DELETE FROM transcript_offsets; DELETE FROM session_usage; DELETE FROM session_links; DELETE FROM interactions;`,
      );
      // bdboard-3c36 opus review で見つかったバグの修正: putProject/deleteProject
      // と同じ理由で clear() も parseCache を空にする必要がある。これを忘れると
      // 実害が2つあった: (1) 実行中の listProjectsChunked() (id一覧を先に
      // スナップショットし、1件ずつ await で処理する) が、自分の開始後に
      // clear() が呼ばれた場合、未処理の id について古い parseCache のエントリを
      // 依然ヒットさせてしまい、DB からはもう消えた project を結果に混入させる
      // (listProjects() は毎回 DB 行を先に読み直すので影響されないが、
      // listProjectsChunked() は id 一覧取得後の各ステップで parseCache を
      // 見るため影響される)。(2) clear() 後も Map が空にならず、消えたはずの
      // project 分のパース結果がプロセス終了までメモリに残り続ける。
      parseCache.clear();
    },

    setTranscriptOffset(filePath: string, offset: number): void {
      setTranscriptOffsetStmt.run(filePath, offset, new Date().toISOString());
    },

    addSessionUsage(sessionId: string, usage: ModelUsageTotals): void {
      addSessionUsageStmt.run(
        sessionId,
        usage.model,
        usage.inputTokens,
        usage.outputTokens,
        usage.cacheCreationInputTokens,
        usage.cacheReadInputTokens,
      );
    },

    putCfdSnapshot(
      snapshotDate: string,
      snapshottedAt: Date,
      rows: readonly { projectId: string; status: string; count: number }[],
    ): void {
      const snapshottedAtIso = snapshottedAt.toISOString();
      const writeMany = db.transaction(
        (entries: readonly { projectId: string; status: string; count: number }[]) => {
          for (const row of entries) {
            putCfdSnapshotStmt.run(
              row.projectId,
              row.status,
              snapshotDate,
              snapshottedAtIso,
              row.count,
            );
          }
        },
      );
      writeMany(rows);
    },

    pruneCfdSnapshots(olderThanDate: string): number {
      const result = pruneCfdSnapshotsStmt.run(olderThanDate);
      return result.changes;
    },

    upsertSessionLinks(rows: readonly SessionLinkRow[]): void {
      linksWriteOperations.upsertSessionLinks(rows);
    },

    appendInteractions(records: readonly InteractionRecord[]): void {
      linksWriteOperations.appendInteractions(records);
    },
  };
}
