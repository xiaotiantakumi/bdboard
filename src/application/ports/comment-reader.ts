import type { IssueComment } from '../../domain/issue-comment.js';
import type { TicketId } from '../../domain/ticket-id.js';

export interface CommentReader {
  /** Fetch comments for an issue. Throws BdError when bd execution fails. */
  listComments(
    rootPath: string,
    issueId: TicketId,
  ): Promise<readonly IssueComment[]>;
}
