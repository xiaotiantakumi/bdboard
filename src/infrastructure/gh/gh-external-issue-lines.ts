import { z } from 'zod';
import type { ExternalIssue } from '../../application/ports/external-issue-source.js';
import { excludePullRequests } from '../../domain/github-issue-link.js';

// gh-cli-external-issue-source.ts の jq が 1 行 1 issue で出す形。
const issueRowSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string(),
  bodyLength: z.number().int().nonnegative(),
  updatedAt: z.string(),
  author: z.string().nullable(),
  authorAssociation: z.string().nullable(),
  pullRequest: z.boolean(),
});

export interface ParsedIssueLines {
  /** PR を除いた issue。 */
  readonly issues: readonly ExternalIssue[];
  /** 空でない行の数 (PR の行・読めない行も数える。ページが満杯かの判定に使う)。 */
  readonly lineCount: number;
  /** 読めずに捨てた行の数。 */
  readonly skippedLines: number;
  /** 空でない行があるのに 1 行も読めなかった (出力の形式が変わった)。 */
  readonly allUnreadable: boolean;
}

/**
 * gh の JSON Lines を 1 行ずつ読む。読めない行は数えて捨てる。PR の行は除く。
 * url は gh の応答ではなく、検査済みの slug と番号から組む。
 */
export function parseExternalIssueLines(output: string, slug: string): ParsedIssueLines {
  const rows: Array<z.infer<typeof issueRowSchema>> = [];
  let lineCount = 0;
  let skippedLines = 0;
  for (const line of output.split(/\r?\n/)) {
    if (line.trim() === '') {
      continue;
    }
    lineCount += 1;
    let candidate: unknown;
    try {
      candidate = JSON.parse(line);
    } catch {
      skippedLines += 1;
      continue;
    }
    const result = issueRowSchema.safeParse(candidate);
    if (result.success) {
      rows.push(result.data);
    } else {
      skippedLines += 1;
    }
  }
  const issues = excludePullRequests(rows).map(
    (row): ExternalIssue => ({
      number: row.number,
      title: row.title,
      body: row.body,
      bodyLength: row.bodyLength,
      updatedAt: row.updatedAt,
      author: row.author,
      authorAssociation: row.authorAssociation,
      url: `https://github.com/${slug}/issues/${row.number}`,
    }),
  );
  return { issues, lineCount, skippedLines, allUnreadable: lineCount > 0 && rows.length === 0 };
}
