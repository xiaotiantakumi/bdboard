import { z } from 'zod';
import { isDraftId } from '../../domain/issue-draft.js';

/**
 * draft.json を読むときの形の確認 (bdboard-4y8q.1)。保存層 (fs-issue-draft-storage.ts) だけが使う。
 * 形が合わないファイルは「使えない下書き」として飛ばされる。
 */

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
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
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
  firstOccurredAt: z.string(),
  lastOccurredAt: z.string(),
  status: z.enum(['pending', 'posted', 'dismissed']),
  dismissReason: z.string().optional(),
  issueNumber: z.number().int().optional(),
  issueUrl: z.string().optional(),
  sourceTicketRef: z.string().optional(),
  harnessVersionAtOccurrence: z.string().optional(),
  draftSchemaVersion: z.literal(1),
});
