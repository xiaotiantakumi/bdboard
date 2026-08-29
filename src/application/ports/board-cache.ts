import type { InteractionRecord } from '../../domain/interaction.js';
import type { Project } from '../../domain/project.js';
import type { SessionLink } from '../../domain/session.js';
import type { Ticket } from '../../domain/ticket.js';
import type { ModelUsageTotals } from '../transcript/extract-usage.js';
import type { PendingDecision } from './human-decisions.js';

export interface CachedProject {
  readonly project: Project;
  readonly tickets: readonly Ticket[];
  readonly fingerprint: string;
  readonly fetchedAt: Date;
  readonly pendingDecisions?: readonly PendingDecision[];
}

/** 永続化されるセッションリンク1件。projectId はクエリ用の付随情報で、一意性は(ticketId, sessionId)で決まる。 */
export interface SessionLinkRow {
  readonly projectId: string;
  readonly link: SessionLink;
}

export interface CfdSnapshotRow {
  readonly projectId: string;
  readonly status: string;
  readonly snapshotDate: string;
  readonly snapshottedAt: Date;
  readonly count: number;
}

export interface CacheStats {
  readonly sizeBytes: number;
  readonly tables: readonly { readonly name: string; readonly rowCount: number }[];
}

export interface BoardCache {
  getProject(projectId: string): CachedProject | undefined;
  putProject(entry: CachedProject): void;
  /** project.rootPath 昇順 */
  listProjects(): readonly CachedProject[];
  deleteProject(projectId: string): void;
  clear(): void;
  /** S8で使う */
  getTranscriptOffset(filePath: string): number | undefined;
  setTranscriptOffset(filePath: string, offset: number): void;
  /** session単位の累積usage(モデル別)。加算(増分)で呼ぶ。 */
  addSessionUsage(sessionId: string, usage: ModelUsageTotals): void;
  /** sessionId集合に対する集計usage(モデル別合計)を返す */
  getSessionUsage(sessionIds: readonly string[]): readonly ModelUsageTotals[];
  /** 指定日付(YYYY-MM-DD, ローカル)の project×status カウントを冪等に記録(UPSERT)する */
  putCfdSnapshot(
    snapshotDate: string,
    snapshottedAt: Date,
    rows: readonly { projectId: string; status: string; count: number }[],
  ): void;
  /** 指定プロジェクト群(未指定なら全部)の過去スナップショットを日付昇順で返す */
  listCfdSnapshots(projectIds?: readonly string[]): readonly CfdSnapshotRow[];
  /** 直近のスナップショット日付(YYYY-MM-DD)。無ければ undefined */
  getLatestCfdSnapshotDate(): string | undefined;
  /** snapshot_date < olderThanDate (YYYY-MM-DD) の行を削除し、削除件数を返す */
  pruneCfdSnapshots(olderThanDate: string): number;
  /** DBファイルサイズとテーブル別件数 */
  getCacheStats(): CacheStats;
  /**
   * トランスクリプト走査由来のセッションリンクを upsert する((ticketId, sessionId)で一意)。
   * MAX_TRANSCRIPT_SESSION_LINKS を超えた分は observedAt が古い順に削除される。
   */
  upsertSessionLinks(rows: readonly SessionLinkRow[]): void;
  /** 全セッションリンクを ticketId→sessionId 昇順で返す */
  listSessionLinks(): readonly SessionLinkRow[];
  /**
   * 相互作用ログを追記する(id で一意)。
   * MAX_INTERACTIONS を超えた分は at が古い順に削除される。
   */
  appendInteractions(records: readonly InteractionRecord[]): void;
  listInteractions(options?: { readonly since?: Date }): readonly InteractionRecord[];
  close(): void;
}
