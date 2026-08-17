import { z } from 'zod';
import type { InteractionRecord } from '../../domain/interaction.js';

const interactionLineSchema = z.object({
  id: z.string().min(1),
  kind: z.string(),
  created_at: z.string(),
  actor: z.string(),
  issue_id: z.string().min(1),
  extra: z.object({
    field: z.string(),
    old_value: z.string().optional(),
    new_value: z.string().optional(),
    reason: z.string().optional(),
  }),
});

export function parseInteractions(text: string): readonly InteractionRecord[] {
  const records: InteractionRecord[] = [];

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const result = interactionLineSchema.safeParse(parsed);
    if (!result.success) {
      continue;
    }

    const row = result.data;
    if (row.kind !== 'field_change') {
      continue;
    }

    const at = new Date(row.created_at);
    if (Number.isNaN(at.getTime())) {
      continue;
    }

    records.push({
      id: row.id,
      at,
      actor: row.actor,
      ticketId: row.issue_id,
      field: row.extra.field,
      ...(row.extra.old_value !== undefined ? { oldValue: row.extra.old_value } : {}),
      ...(row.extra.new_value !== undefined ? { newValue: row.extra.new_value } : {}),
      ...(row.extra.reason !== undefined ? { reason: row.extra.reason } : {}),
    });
  }

  return records;
}
