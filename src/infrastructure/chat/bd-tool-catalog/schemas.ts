// bd-tool-catalog.ts (bdboard-sso1.18) の分割で切り出した、各ツールの入力を検証する zod
// スキーマと、その組み立てに使う定数・パースヘルパー。read-tools.ts / lifecycle-tools.ts /
// content-tools.ts / schedule-label-tools.ts / create-dep-tools.ts の5モジュールがここへ
// 依存する一方向の関係にし、循環 import を避けている。挙動・型は分割前と同一 (移動のみ、
// module-private だった宣言に export を付けただけ)。
import { z } from 'zod';
import { isSafeCliArgument, isValidBdTicketId } from '../../../domain/chat.js';

export const BD_STATUSES = ['open', 'in_progress', 'blocked', 'deferred', 'closed'] as const;
export const BD_CREATE_TYPES = ['task', 'bug', 'feature', 'epic'] as const;
export type BdStatus = (typeof BD_STATUSES)[number];

export const statusSchema = z.enum(BD_STATUSES);

export const ticketIdSchema = z.string().refine(isValidBdTicketId, {
  message: 'invalid ticket id',
});

export const freeTextSchema = z
  .string()
  .min(1, 'text must not be empty')
  .max(2000, 'text too long');

export const optionalReasonSchema = z.string().max(2000, 'reason too long').optional();

export function clampInt(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.trunc(value), min), max);
}

export function parseStatusList(value: string): BdStatus[] | null {
  const parts = value.split(',').map((part) => part.trim()).filter((part) => part.length > 0);
  if (parts.length === 0) {
    return null;
  }

  const statuses: BdStatus[] = [];
  for (const part of parts) {
    const parsed = statusSchema.safeParse(part);
    if (!parsed.success) {
      return null;
    }
    statuses.push(parsed.data);
  }

  return statuses;
}

export const bdListSchema = z
  .object({
    status: z.string().optional(),
    limit: z.number().optional(),
  })
  .strict();

export const bdReadySchema = z
  .object({
    limit: z.number().optional(),
  })
  .strict();

export const bdBlockedSchema = z.object({}).strict();

export const bdShowSchema = z
  .object({
    id: ticketIdSchema,
  })
  .strict();

export const bdUpdateStatusSchema = z
  .object({
    id: ticketIdSchema,
    status: statusSchema,
  })
  .strict();

export const bdClaimSchema = z
  .object({
    id: ticketIdSchema,
  })
  .strict();

export const bdCloseSchema = z
  .object({
    id: ticketIdSchema,
    reason: optionalReasonSchema,
  })
  .strict();

export const bdCommentSchema = z
  .object({
    id: ticketIdSchema,
    text: freeTextSchema,
  })
  .strict();

export const untilDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'invalid date format');

export const bdDeferSchema = z
  .object({
    id: ticketIdSchema,
    untilDate: untilDateSchema,
  })
  .strict();

export const bdPrioritySchema = z
  .object({
    id: ticketIdSchema,
    priority: z.number().int().min(0).max(4),
  })
  .strict();

export const bdCreateTitleSchema = z
  .string()
  .min(1, 'title must not be empty')
  .max(200, 'title too long')
  .refine(isSafeCliArgument, { message: 'unsafe title' });

export const bdUpdateTitleSchema = z
  .object({
    id: ticketIdSchema,
    title: bdCreateTitleSchema,
  })
  .strict();

export const bdLongTextSchema = z
  .string()
  .min(1, 'text must not be empty')
  .max(4000, 'text too long');

export const bdUpdateDescriptionSchema = z
  .object({
    id: ticketIdSchema,
    description: bdLongTextSchema,
  })
  .strict();

export const bdAppendNotesSchema = z
  .object({
    id: ticketIdSchema,
    notes: bdLongTextSchema,
  })
  .strict();

export const bdCreateTypeSchema = z.enum(BD_CREATE_TYPES);

export const bdCreateSchema = z
  .object({
    title: bdCreateTitleSchema,
    description: z.string().max(4000, 'description too long').optional(),
    type: bdCreateTypeSchema.optional(),
    priority: z.number().int().min(0).max(4).optional(),
    parent: ticketIdSchema.optional(),
  })
  .strict();

export const bdSearchQuerySchema = z
  .string()
  .min(1, 'query must not be empty')
  .max(200, 'query too long')
  .refine(isSafeCliArgument, { message: 'unsafe query' });

export const bdSearchSchema = z.object({ query: bdSearchQuerySchema }).strict();

export const bdDepSchema = z
  .object({
    id: ticketIdSchema,
    dependsOnId: ticketIdSchema,
  })
  .strict();

export const labelSchema = z
  .string()
  .min(1, 'label must not be empty')
  .max(200, 'label too long')
  .refine(isSafeCliArgument, { message: 'unsafe label' });

export const bdLabelSchema = z
  .object({
    id: ticketIdSchema,
    label: labelSchema,
  })
  .strict();
