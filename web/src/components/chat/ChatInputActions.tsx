import type { ChangeEvent, RefObject } from 'react';

/**
 * チャット入力欄のアクション行(画像添付ボタン + 隠しファイル入力 + 送信ボタン)。
 *
 * bdboard-sso1.2 PR-C: ChatPanel.tsx から状態を持たない表示部分を抜き出す
 * 段階的分割の一環。`fileInputRef` は ChatPanel.tsx の useRef で作られた
 * 同一の RefObject をそのまま渡している(新しい ref を作らない — 同一性を
 * 崩すと `fileInputRef.current?.click()` の対象がずれる)。disabled 判定式・
 * aria-describedby の組み立ては元の JSX のロジックをそのまま移しただけで、
 * 状態・副作用は一切持たない。
 */
export interface ChatInputActionsProps {
  fileInputRef: RefObject<HTMLInputElement | null>;
  isSending: boolean;
  chatUnsupported: boolean;
  onImageFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  submitDisabled: boolean;
  ariaDescribedBy: string | undefined;
}

export function ChatInputActions({
  fileInputRef,
  isSending,
  chatUnsupported,
  onImageFileChange,
  submitDisabled,
  ariaDescribedBy,
}: ChatInputActionsProps) {
  return (
    <div className="chat-input-actions">
      <button
        type="button"
        className="chat-attach-button"
        aria-label="画像を添付"
        disabled={isSending || chatUnsupported}
        onClick={() => fileInputRef.current?.click()}
      >
        📎
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        hidden
        onChange={onImageFileChange}
      />
      <button type="submit" className="btn" disabled={submitDisabled} aria-describedby={ariaDescribedBy}>
        送信
      </button>
    </div>
  );
}
