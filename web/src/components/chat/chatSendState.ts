// bdboard-sso1.83 第13a段: ChatPanel.tsx の送信・ストリーム回収状態を
// useReducer にまとめる。各 action は旧 setter / helper の呼び出し形を保ち、
// submitChatMessage 側の state 更新呼び出しはそのまま利用できる。
export interface ChatSendState {
  isSending: boolean;
  streamingReply: Record<string, string>;
  turnRecoveryGeneration: number;
  unresolvedSends: Record<string, true>;
}

// bdboard-1qoe: 会話キーでスコープした Record にする (単一スロットだった頃は、
// 無関係な会話/プロジェクトへの書き込み (送信開始時の初期化・完了時のクリア) が
// 無条件にスロット全体を上書きし、別の会話がバックグラウンドで回収待ちの間
// 表示し続けているはずの部分テキストを巻き添えで消してしまっていた。詳細は
// 元チケット (bdboard-v3ag PR #492 の Opus レビュー worth-considering W2) 参照。
export const initialChatSendState: ChatSendState = {
  isSending: false,
  streamingReply: {},
  turnRecoveryGeneration: 0,
  unresolvedSends: {},
};

type Updater<T> = (previous: T) => T;

export type ChatSendAction =
  | { type: 'set-is-sending'; value: boolean }
  | { type: 'replace-streaming-reply'; updater: Updater<Record<string, string>> }
  | { type: 'clear-streaming-reply-for-key'; key: string }
  | { type: 'replace-turn-recovery-generation'; updater: Updater<number> }
  | { type: 'mark-unresolved-send'; sessionId: string }
  | { type: 'clear-unresolved-send'; sessionId: string };

function isSendingSlice(value: boolean, action: ChatSendAction): boolean {
  return action.type === 'set-is-sending' ? action.value : value;
}

function streamingReplySlice(
  value: Record<string, string>,
  action: ChatSendAction,
): Record<string, string> {
  switch (action.type) {
    case 'replace-streaming-reply':
      return action.updater(value);
    case 'clear-streaming-reply-for-key': {
      if (!(action.key in value)) return value;
      const next = { ...value };
      delete next[action.key];
      return next;
    }
    default:
      return value;
  }
}

function turnRecoveryGenerationSlice(value: number, action: ChatSendAction): number {
  return action.type === 'replace-turn-recovery-generation' ? action.updater(value) : value;
}

function unresolvedSendsSlice(
  value: Record<string, true>,
  action: ChatSendAction,
): Record<string, true> {
  switch (action.type) {
    case 'mark-unresolved-send':
      return value[action.sessionId] === true ? value : { ...value, [action.sessionId]: true };
    case 'clear-unresolved-send': {
      if (value[action.sessionId] !== true) return value;
      const next = { ...value };
      delete next[action.sessionId];
      return next;
    }
    default:
      return value;
  }
}

export function chatSendReducer(state: ChatSendState, action: ChatSendAction): ChatSendState {
  const isSending = isSendingSlice(state.isSending, action);
  const streamingReply = streamingReplySlice(state.streamingReply, action);
  const turnRecoveryGeneration = turnRecoveryGenerationSlice(state.turnRecoveryGeneration, action);
  const unresolvedSends = unresolvedSendsSlice(state.unresolvedSends, action);
  if (
    isSending === state.isSending &&
    streamingReply === state.streamingReply &&
    turnRecoveryGeneration === state.turnRecoveryGeneration &&
    unresolvedSends === state.unresolvedSends
  ) {
    return state;
  }
  return { isSending, streamingReply, turnRecoveryGeneration, unresolvedSends };
}
