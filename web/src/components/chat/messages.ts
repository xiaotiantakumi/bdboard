import type { ChatMessageImage } from './attachments';

export type ChatMessage = {
  role: 'user' | 'assistant' | 'error';
  text: string;
  at: number;
  /** このターンで実行できなかった bd ツール呼び出しの名前(bdboard-l1t.4 MF3)。 */
  failedTools?: string[];
  /** ターンは成功したが運用者に知らせるべきエージェント側の警告(bdboard-l1t.6 N-e)。 */
  agentWarnings?: string[];
  /** 画像バイナリは履歴 API に残らないため、このマウント中だけ表示する preview。 */
  images?: ChatMessageImage[];
};
