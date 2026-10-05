import { describe, expect, it } from 'vitest';
import { ISSUE_DRAFT_MAX_JSON_BYTES, type IssueDraft } from './issue-draft.js';
import { addOccurrence, createDraftFromReport } from './issue-draft-build.js';
import {
  ISSUE_DRAFT_MAX_SUSPECTED_LEAKS,
  applyDraftEdit,
  displayedKeysOf,
  localKeysOf,
  scanEditedText,
  type DraftTextEdit,
} from './issue-draft-edit.js';
import { draftJsonBytes } from './issue-draft-size.js';
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

/** 編集後の下書きだけを見る。 */
const editDraft = (before: IssueDraft, edit: DraftTextEdit): IssueDraft => applyDraftEdit(before, edit).draft;

describe('applyDraftEdit', () => {
  it('replaces only the given field and marks only that field as edited by the user', () => {
    const before = draft();
    const edited = editDraft(before, { body: 'a clean body' });
    expect(edited).toMatchObject({ title: before.title, body: 'a clean body', titleEditedByUser: false, bodyEditedByUser: true });
    expect(edited.suspectedLeaks).toEqual([]);
    expect(edited.suspectedLeaksOmitted).toBe(0);

    const both = editDraft(edited, { title: 'new title' });
    expect(both).toMatchObject({ title: 'new title', body: 'a clean body', titleEditedByUser: true, bodyEditedByUser: true });
  });

  it('flags the project path, the project name, a home path and a token left in the edited text, at their positions', () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const body = `cwd ${PROJECT.path}\nname example-project\nhome /home/someone/x\ntoken ${token}`;
    const edited = editDraft(draft(), { body });
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
    expect(editDraft(before, { body: 'clean' }).suspectedLeaks).toEqual([]);
    const titled = editDraft(before, { title: 'about example-project' });
    expect(titled.suspectedLeaks).toEqual([{ field: 'title', kind: 'project', start: 6, end: 21 }]);
  });

  it('keeps at most the cap of suspected leaks and records how many were left out', () => {
    // 2〜3 文字の名前は単語として現れるたびに疑いになる。
    const before = { ...draft(), occurredProjects: [{ ...PROJECT, name: 'abc', path: '/p/abc' }] };
    const count = ISSUE_DRAFT_MAX_SUSPECTED_LEAKS + 50;
    const edited = editDraft(before, { body: Array.from({ length: count }, () => 'abc').join(' ') });
    expect(edited.suspectedLeaks).toHaveLength(ISSUE_DRAFT_MAX_SUSPECTED_LEAKS);
    expect(edited.suspectedLeaksOmitted).toBe(50);
  });
});

