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
  /**
   * project.rootPath 昇順。
   * bdboard-5lnh: 実装は同期のまま、parseCache が温まっていれば全チケットの JSON
   * テキストを SQLite から読み直さない (id, fingerprint の一括取得 → parseCache →
   * 外れた分だけ行を読む)。1回の同期呼び出しの中で完結するので、呼び出しの途中に
   * 他の書き込みが割り込めない (原子性は変わらない)。壊れた行 (prefixes/tickets の
   * JSON が不正) は結果に含めない。
   */
  listProjects(): readonly CachedProject[];
  /**
   * bdboard-5lnh: listProjects().map((entry) => entry.project) と同じ結果 (同じ
   * project.rootPath 昇順・同じく壊れた行は含めない) を返す軽量版。チケットを使わず
   * project (id / name / rootPath / prefixes / aliasPaths) だけが要る呼び出し元
   * (セッション走査・reclaim・ヘルス系ルート等) 向け。実装は同期で、parseCache が
   * 温まっていればチケットのテキストに一切触れない。
   * 省略可能: インメモリ fake は未実装でよい。呼び出し側は直接呼ばず
   * application/board/read-cached-projects.ts の readProjectRefs() を使うこと
   * (未実装なら listProjects().map(...) にフォールバックする)。
   */
  listProjectRefs?(): readonly Project[];
  /**
   * bdboard-mkkx: listProjects() と同じ結果 (project.rootPath 昇順) を返すが、
   * SQLite からの読み出し・チケットJSONのパースをプロジェクト単位でチャンク化し、
   * 行を処理するたびにイベントループへ制御を返す (aggregation-yield.ts の
   * YieldGate/yieldToEventLoop を再利用)。チケット数が多い (数十万件規模) と
   * listProjects() は1回の同期処理で数百msブロックしうるため、/api/health 等
   * 他リクエストを長時間待たせたくない経路 (stats集計) はこちらを使う。
   * 省略可能: インメモリ fake は同期実装のままで構わない (listProjects() に
   * フォールバックする)。呼び出し側は三項演算子を自前で書かず
   * application/board/read-cached-projects.ts の readProjectEntries() を使うこと
   * (bdboard-5lnh)。
   */
  listProjectsChunked?(): Promise<readonly CachedProject[]>;
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
