import type { Project } from '../../domain/project.js';
import type { TranscriptTailMessage } from '../transcript/parse-transcript-messages.js';

export interface DiscoveredChatSession {
  readonly sessionId: string;
  readonly lastActivityAt: Date;
  readonly firstMessagePreview?: string;
  readonly lastMessagePreview?: string;
}

export interface ChatSessionDiscoveryPort {
  listDiscoveredSessions(
    project: Project,
    allProjects: readonly Project[],
  ): Promise<readonly DiscoveredChatSession[]>;
  verifySessionExists(
    project: Project,
    allProjects: readonly Project[],
    sessionId: string,
  ): Promise<boolean>;
  /**
   * adopt 直後にチャット履歴をシードするための、トランスクリプト末尾の会話
   * (bdboard-3tw.104.3 レビュー M1)。
   *
   * なぜ `~/.claude/sessions/*.json`(ライブセッションインデックス)ではなく
   * これが必要か: そちらは直近アクティブな一部のセッションしか持たない
   * (実測: 全体 2102 件のトランスクリプトに対して 10 件程度)。discovery が
   * 対象にする「CLI から直接起動して終了済みのセッション」は、その母集団の
   * 大半を占めるにもかかわらずライブインデックスには載らないため、
   * `GET /api/sessions/:id/tail` 経由でシードするとほぼ確実に 404 になる。
   * discovery は verifySessionExists で既に対象トランスクリプトの中身を
   * 読んでいるので、同じ発見基盤(このポート)がシードも提供する。
   *
   * verifySessionExists と同じ「所有権(cwd)が検証できたセッションだけ返す」
   * 規約に従う。存在しない/検証できない場合は undefined。
   */
  readAdoptSeedMessages(
    project: Project,
    allProjects: readonly Project[],
    sessionId: string,
  ): Promise<readonly TranscriptTailMessage[] | undefined>;
}
