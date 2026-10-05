import type { ExternalIssueDto, ExternalIssueListDto, ExternalTextChecks } from '../api/issue-reports-external';

/** 届いた issue (bdboard-4y8q.9.5) のテスト用データ。何も見つからなかった検査の結果。 */
export const NO_FINDINGS: ExternalTextChecks = {
  invisibleChars: { total: 0, kinds: [] },
  htmlComments: { count: 0, unclosed: false, totalChars: 0, spans: [] },
  longEncodedStrings: { count: 0, longest: 0, spans: [] },
  links: { total: 0, markdownLinks: 0, autolinks: 0, referenceDefinitions: 0, rawUrls: 0 },
};

export function makeExternalIssue(overrides: Partial<ExternalIssueDto> = {}): ExternalIssueDto {
  return {
    number: 17,
    title: 'external example issue',
    body: 'plain body text',
    author: 'example-user',
    authorAssociation: 'NONE',
    url: 'https://github.com/example/repo/issues/17',
    updatedAt: '2026-10-01T00:00:00.000Z',
    titleTruncated: false,
    bodyTruncated: false,
    titleLength: 22,
    bodyLength: 15,
    checks: { title: NO_FINDINGS, body: NO_FINDINGS },
    snapshotAt: '2026-10-01T00:00:00.000Z',
    needsRejudge: false,
    updatedAtChanged: false,
    ...overrides,
  };
}

export function makeExternalList(overrides: Partial<ExternalIssueListDto> = {}): ExternalIssueListDto {
  return {
    enabled: true,
    state: 'ok',
    fetchedAt: '2026-10-01T00:00:00.000Z',
    error: null,
    truncated: false,
    skippedLines: 0,
    issues: [makeExternalIssue()],
    ...overrides,
  };
}
