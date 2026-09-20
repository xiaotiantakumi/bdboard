// bdboard-sso1.5 (PR-B): TicketDetailPanel.tsx の「コメント」表示ブロックを
// 移動しただけのコンポーネント。state・mutation は親(TicketDetailPanel)に残し、
// 値とハンドラを props で受け取る表示専用コンポーネント。JSX・className・
// aria属性・文言・DOM構造は移動前から変えていない。
import type { RefObject } from 'react';
import type { CommentDto } from '../../api';
import { formatAbsoluteTime } from '../../formatAbsoluteTime';
import { describeWriteError } from '../../writeAccessMessage';
import { MarkdownContent } from '../MarkdownContent';

export interface TicketCommentsSectionMutation {
  isPending: boolean;
  error: unknown;
  mutate: () => void;
}

export interface TicketCommentsSectionProps {
  enabled: boolean;
  loading: boolean;
  error: Error | null;
  comments: CommentDto[] | undefined;
  isTicketOnBoard: (ticketId: string) => boolean;
  onOpenTicket: (ticketId: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  commentText: string;
  onCommentTextChange: (value: string) => void;
  canSubmit: boolean;
  mutation: TicketCommentsSectionMutation;
}

export function TicketCommentsSection({
  enabled,
  loading,
  error,
  comments,
  isTicketOnBoard,
  onOpenTicket,
  textareaRef,
  commentText,
  onCommentTextChange,
  canSubmit,
  mutation,
}: TicketCommentsSectionProps) {
  return (
    <div className="detail-section">
      <h3>コメント</h3>
      {!enabled && <p className="detail-help">コメントはありません</p>}
      {enabled && loading && <p className="loading">読み込み中…</p>}
      {enabled && error !== null && (
        <p className="error-message">
          {error instanceof Error
            ? error.message
            : 'コメントの読み込みに失敗しました'}
        </p>
      )}
      {enabled &&
        !loading &&
        error === null &&
        comments !== undefined &&
        comments.length === 0 && (
          <p className="detail-help">コメントはありません</p>
        )}
      {enabled && comments !== undefined && comments.length > 0 && (
        <ul className="comment-list">
          {comments.map((comment) => (
            <li key={comment.id} className="comment-item">
              <div className="comment-meta">
                <span className="comment-author">{comment.author}</span>
                <time className="comment-date" dateTime={comment.createdAt}>
                  {formatAbsoluteTime(comment.createdAt)}
                </time>
              </div>
              <MarkdownContent
                text={comment.text}
                isTicketOnBoard={isTicketOnBoard}
                onOpenTicket={onOpenTicket}
                className="markdown-detail"
              />
            </li>
          ))}
        </ul>
      )}
      <form
        className="comment-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSubmit || mutation.isPending) {
            return;
          }
          mutation.mutate();
        }}
      >
        <label className="comment-form-label" htmlFor="comment-text">
          コメントを追加
        </label>
        <textarea
          ref={textareaRef}
          id="comment-text"
          className="comment-form-input"
          value={commentText}
          onChange={(event) => onCommentTextChange(event.target.value)}
          rows={3}
          maxLength={2000}
          disabled={mutation.isPending}
        />
        <button
          type="submit"
          className="btn comment-form-submit"
          disabled={!canSubmit || mutation.isPending}
        >
          {mutation.isPending ? '送信中…' : 'コメントを投稿'}
        </button>
        {mutation.error !== null && (
          <p className="error-message">
            {describeWriteError(
              mutation.error,
              'コメントの投稿に失敗しました',
            )}
          </p>
        )}
      </form>
    </div>
  );
}
