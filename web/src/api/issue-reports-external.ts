import { ApiError, fetchJson } from './http';

/** サーバーの src/interface/http/external-issue-dto.ts と対 (web から src は import できないので二重定義)。 */
export interface ExternalTextChecks {
  readonly invisibleChars: { readonly total: number; readonly kinds: readonly { readonly codePoint: string; readonly name: string; readonly group: string; readonly count: number; readonly positions: readonly number[] }[] };
  readonly htmlComments: { readonly count: number; readonly unclosed: boolean; readonly totalChars: number; readonly spans: readonly { readonly start: number; readonly end: number; readonly length: number; readonly closed: boolean }[] };
  readonly longEncodedStrings: { readonly count: number; readonly longest: number; readonly spans: readonly { readonly start: number; readonly length: number }[] };
  readonly links: { readonly total: number; readonly markdownLinks: number; readonly autolinks: number; readonly referenceDefinitions: number; readonly rawUrls: number };
}
export interface ExternalMachineChecks { readonly title: ExternalTextChecks; readonly body: ExternalTextChecks }
export interface ExternalIssueDto {
  readonly number: number; readonly title: string; readonly body: string; readonly author: string | null; readonly authorAssociation: string | null;
  readonly url: string; readonly updatedAt: string; readonly titleTruncated: boolean; readonly bodyTruncated: boolean; readonly titleLength: number;
  readonly bodyLength: number; readonly checks: ExternalMachineChecks; readonly snapshotAt: string; readonly needsRejudge: boolean; readonly updatedAtChanged: boolean;
}
export interface ExternalIssueListDto {
  readonly enabled: boolean; readonly state: 'idle' | 'ok' | 'error'; readonly fetchedAt: string | null;
  readonly error: { readonly kind: string; readonly detail: string } | null; readonly truncated: boolean; readonly skippedLines: number;
  readonly issues: readonly ExternalIssueDto[];
}
export const EXTERNAL_ISSUES_API_PATH = '/api/issue-reports/external';
export const EXTERNAL_ISSUES_REFRESH_API_PATH = '/api/issue-reports/external/refresh';
export function fetchExternalIssues(): Promise<ExternalIssueListDto> { return fetchJson(EXTERNAL_ISSUES_API_PATH); }
export function refreshExternalIssues(): Promise<ExternalIssueListDto> {
  return fetchJson(EXTERNAL_ISSUES_REFRESH_API_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
}
export function refreshWaitSeconds(error: unknown): number | undefined {
  if (!(error instanceof ApiError) || error.status !== 429 || typeof error.body !== 'string') return undefined;
  try {
    const value = (JSON.parse(error.body) as { retryAfterSeconds?: unknown }).retryAfterSeconds;
    return Number.isInteger(value) && typeof value === 'number' && value > 0 ? value : undefined;
  } catch { return undefined; }
}
