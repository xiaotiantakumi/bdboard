/**
 * ChatSessionStore の remember/lookup 台帳を永続化するためのポート。
 *
 * tryAcquire/release (プロセス内排他ロック) はこのポートの対象外 — あくまで
 * 「このプロジェクトで既知のセッションIDかどうか」の記憶だけを担う。
 */
export interface ChatSessionRecord {
  /** このセッションIDを発行したチャットエージェントの ID。 */
  readonly agentId: string;
  readonly model?: string;
}

export interface ChatSessionListRecord {
  readonly sessionId: string;
  readonly agentId: string;
  readonly lastUsedAt: Date;
}

export interface ChatSessionRepository {
  /**
   * projectId のもとで sessionId を記憶する。
   * 既知のセッションIDへの remember は agentId も含めて no-op
   * (発行時のエージェントを後から書き換えない。最終使用順の再計算もしない)。
   */
  remember(projectId: string, sessionId: string, agentId: string): void;

  /**
   * 既知セッションの直近使用モデルを更新する。remember と異なり、既存セッションでも
   * 常に上書きする(ターンごとに実際に使われたモデルが変わりうるため — agentId は
   * 発行時から不変だが model は可変)。セッションが未知なら no-op。
   */
  updateModel(projectId: string, sessionId: string, model: string): void;

  /** projectId のもとで sessionId の記録を返す。未知なら undefined。 */
  lookup(projectId: string, sessionId: string): ChatSessionRecord | undefined;

  listByProject(projectId: string): readonly ChatSessionListRecord[];

  forget(projectId: string, sessionId: string): void;
}
