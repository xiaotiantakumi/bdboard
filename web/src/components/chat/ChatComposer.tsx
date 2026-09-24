import type { ChangeEvent, ClipboardEvent, FormEvent, KeyboardEvent, RefObject } from 'react';
import { ChatInputActions, type ChatInputActionsProps } from './ChatInputActions';
import { ChatInputNotices, type ChatInputNoticesProps } from './ChatInputNotices';
import { ChatQuickCommands, type ChatQuickCommandsProps } from './ChatQuickCommands';

/**
 * チャット入力フォーム(クイックコマンド行・通知群・textarea・アクション行・
 * ヒント2行)の presentational コンポーネント。
 *
 * bdboard-sso1.83 第7段: ChatPanel.tsx の `<form>` ブロックを move-only で
 * 抽出した。状態(currentInput 等)とハンドラ(setInput/handleSubmit/
 * handleImagePaste/handleComposedEnterSubmit 等)は ChatPanel 側に残り、
 * このコンポーネントは props 経由で受け取って配線するだけで、自身の
 * state・effect は一切持たない。textarea の ref(inputRef)は
 * ChatPanel の useRef と同一のものをそのまま渡す(新しい ref を作らない
 * — quick command のキャレット制御・ticket 起動時のプリフィル・送信後の
 * フォーカス復帰がこの同一性に依存している)。
 */
export interface ChatComposerProps {
  formRef: RefObject<HTMLFormElement | null>;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  disabled: boolean;
  onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  hasAttachments: boolean;
  quickCommands: ChatQuickCommandsProps;
  notices: ChatInputNoticesProps;
  actions: ChatInputActionsProps;
}

export function ChatComposer({
  formRef,
  inputRef,
  value,
  disabled,
  onChange,
  onPaste,
  onKeyDown,
  onSubmit,
  hasAttachments,
  quickCommands,
  notices,
  actions,
}: ChatComposerProps) {
  return (
    <form
      ref={formRef}
      className={`chat-input-form${hasAttachments ? ' has-attachments' : ''}`}
      onSubmit={onSubmit}
    >
      <ChatQuickCommands {...quickCommands} />
      {/* 「バナーが1つでもあるか」の条件式をここに書くと、将来バナーを足した人がその条件式の
          更新を忘れた瞬間に空の div が gap を生む。`:empty` なら描画条件の集合を二重管理しない。
          JSX は改行だけの空白テキストノードを出力しないので、5つとも false のとき要素は本当に空になり
          `:empty` が成立する。 */}
      {/* bdboard-3tw.166: 配信停止後の回収中インジケータを入力欄付近にも出す。
          メッセージログ上部の同種インジケータ (role="status" 付きの
          「返信をバックグラウンドで処理中…」、ログの aria-live="polite" 領域内)
          と条件は同じだが、テキストは変えてある — 同一文言を2箇所に出すと
          screen.findByText 等の単一マッチ前提のテストで区別できなくなるため。
          role="status" は付けない (Opus レビュー指摘): 付けると同じ状態変化を
          スクリーンリーダーが2回連続で読み上げることになる。ここは見た目上の
          補助表示として置くだけで、状態変化の告知そのものはログ側の1箇所に
          任せる。ログをスクロールしている/入力欄だけ見ている利用者にも視覚的に
          処理継続中であることが伝わるようにする。
          bdboard-v3ag Opus レビュー指摘 (W4): 条件を backgroundTurnStatus (poll
          の1レスポンス単位でしか更新されない) から、送信ボタンの disabled と
          全く同じ式 hasUnresolvedProjectRecovery に揃える。backgroundTurnStatus
          だけに頼ると、ポーリングの谷間や B1 の「無関係な failed で足止め」
          「バックオフ尽き」のような区間でボタンだけ disabled のままバナーが
          消え、利用者に理由が伝わらない窓ができていた。 */}
      <ChatInputNotices {...notices} />
      <textarea
        ref={inputRef}
        className="chat-input"
        rows={3}
        placeholder="例: in_progress のまま止まっているチケットを教えて"
        aria-label="メッセージ"
        maxLength={4000}
        value={value}
        disabled={disabled}
        onChange={onChange}
        onPaste={onPaste}
        onKeyDown={onKeyDown}
      />
      <ChatInputActions {...actions} />
      <span className="chat-input-hint">
        ⌘/Ctrl + Enter で送信 · 画像は PNG/JPEG/WebP を4枚まで（貼り付け可）
      </span>
      <span className="chat-image-privacy-hint">
        画像はこの画面のメモリ上だけに保持され、履歴 API / localStorage には保存されません。
      </span>
    </form>
  );
}
