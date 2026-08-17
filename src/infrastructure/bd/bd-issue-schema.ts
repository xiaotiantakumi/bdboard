import { z } from 'zod';

export const bdDependencySchema = z.object({
  issue_id: z.string(),
  depends_on_id: z.string(),
  type: z.string(),
  created_at: z.string().optional(),
  created_by: z.string().optional(),
  metadata: z.unknown().optional(),
});

export const bdIssueSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string().min(1),
  priority: z.number().int().min(0).max(4),
  issue_type: z.string(),
  // owner/created_by are optional because bd does not stamp them on every code
  // path: `bd merge-slot create` emits a bead with neither. Requiring them made
  // bdboard skip such beads and surface a schema-mismatch warning for a row bd
  // considers perfectly valid (bdboard-mwd). Nothing downstream needs them —
  // Ticket.owner is already `owner?: string` and created_by is unused.
  owner: z.string().optional(),
  created_at: z.string(),
  created_by: z.string().optional(),
  updated_at: z.string(),
  // Needed to recognise bd's own coordination beads; see COORDINATION_LABELS.
  labels: z.array(z.string()).optional(),
  dependency_count: z.number(),
  dependent_count: z.number(),
  comment_count: z.number(),
  description: z.string().optional(),
  started_at: z.string().optional(),
  assignee: z.string().optional(),
  closed_at: z.string().optional(),
  close_reason: z.string().optional(),
  dependencies: z.array(bdDependencySchema).optional(),
  parent: z.string().optional(),
  acceptance_criteria: z.string().optional(),
  notes: z.string().optional(),
  design: z.string().optional(),
  defer_until: z.string().optional(),
});

export type BdIssue = z.infer<typeof bdIssueSchema>;
export type BdDependency = z.infer<typeof bdDependencySchema>;

export const bdListSchema = z.array(bdIssueSchema);

export const bdCommentSchema = z.object({
  id: z.string(),
  issue_id: z.string(),
  author: z.string(),
  text: z.string(),
  created_at: z.string(),
});

export type BdComment = z.infer<typeof bdCommentSchema>;

export const bdCommentListSchema = z.array(bdCommentSchema);

export const bdVersionSchema = z
  .object({
    version: z.string(),
    schema_version: z.number(),
  })
  .passthrough();
