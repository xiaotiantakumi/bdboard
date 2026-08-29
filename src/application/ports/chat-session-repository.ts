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
  /** 手動リネームされたカスタムタイトル。未設定なら省略。 */
  readonly title?: string;
  readonly pinned?: boolean;
}

export interface ChatSessionListRecord {
  readonly sessionId: string;
  readonly agentId: string;
  readonly lastUsedAt: Date;
  /** カスタムタイトル。未設定なら null。 */
  readonly title: string | null;
  readonly pinned: boolean;
}

export interface ChatSessionRepository {
  /**
   * projectId のもとで sessionId を記憶する。
   * 既知のセッションIDへの remember は agentId の書き換えのみ禁止
   * (発行時のエージェントを後から変えない)。最終使用時刻相当の内部状態は
   * 実装によって更新してよい。
   */
  remember(projectId: string, sessionId: string, agentId: string): void;

  /**
   * 既知セッションの直近使用モデルを更新する。remember と異なり、既存セッションでも
   * 常に上書きする(ターンごとに実際に使われたモデルが変わりうるため — agentId は
   * 発行時から不変だが model は可変)。セッションが未知なら no-op。
   */
  updateModel(projectId: string, sessionId: string, model: string): void;

  /**
   * 既知セッションのカスタムタイトルを更新する。title に null を渡すとカスタム
   * タイトルをクリアして自動タイトルに戻す。セッションが未知なら no-op。
   */
  rename(projectId: string, sessionId: string, title: string | null): void;

  /**
   * 既知セッションのピン留め状態を更新する。セッションが未知なら no-op。
   */
  setPinned(projectId: string, sessionId: string, pinned: boolean): void;

  /** projectId のもとで sessionId の記録を返す。未知なら undefined。 */
  lookup(projectId: string, sessionId: string): ChatSessionRecord | undefined;

  listByProject(projectId: string): readonly ChatSessionListRecord[];

  forget(projectId: string, sessionId: string): void;
}
