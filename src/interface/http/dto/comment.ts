// bdboard-sso1.12: dto.ts のモジュール分割。チケットコメントの DTO。
// comment-routes.ts が参照する (barrel 経由)。
import type { IssueComment } from '../../../domain/issue-comment.js';

export interface CommentDto {
  id: string;
  issueId: string;
  author: string;
  text: string;
  createdAt: string;
}

export function toCommentDto(comment: IssueComment): CommentDto {
  return {
    id: comment.id,
    issueId: comment.issueId,
    author: comment.author,
    text: comment.text,
    createdAt: comment.createdAt.toISOString(),
  };
}
