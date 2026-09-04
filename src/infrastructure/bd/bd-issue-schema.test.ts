import { describe, expect, it } from 'vitest';
import { bdIssueSchema } from './bd-issue-schema.js';

function minimalIssue() {
  return {
    id: 'proj-abc',
    title: 'Test issue',
    status: 'open' as const,
    priority: 2,
    issue_type: 'task',
    owner: 'owner@example.com',
    created_at: '2026-08-14T08:00:00Z',
    created_by: 'Creator',
    updated_at: '2026-08-14T09:00:00Z',
    dependency_count: 0,
    dependent_count: 0,
    comment_count: 0,
  };
}

describe('bdIssueSchema', () => {
  it('accepts an issue with only required keys', () => {
    const result = bdIssueSchema.safeParse(minimalIssue());
    expect(result.success).toBe(true);
  });

  // bdboard-mwd: bd omits both on the `bd merge-slot create` path.
  it('accepts an issue with neither owner nor created_by', () => {
    const { owner: _owner, created_by: _createdBy, ...withoutOwner } = minimalIssue();

    const result = bdIssueSchema.safeParse(withoutOwner);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.owner).toBeUndefined();
      expect(result.data.created_by).toBeUndefined();
    }
  });

  it('keeps labels when present', () => {
    const result = bdIssueSchema.safeParse({ ...minimalIssue(), labels: ['gt:slot'] });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.labels).toEqual(['gt:slot']);
    }
  });

  it('strips unknown keys without error', () => {
    const result = bdIssueSchema.safeParse({
      ...minimalIssue(),
      future_field: 'keep-me-out',
      another_unknown: 42,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('future_field');
      expect(result.data).not.toHaveProperty('another_unknown');
    }
  });

  it('rejects dependencies missing type', () => {
    const result = bdIssueSchema.safeParse({
      ...minimalIssue(),
      dependencies: [
        {
          issue_id: 'proj-abc',
          depends_on_id: 'proj-xyz',
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  // bd は `bd config set status.custom` で任意の status を足せるので、未知の値も通す。
  // ここで弾くとカスタム status を使うプロジェクトのチケットが丸ごと消えてしまう。
  it('accepts unknown (custom) status values', () => {
    const result = bdIssueSchema.safeParse({
      ...minimalIssue(),
      status: 'archived',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('archived');
    }
  });

  it('rejects empty status', () => {
    expect(bdIssueSchema.safeParse({ ...minimalIssue(), status: '' }).success).toBe(false);
  });

  // この不変条件が hygiene に missing_priority チェックが存在しない根拠 (bdboard-2czx)。
  // ここを緩めるなら hygiene 側の再検討が要る。
  it('constrains priority to integers 0-4', () => {
    const { priority: _priority, ...withoutPriority } = minimalIssue();

    expect(bdIssueSchema.safeParse(withoutPriority).success).toBe(false);
    expect(bdIssueSchema.safeParse({ ...minimalIssue(), priority: 5 }).success).toBe(false);
    expect(bdIssueSchema.safeParse({ ...minimalIssue(), priority: -1 }).success).toBe(false);
    expect(bdIssueSchema.safeParse({ ...minimalIssue(), priority: 1.5 }).success).toBe(false);
    expect(bdIssueSchema.safeParse({ ...minimalIssue(), priority: 0 }).success).toBe(true);
    expect(bdIssueSchema.safeParse({ ...minimalIssue(), priority: 4 }).success).toBe(true);
  });

  it('accepts arbitrary issue_type strings', () => {
    const result = bdIssueSchema.safeParse({
      ...minimalIssue(),
      issue_type: 'custom-type-not-in-real-data',
    });

    expect(result.success).toBe(true);
  });
});
