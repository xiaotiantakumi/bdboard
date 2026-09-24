import { ApiError } from '../../api';
import {
  CHAT_BUSY_HELP,
  chatAgentErrorMessage,
  writeAccessErrorMessage,
} from '../../writeAccessMessage';

export interface ChatSendErrorDescription {
  text: string;
  clearSession: boolean;
}

// bdboard-sso1.83 第4段: applyChatError(現 chat/useChatSendCommits.ts の commitFailure)の前半(エラー種別 → 文言/clearSession
// の判定)を移動しただけの純関数。分岐の順番・条件・文言は一切変えていない。
// 壊しやすい点: writeAccessErrorMessage を最初に判定すること、409 は
// writeAccessMessage.ts の CHAT_BUSY_HELP と共有すること(bdboard-yzn、文言の
// fork を防ぐ)。
export function describeChatSendError(error: unknown): ChatSendErrorDescription {
  const accessMessage = writeAccessErrorMessage(error);
  if (accessMessage !== null) {
    return { text: accessMessage, clearSession: false };
  }
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return { text: 'チャットを利用する権限がありません。', clearSession: false };
    }
    if (error.status === 409) {
      // bdboard-yzn: writeAccessMessage.ts の CHAT_BUSY_HELP と共有し、文言の fork を防ぐ。
      return { text: CHAT_BUSY_HELP, clearSession: false };
    }
    if (error.status === 400 && error.errorMessage === 'unknown chat session') {
      return {
        text: '会話の続きが失われました。もう一度送信してください。',
        clearSession: true,
      };
    }
    if (error.status === 400 && error.errorMessage === 'chat agent mismatch') {
      return {
        text: 'エージェントが切り替わったため、会話をやり直します。もう一度送信してください。',
        clearSession: true,
      };
    }
    if (
      error.status === 400 &&
      error.errorMessage === 'chat agent does not support image attachments'
    ) {
      return {
        text: 'このエージェントは画像入力に対応していません。画像対応エージェントへ切り替えるか、画像を削除してください。',
        clearSession: false,
      };
    }
    if (error.status === 404) {
      return { text: 'プロジェクトが見つかりません。', clearSession: false };
    }
    if (error.status === 502 && error.code === 'agent-workspace-untrusted') {
      // bdboard-l1t.5 Opus 再レビュー DF1: サーバー側は agent-workspace-untrusted
      // (chat-agent.ts) を返しているのに、ここで拾わないと汎用の
      // error.errorMessage ('chat failed') しか出ず利用者に理由が伝わらない。
      return {
        text: 'このプロジェクト(ワークスペース)を cursor-agent に信頼させる必要があります。bdboard の外で一度 cursor-agent を対話実行し、ワークスペース信頼プロンプトに答えてから、もう一度送信してください。',
        clearSession: false,
      };
    }
    if (error.status === 502 && error.code === 'agent-headless-denied') {
      // bdboard-l1t.6 Opus レビュー SF1 (l1t.5 DF1 と同型): agy の headless モードが
      // ツール呼び出しを自動拒否して空応答になったケース。汎用文言では利用者に
      // 「運用者側の許可設定が要る」ことが伝わらないため、code をマップして案内する。
      return {
        text: 'エージェントの headless モードがツール呼び出しを自動拒否したため、応答を得られませんでした。bdboard の外で agy 側の設定 (~/.gemini/antigravity-cli/settings.json) の permissions.allow に bd コマンドの許可ルール(例: "command(bd)")を追加してから、もう一度送信してください。',
        clearSession: false,
      };
    }
    const agentMessage = chatAgentErrorMessage(error);
    return {
      text: agentMessage ?? error.errorMessage ?? error.message,
      clearSession: false,
    };
  }
  if (error instanceof Error) {
    return { text: error.message, clearSession: false };
  }
  return { text: '送信に失敗しました', clearSession: false };
}
