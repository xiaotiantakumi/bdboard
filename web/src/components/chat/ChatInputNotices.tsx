import { CHAT_AGENT_UNAVAILABLE_WARNING } from '../../writeAccessMessage';
import { ChatAttachmentPreview } from './ChatAttachmentPreview';
import type { ChatAttachment } from './attachments';

/**
 * チャット入力欄まわりの通知群(回収中インジケータ・添付プレビュー・
 * 添付エラー・非対応警告・エージェント利用不可バナー)。
 *
 * bdboard-sso1.2 PR-D: ChatPanel.tsx から状態を持たない表示部分を抜き出す
 * 段階的分割の一環。5つのバナーのうち1つでも表示されれば非空になる
 * `.chat-input-notices:empty` の CSS 前提(元コードのコメント参照)を
 * 変えないよう、ラッパー div ごとそのまま移している。状態・副作用は
 * 一切持たない。
 */
export interface ChatInputNoticesProps {
  hasUnresolvedProjectRecovery: boolean;
  isSending: boolean;
  attachments: readonly ChatAttachment[];
  onRemoveAttachment: (attachmentId: string) => void;
  attachmentError: string | null;
  hasUnsupportedAttachments: boolean;
  selectedAgentUnavailable: boolean;
  agentUnavailableHintId: string | null;
}

export function ChatInputNotices({
  hasUnresolvedProjectRecovery,
  isSending,
  attachments,
  onRemoveAttachment,
  attachmentError,
  hasUnsupportedAttachments,
  selectedAgentUnavailable,
  agentUnavailableHintId,
}: ChatInputNoticesProps) {
  return (
    <div className="chat-input-notices">
      {!isSending && hasUnresolvedProjectRecovery && (
        <p className="chat-pending chat-input-recovery-status">バックグラウンドで応答を処理中です…</p>
      )}
      <ChatAttachmentPreview attachments={attachments} isSending={isSending} onRemove={onRemoveAttachment} />
      {attachmentError !== null && (
        <p className="chat-attachment-error" role="alert">
          {attachmentError}
        </p>
      )}
      {hasUnsupportedAttachments && (
        <p className="chat-attachment-unsupported" role="alert">
          このエージェントは画像入力に対応していません。画像対応エージェントへ切り替えるか、画像を削除してください。
        </p>
      )}
      {selectedAgentUnavailable && (
        <p id={agentUnavailableHintId ?? undefined} className="chat-agent-unavailable-banner" role="alert">
          {CHAT_AGENT_UNAVAILABLE_WARNING}
        </p>
      )}
    </div>
  );
}
