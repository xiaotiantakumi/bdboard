import type { ExternalIssueList } from '../../application/issue-report/external-issue-list.js';
import type { MachineCheckResult } from '../../domain/external-issue-checks.js';

export interface ExternalIssueDto {
  number: number;
  title: string;
  body: string;
  author: string | null;
  authorAssociation: string | null;
  url: string;
  updatedAt: string;
  titleTruncated: boolean;
  bodyTruncated: boolean;
  titleLength: number;
  bodyLength: number;
  checks: MachineCheckResult;
  snapshotAt: string;
  needsRejudge: boolean;
  updatedAtChanged: boolean;
}

export interface ExternalIssueListDto {
  enabled: boolean;
  state: 'idle' | 'ok' | 'error';
  fetchedAt: string | null;
  error: { kind: string; detail: string } | null;
  truncated: boolean;
  skippedLines: number;
  issues: ExternalIssueDto[];
}

export function toExternalIssueListDto(list: ExternalIssueList): ExternalIssueListDto {
  return {
    enabled: true,
    state: list.state,
    fetchedAt: list.fetchedAt,
    error: list.error,
    truncated: list.truncated,
    skippedLines: list.skippedLines,
    issues: list.issues.map((entry) => ({
      number: entry.number,
      title: entry.title,
      body: entry.body,
      author: entry.author,
      authorAssociation: entry.authorAssociation,
      url: entry.url,
      updatedAt: entry.updatedAt,
      titleTruncated: entry.titleTruncated,
      bodyTruncated: entry.bodyTruncated,
      titleLength: entry.titleLength,
      bodyLength: entry.bodyLength,
      checks: entry.checks,
      snapshotAt: entry.snapshot.snapshotAt,
      needsRejudge: entry.snapshot.needsRejudge,
      updatedAtChanged: entry.snapshot.updatedAtChanged,
    })),
  };
}

export const DISABLED_EXTERNAL_ISSUE_LIST_DTO: ExternalIssueListDto = {
  enabled: false,
  state: 'idle',
  fetchedAt: null,
  error: null,
  truncated: false,
  skippedLines: 0,
  issues: [],
};