describe('scanEditedText', () => {
  it('puts a key-overflow first when the local keys were cut at the cap', () => {
    const projects = Array.from({ length: 250 }, (_, index) => ({ ...PROJECT, name: `project-${index}`, path: `/p/project-${index}` }));
    const scan = scanEditedText({ title: 't', body: 'clean', titleEdited: false, bodyEdited: true }, localKeysOf(projects));
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

  it('keeps the known harnessVersionAtOccurrence when the latest envInfo has no harness version (envInfo itself follows)', () => {
    for (const envInfo of [{ bdboardVersion: '0.2.0', os: 'linux', nodeVersion: 'v22.15.0' }, {}]) {
      const merged = addOccurrence(draft(), report({ envInfo }), later);
      expect(merged.harnessVersionAtOccurrence).toBe('0.50.0');
      expect(merged.localOnly.envInfo.harnessVersion).toBeUndefined();
    }
  });

  it('does not touch the versions of a dismissed draft (count only)', () => {
    const dismissed: IssueDraft = { ...draft(), status: 'dismissed', dismissReason: 'x' };
    const merged = addOccurrence(dismissed, report({ envInfo: { bdboardVersion: '0.2.0', harnessVersion: '0.57.0', os: 'linux', nodeVersion: 'v22' } }), later);
    expect(merged.harnessVersionAtOccurrence).toBe('0.50.0');
    expect(merged.occurrenceCount).toBe(2);
  });
});

describe('applyDraftEdit: the flags stick and only edited fields are scanned (review m-2)', () => {
  it('keeps titleEditedByUser after a later body-only edit', () => {
    const titled = editDraft(draft(), { title: 'mine' });
    expect(editDraft(titled, { body: 'b' })).toMatchObject({ titleEditedByUser: true, bodyEditedByUser: true, title: 'mine' });
  });

  it('does not scan the generated body when only the title was edited', () => {
    const before = { ...draft(), body: `generated ${PROJECT.path} example-project` };
    expect(editDraft(before, { title: 'clean title' }).suspectedLeaks).toEqual([]);
  });
});

describe('applyDraftEdit: fitting 200KB trims only the raw error text (review M-2)', () => {
  function big(): IssueDraft {
    const base = draft();
    return {
      ...base,
      localOnly: {
        ...base.localOnly,
        errorTextRaw: 'e'.repeat(60_000),
        symptomRaw: 's'.repeat(8_000),
        causeRaw: 'c'.repeat(8_000),
        agentNoteRaw: 'n'.repeat(8_000),
      },
    };
  }

  it('cuts the tail of errorTextRaw to fit, marks it truncated, and keeps the projects and the written fields', () => {
    const before = big();
    const outcome = applyDraftEdit(before, { body: 'あ'.repeat(40_000) });
    expect(outcome.errorTextTrimmed).toBe(true);
    const after = outcome.draft;
    expect(draftJsonBytes(after)).toBeLessThanOrEqual(ISSUE_DRAFT_MAX_JSON_BYTES);
    expect(after.localOnly.errorTextRaw?.length).toBeLessThan(60_000);
    expect(before.localOnly.errorTextRaw?.startsWith(after.localOnly.errorTextRaw ?? '')).toBe(true);
    expect(after.localOnly.errorTextTruncated).toBe(true);
    expect(after.localOnly.errorTextHead).toBe(before.localOnly.errorTextHead);
    expect(after.occurredProjects).toEqual(before.occurredProjects);
    expect(after.localOnly).toMatchObject({ symptomRaw: before.localOnly.symptomRaw, causeRaw: before.localOnly.causeRaw, agentNoteRaw: before.localOnly.agentNoteRaw });
  });

  it('does not trim when the edit fits, and leaves an edit that cannot fit over the limit without touching the projects or written fields', () => {
    expect(applyDraftEdit(big(), { body: 'short' })).toMatchObject({ errorTextTrimmed: false });
    const before = big();
    // 見える文字が無い本文は自動の文へ戻る (bdboard-ov0t) ので、末尾に見える 1 文字を付けて「大きい本文の編集」にする。
    const outcome = applyDraftEdit(before, { body: `${'\u0001'.repeat(65_535)}x` });
    expect(draftJsonBytes(outcome.draft)).toBeGreaterThan(ISSUE_DRAFT_MAX_JSON_BYTES);
    expect(outcome.draft.occurredProjects).toEqual(before.occurredProjects);
    expect(outcome.draft.localOnly.symptomRaw).toBe(before.localOnly.symptomRaw);
  });

  it('cuts the raw error text at a line end, not inside a root or a token (bdboard-4y8q.13)', () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const raw = `${Array.from({ length: 500 }, (_, index) => `    at fn${index} (${PROJECT.path}/src/a${index}.ts:1:1) ${token}`).join('\n')}\n`;
    const before = { ...big(), localOnly: { ...big().localOnly, errorTextRaw: raw } };
    const outcome = applyDraftEdit(before, { body: 'あ'.repeat(40_000) });
    expect(outcome).toMatchObject({ errorTextTrimmed: true, fits: true });
    const trimmed = outcome.draft.localOnly.errorTextRaw ?? '';
    expect(trimmed.length).toBeGreaterThan(0);
    expect(trimmed.length).toBeLessThan(raw.length);
    expect(raw.startsWith(trimmed)).toBe(true);
    // 行の終わりで切れているので、最後の行も根とトークンが丸ごと残る完全な行。
    expect(trimmed.endsWith(`${token}\n`)).toBe(true);
  });

  it('does not split a surrogate pair when the raw error text has no newline', () => {
    const before = { ...big(), localOnly: { ...big().localOnly, errorTextRaw: String.fromCodePoint(0x1f600).repeat(30_000) } };
    const outcome = applyDraftEdit(before, { body: 'あ'.repeat(40_000) });
    expect(outcome).toMatchObject({ errorTextTrimmed: true, fits: true });
    const trimmed = outcome.draft.localOnly.errorTextRaw ?? '';
    expect(trimmed.length % 2).toBe(0);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(trimmed)).toBe(false);
  });
});

describe('the keys used for the tunnel and for the merge rescan (review M-1, m-1)', () => {
  it('gives the tunnel the display names only, never the project roots', () => {
    expect(displayedKeysOf([PROJECT])).toEqual({ projectRoots: [], properNouns: [{ category: 'project', value: PROJECT.name }] });
  });

  it('folds a raw home path in a stored name the way the tunnel sees it (re-review n-A)', () => {
    const raw = { ...PROJECT, name: '/Users/example-user/tool', path: '/Users/example-user/tool' };
    expect(displayedKeysOf([raw]).properNouns).toEqual([{ category: 'project', value: '~/tool' }]);
  });

  it('rescans the edited body when a merge adds a new project', () => {
    const edited = editDraft(draft(), { body: 'see /opt/two-proj/x' });
    expect(edited.suspectedLeaks).toEqual([]);
    const merged = addOccurrence(edited, report({ project: { name: 'two-proj', path: '/opt/two-proj' } }), '2026-10-05T09:00:00.000Z');
    expect(merged.suspectedLeaks?.some((leak) => leak.kind === 'project-path')).toBe(true);
    expect(merged.body).toBe('see /opt/two-proj/x');
  });
});
