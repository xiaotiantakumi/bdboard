import { describe, expect, it } from 'vitest';
import type { IssueDraft } from './issue-draft.js';
import { addOccurrence, createDraftFromReport } from './issue-draft-build.js';
import { ISSUE_DRAFT_MAX_SUSPECTED_LEAKS, applyDraftEdit, scanEditedText } from './issue-draft-edit.js';
import type { ReceiveDraftInput } from './issue-draft-input.js';

/** bdboard-4y8q.3.1: 題名・本文の編集 (置き換え漏れの検出のかけ直し) と、まとめるときの版 (m-6)。 */

const PROJECT = {
  name: 'example-project',
  path: '/Users/example-user/src/example-project',
  firstSeenAt: '2026-10-04T12:00:00.000Z',
  lastSeenAt: '2026-10-04T12:00:00.000Z',
};

function report(overrides: Partial<ReceiveDraftInput> = {}): ReceiveDraftInput {
  return {
    kind: 'B',
    source: 'stop-ticket-gate.sh',
    errorText: 'jq: command not found',
    envInfo: { bdboardVersion: '0.1.2', harnessVersion: '0.50.0', os: 'darwin', nodeVersion: 'v22.14.0' },
    project: { name: PROJECT.name, path: PROJECT.path },
    ...overrides,
  };
}

function draft(): IssueDraft {
  return createDraftFromReport(report(), {
    id: '1758812345678-a1b2c3d4e5f6a7b8',
    fingerprint: 'B:stop-ticket-gate.sh:0123456789abcdef',
    nowIso: '2026-10-04T12:00:00.000Z',
  });
}

describe('applyDraftEdit', () => {
  it('replaces only the given field and marks only that field as edited by the user', () => {
    const before = draft();
    const edited = applyDraftEdit(before, { body: 'a clean body' });
    expect(edited).toMatchObject({ title: before.title, body: 'a clean body', titleEditedByUser: false, bodyEditedByUser: true });
    expect(edited.suspectedLeaks).toEqual([]);
    expect(edited.suspectedLeaksOmitted).toBe(0);

    const both = applyDraftEdit(edited, { title: 'new title' });
    expect(both).toMatchObject({ title: 'new title', body: 'a clean body', titleEditedByUser: true, bodyEditedByUser: true });
  });

  it('flags the project path, the project name, a home path and a token left in the edited text, at their positions', () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const body = `cwd ${PROJECT.path}\nname example-project\nhome /home/someone/x\ntoken ${token}`;
    const edited = applyDraftEdit(draft(), { body });
    const leaks = edited.suspectedLeaks ?? [];
    const kinds = new Set(leaks.map((leak) => leak.kind));
    expect(kinds).toContain('project-path');
    expect(kinds).toContain('project');
    expect(kinds).toContain('home-path');
    expect(kinds).toContain('token');
    for (const leak of leaks) {
      expect(leak.field).toBe('body');
      expect(body.slice(leak.start, leak.end).length).toBeGreaterThan(0);
    }
    expect(leaks.some((leak) => body.slice(leak.start, leak.end) === token)).toBe(true);
    // 一致した文字列は保存しない (位置だけ)。
    expect(JSON.stringify(edited.suspectedLeaks)).not.toContain('example-user');
  });

  it('does not scan the generated (unedited) title, and scans the edited title', () => {
    const before = { ...draft(), title: 'generated example-project' };
    expect(applyDraftEdit(before, { body: 'clean' }).suspectedLeaks).toEqual([]);
    const titled = applyDraftEdit(before, { title: 'about example-project' });
    expect(titled.suspectedLeaks).toEqual([{ field: 'title', kind: 'project', start: 6, end: 21 }]);
  });

  it('keeps at most the cap of suspected leaks and records how many were left out', () => {
    // 2〜3 文字の名前は単語として現れるたびに疑いになる。
    const before = { ...draft(), occurredProjects: [{ ...PROJECT, name: 'abc', path: '/p/abc' }] };
    const count = ISSUE_DRAFT_MAX_SUSPECTED_LEAKS + 50;
    const edited = applyDraftEdit(before, { body: Array.from({ length: count }, () => 'abc').join(' ') });
    expect(edited.suspectedLeaks).toHaveLength(ISSUE_DRAFT_MAX_SUSPECTED_LEAKS);
    expect(edited.suspectedLeaksOmitted).toBe(50);
  });
});

describe('scanEditedText', () => {
  it('puts a key-overflow first when the local keys were cut at the cap', () => {
    const projects = Array.from({ length: 250 }, (_, index) => ({ ...PROJECT, name: `project-${index}`, path: `/p/project-${index}` }));
    const scan = scanEditedText({ title: 't', body: 'clean', titleEdited: false, bodyEdited: true }, projects);
    expect(scan.suspectedLeaks[0]).toEqual({ field: 'body', kind: 'key-overflow', start: 0, end: 0 });
  });
});

describe('addOccurrence: the local versions follow the latest occurrence (m-6)', () => {
  const later = '2026-10-05T09:00:00.000Z';

  it('replaces envInfo and harnessVersionAtOccurrence with the ones of the latest report', () => {
    const merged = addOccurrence(
      draft(),
      report({ envInfo: { bdboardVersion: '0.2.0', harnessVersion: '0.57.0', os: 'linux', nodeVersion: 'v22.15.0' } }),
      later,
    );
    expect(merged.harnessVersionAtOccurrence).toBe('0.57.0');
    expect(merged.localOnly.envInfo).toEqual({ bdboardVersion: '0.2.0', harnessVersion: '0.57.0', os: 'linux', nodeVersion: 'v22.15.0' });
    expect(merged.occurrenceCount).toBe(2);
    // 題名・本文を作り直すときも、最後の版で作る。
    expect(merged.body).toContain('0.57.0');
  });

  it('keeps the previous versions when the latest report carries no envInfo', () => {
    const merged = addOccurrence(draft(), report({ envInfo: undefined }), later);
    expect(merged.harnessVersionAtOccurrence).toBe('0.50.0');
    expect(merged.localOnly.envInfo.harnessVersion).toBe('0.50.0');
  });

  it('drops harnessVersionAtOccurrence when the latest envInfo has no harness version (does not mix two reports)', () => {
    const merged = addOccurrence(
      draft(),
      report({ envInfo: { bdboardVersion: '0.2.0', os: 'linux', nodeVersion: 'v22.15.0' } }),
      later,
    );
    expect(merged.harnessVersionAtOccurrence).toBeUndefined();
    expect(JSON.parse(JSON.stringify(merged))).not.toHaveProperty('harnessVersionAtOccurrence');
  });

  it('does not touch the versions of a dismissed draft (count only)', () => {
    const dismissed: IssueDraft = { ...draft(), status: 'dismissed', dismissReason: 'x' };
    const merged = addOccurrence(dismissed, report({ envInfo: { bdboardVersion: '0.2.0', harnessVersion: '0.57.0', os: 'linux', nodeVersion: 'v22' } }), later);
    expect(merged.harnessVersionAtOccurrence).toBe('0.50.0');
    expect(merged.occurrenceCount).toBe(2);
  });
});
