import type { TicketId } from './ticket-id.js';

export interface IssueComment {
  readonly id: string;
  readonly issueId: TicketId;
  readonly author: string;
  readonly text: string;
  readonly createdAt: Date;
}
