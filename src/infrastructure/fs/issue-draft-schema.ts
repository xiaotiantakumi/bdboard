import { z } from 'zod';
import { isDraftId } from '../../domain/issue-draft.js';

/**
 * draft.json を読むときの形の確認 (bdboard-4y8q.1)。保存層 (fs-issue-draft-storage.ts) だけが使う。
 * 形が合わないファイルは「使えない下書き」として飛ばされる。
 */

/**
 * ISO 8601 の時刻 (toISOString の形を含む)。読み込みのときに確かめるのは、"not-a-date" のような値が
 * 通ると、受け取りの索引づくり (hourBucketOf の toISOString) が RangeError で落ち、以後の受け取りが
 * すべて失敗するため。形が合わない下書きは「使えない下書き」として警告つきで飛ばす。
 */
const isoTimeSchema = z.string().datetime();

const envInfoSchema = z.object({
  bdboardVersion: z.string(),
  harnessVersion: z.string().optional(),
  os: z.string(),
  nodeVersion: z.string(),
  bdVersion: z.string().optional(),
  ghVersion: z.string().optional(),
});

const localOnlySchema = z.object({
  symptomRaw: z.string(),
  causeRaw: z.string(),
  preventionRaw: z.string(),
  errorTextRaw: z.string().optional(),
  errorTextHead: z.string().optional(),
  errorTextTail: z.string().optional(),
  errorTextTruncated: z.boolean(),
  agentNoteRaw: z.string().optional(),
  envInfo: envInfoSchema,
  foldedFingerprints: z.array(z.string()).optional(),
});

const occurredProjectSchema = z.object({
  name: z.string(),
  path: z.string(),
  firstSeenAt: isoTimeSchema,
  lastSeenAt: isoTimeSchema,
});

export const draftSchema = z.object({
  id: z.string().refine(isDraftId),
  kind: z.enum(['A', 'B', 'C']),
  fingerprint: z.string().min(1),
  catalogSlug: z.string().optional(),
  source: z.string().optional(),
  title: z.string(),
  body: z.string(),
  titleEditedByUser: z.boolean(),
  bodyEditedByUser: z.boolean(),
  localOnly: localOnlySchema,
  occurredProjects: z.array(occurredProjectSchema),
  occurrenceCount: z.number().int().nonnegative(),
  firstOccurredAt: isoTimeSchema,
  lastOccurredAt: isoTimeSchema,
  status: z.enum(['pending', 'posted', 'dismissed']),
  dismissReason: z.string().optional(),
  issueNumber: z.number().int().optional(),
  issueUrl: z.string().optional(),
  sourceTicketRef: z.string().optional(),
  harnessVersionAtOccurrence: z.string().optional(),
  draftSchemaVersion: z.literal(1),
});
