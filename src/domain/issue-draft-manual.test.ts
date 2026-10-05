import { describe, expect, it } from 'vitest';
import { ISSUE_DRAFT_FREE_TEXT_MAX_CHARS, isMassOccurrenceFingerprint } from './issue-draft.js';
import {
  MANUAL_DRAFT_SOURCE,
  countManualDraftsSince,
  createManualDraft,
  isManualFingerprint,
  manualFingerprint,
  type ManualDraftInput,
} from './issue-draft-manual.js';
import { autoTextOf } from './issue-draft-text.js';

const NOW = '2026-10-04T12:00:00.000Z';
const KEY = 'a1b2c3d4e5f6a7b8';
const ENV = { bdboardVersion: '0.1.2', os: 'darwin', nodeVersion: 'v22.14.0' };
const META = { id: '1758812345001-a1b2c3d4e5f6a7b8', fingerprint: manualFingerprint(KEY), nowIso: NOW };

function input(overrides: Partial<ManualDraftInput> = {}): ManualDraftInput {
  return { title: 'The board hangs', description: 'Opened the board and it froze', envInfo: ENV, ...overrides };
}

describe('manualFingerprint / isManualFingerprint', () => {
  it('builds C:manual:<16 hex> and recognizes only that head', () => {
    expect(manualFingerprint(KEY)).toBe(`C:manual:${KEY}`);
    expect(isManualFingerprint(`C:manual:${KEY}`)).toBe(true);
    expect(isManualFingerprint('C:other:abcd')).toBe(false);
    expect(isManualFingerprint('B:manual:abcd')).toBe(false);
    expect(isManualFingerprint(`mass-occurrence:C:2026-10-04T12`)).toBe(false);
  });

  it.each(['', 'short', 'A1B2C3D4E5F6A7B8', `${KEY}0`, 'a1b2c3d4e5f6a7b!'])('refuses %j (not 16 lowercase hex digits)', (value) => {
    expect(() => manualFingerprint(value)).toThrow();
  });
});

describe('createManualDraft', () => {
  it('builds a pending kind C draft from source manual, never a mass-occurrence draft', () => {
    const draft = createManualDraft(input(), META);
    expect(draft).toMatchObject({
      id: META.id,
      kind: 'C',
      source: MANUAL_DRAFT_SOURCE,
      fingerprint: `C:manual:${KEY}`,
      status: 'pending',
      occurrenceCount: 1,
      firstOccurredAt: NOW,
      lastOccurredAt: NOW,
      draftSchemaVersion: 1,
    });
    expect(isMassOccurrenceFingerprint(draft.fingerprint)).toBe(false);
    expect(draft.occurredProjects).toEqual([]);
  });

  it('saves the title as an edited title and keeps the body automatic', () => {
    const draft = createManualDraft(input({ title: 'My own title' }), META);
    expect(draft.title).toBe('My own title');
    expect(draft.titleEditedByUser).toBe(true);
    expect(draft.bodyEditedByUser).toBe(false);
    // 本文は自動の暫定の本文 (自動の題名は使わないが、本文は同じ関数で組む)。
    expect(draft.body).toBe(autoTextOf(draft).body);
    expect(draft.body).toContain('対象: manual');
  });

  it('puts the description into the hand-only agent note and never into the public title or body', () => {
    const description = 'steps: click the third tab, the spinner never stops (unique-marker-7f3a)';
    const draft = createManualDraft(input({ description }), META);
    expect(draft.localOnly.agentNoteRaw).toBe(description);
    expect(draft.localOnly).toMatchObject({ symptomRaw: '', causeRaw: '', preventionRaw: '', errorTextTruncated: false });
    expect(draft.body).not.toContain('unique-marker-7f3a');
    expect(draft.title).not.toContain('unique-marker-7f3a');
  });

  it('fills the environment from the input and records the harness version when there is one', () => {
    const draft = createManualDraft(input({ envInfo: { ...ENV, harnessVersion: '0.56.0' } }), META);
    expect(draft.localOnly.envInfo).toEqual({ ...ENV, harnessVersion: '0.56.0' });
    expect(draft.harnessVersionAtOccurrence).toBe('0.56.0');
    expect(createManualDraft(input(), META).harnessVersionAtOccurrence).toBeUndefined();
  });

  it('flags a project name written in the title (the existing leak check runs on the edited title)', () => {
    const draft = createManualDraft(
      input({ title: 'example-project crashes on start', project: { name: 'example-project', path: '/Users/example-user/src/example-project' } }),
      META,
    );
    const leaks = draft.suspectedLeaks ?? [];
    expect(leaks.some((leak) => leak.field === 'title' && leak.kind === 'project')).toBe(true);
    expect(draft.suspectedLeaksOmitted).toBe(0);
    expect(draft.occurredProjects.map((project) => project.name)).toEqual(['example-project']);
  });

  it('flags a project root path or a home path written in the title even without a known project', () => {
    const withHome = createManualDraft(input({ title: 'fails in /Users/example-user/src/app' }), META);
    expect(withHome.suspectedLeaks?.some((leak) => leak.field === 'title')).toBe(true);
  });

  it('leaves a plain title unflagged', () => {
    const draft = createManualDraft(input(), META);
    expect(draft.suspectedLeaks).toEqual([]);
  });

  it('does not scan the description (it is hand-only and never published as written)', () => {
    const draft = createManualDraft(
      input({ description: 'see /Users/example-user/src/example-project', project: { name: 'example-project', path: '/Users/example-user/src/example-project' } }),
      META,
    );
    expect(draft.suspectedLeaks ?? []).toEqual([]);
  });

  it('caps an over-long description like the other free-text fields', () => {
    const draft = createManualDraft(input({ description: 'x'.repeat(ISSUE_DRAFT_FREE_TEXT_MAX_CHARS + 50) }), META);
    expect(draft.localOnly.agentNoteRaw?.length).toBe(ISSUE_DRAFT_FREE_TEXT_MAX_CHARS);
  });
});

describe('countManualDraftsSince', () => {
  const at = (iso: string) => Date.parse(iso);
  const drafts = [
    { fingerprint: 'C:manual:aaaaaaaaaaaaaaaa', firstOccurredAt: '2026-10-04T11:30:00.000Z' },
    { fingerprint: 'C:manual:bbbbbbbbbbbbbbbb', firstOccurredAt: '2026-10-04T11:00:00.000Z' },
    { fingerprint: 'C:manual:cccccccccccccccc', firstOccurredAt: '2026-10-04T10:59:59.999Z' },
    { fingerprint: 'C:some-hook:dddddddddddddddd', firstOccurredAt: '2026-10-04T11:45:00.000Z' },
    { fingerprint: 'mass-occurrence:C:2026-10-04T11', firstOccurredAt: '2026-10-04T11:45:00.000Z' },
  ];

  it('counts only manual fingerprints created at or after the cut-off', () => {
    expect(countManualDraftsSince(drafts, at('2026-10-04T11:00:00.000Z'))).toBe(2);
    expect(countManualDraftsSince(drafts, at('2026-10-04T11:00:00.001Z'))).toBe(1);
    expect(countManualDraftsSince(drafts, at('2026-10-04T12:00:00.000Z'))).toBe(0);
  });
});
