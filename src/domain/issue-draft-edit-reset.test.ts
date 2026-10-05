import { describe, expect, it } from 'vitest';
import { createDraftFromReport } from './issue-draft-build.js';
import { applyDraftEdit, withRescannedLeaks } from './issue-draft-edit.js';
import type { IssueDraft } from './issue-draft.js';
import type { ReceiveDraftInput } from './issue-draft-input.js';

const input: ReceiveDraftInput = {
  kind: 'B', source: 'hook.sh', envInfo: { bdboardVersion: '1.0', os: 'darwin', nodeVersion: 'v22' },
  project: { name: 'proj-name', path: '/work/proj-name' },
};
function draft(): IssueDraft {
  return createDraftFromReport(input, { id: '1758812345678-a1b2c3d4e5f6a7b8', fingerprint: 'B:hook.sh:abcd', nowIso: '2026-10-04T12:00:00.000Z' });
}

describe('applyDraftEdit automatic text reset', () => {
  it('resets either field and treats whitespace as empty', () => {
    const before = { ...draft(), title: 'custom', body: 'custom body', titleEditedByUser: true, bodyEditedByUser: true };
    const body = applyDraftEdit(before, { body: '' }).draft;
    expect(body.body).toContain('種類:');
    expect(body.bodyEditedByUser).toBe(false);
    expect(body.title).toBe('custom');
    expect(body.titleEditedByUser).toBe(true);
    const title = applyDraftEdit(before, { title: '  \n ' }).draft;
    expect(title.title).toBe(draft().title);
    expect(title.titleEditedByUser).toBe(false);
  });

  it('removes leak fields when both edits are reset and rescans only the remaining edited field', () => {
    const both = withRescannedLeaks({ ...draft(), title: 'proj-name', body: 'proj-name', titleEditedByUser: true, bodyEditedByUser: true });
    const reset = applyDraftEdit(both, { title: '' }).draft;
    expect(reset.titleEditedByUser).toBe(false);
    expect(reset.bodyEditedByUser).toBe(true);
    expect(reset.suspectedLeaks?.every((leak) => leak.field === 'body')).toBe(true);
    const clean = applyDraftEdit(reset, { body: '' }).draft;
    expect(clean).not.toHaveProperty('suspectedLeaks');
    expect(clean).not.toHaveProperty('suspectedLeaksOmitted');
  });

  it('uses current count, time, and version in regenerated text', () => {
    const before = { ...draft(), occurrenceCount: 7, lastOccurredAt: '2026-10-05T00:00:00.000Z', localOnly: { ...draft().localOnly, envInfo: { bdboardVersion: '2.0', os: 'linux', nodeVersion: 'v23' } } };
    const result = applyDraftEdit(before, { body: '' }).draft;
    expect(result.body).toContain('発生回数: 7');
    expect(result.body).toContain('2026-10-05T00:00:00.000Z');
    expect(result.body).toContain('bdboard: 2.0');
  });
});
