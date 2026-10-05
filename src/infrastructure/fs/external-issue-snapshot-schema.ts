import { z } from 'zod';
import { isExternalIssueNumber } from '../../domain/external-issue-snapshot-record.js';

/**
 * `<number>.json` を読むときの形の確認 (bdboard-4y8q.9.3)。保存層 (fs-external-issue-snapshot-storage.ts) だけが使う。
 * 形が合わないファイルは「使えない写し」として警告つきで飛ばされ、次の保存で書き直される。
 */

/** ISO 8601 の UTC (末尾が "Z")。`new Date(...)` や `Date.parse` が NaN にならない値だけを通す。 */
const isoTimeSchema = z.string().datetime();
const countSchema = z.number().int().nonnegative();

const invisibleCharKindSchema = z.object({
  codePoint: z.string(),
  name: z.string(),
  group: z.enum(['zero-width', 'bidi-control', 'tag']),
  count: countSchema,
  positions: z.array(countSchema),
});

const textChecksSchema = z.object({
  invisibleChars: z.object({ total: countSchema, kinds: z.array(invisibleCharKindSchema) }),
  htmlComments: z.object({
    count: countSchema,
    unclosed: z.boolean(),
    totalChars: countSchema,
    spans: z.array(z.object({ start: countSchema, end: countSchema, length: countSchema, closed: z.boolean() })),
  }),
  longEncodedStrings: z.object({
    count: countSchema,
    longest: countSchema,
    spans: z.array(z.object({ start: countSchema, length: countSchema })),
  }),
  links: z.object({
    total: countSchema,
    markdownLinks: countSchema,
    autolinks: countSchema,
    referenceDefinitions: countSchema,
    rawUrls: countSchema,
  }),
});

export const externalIssueSnapshotSchema = z.object({
  number: z.number().refine(isExternalIssueNumber),
  title: z.string(),
  body: z.string(),
  titleLength: countSchema,
  bodyLength: countSchema,
  titleTruncated: z.boolean(),
  bodyTruncated: z.boolean(),
  updatedAt: z.string(),
  snapshotAt: isoTimeSchema,
  checks: z.object({ title: textChecksSchema, body: textChecksSchema }),
  needsRejudge: z.boolean(),
  missingSince: isoTimeSchema.nullable(),
});
