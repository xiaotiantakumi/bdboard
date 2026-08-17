import type { AgentSession } from '../../domain/session.js';
import type { TranscriptTailMessage } from '../transcript/parse-transcript-messages.js';

export interface SessionTailReader {
  /** セッションのトランスクリプトファイルが見つからなければ undefined */
  readTail(
    session: AgentSession,
    limit: number,
  ): Promise<readonly TranscriptTailMessage[] | undefined>;
}
