import { describe, expect, it } from 'vitest';
import { createDraftFromReport } from './issue-draft-build.js';
import { applyDraftEdit, localKeysOf, scanEditedText, withRescannedLeaks } from './issue-draft-edit.js';
import type { ReceiveDraftInput } from './issue-draft-input.js';
import type { IssueDraft } from './issue-draft.js';
import { buildPublicIssueBody } from './issue-public-build.js';
import { caseInsensitiveLiteral, foldedTextRemembered, withFoldedTextMemo } from './issue-public-casefold.js';
import { literalSearcher } from './issue-public-literal-search.js';
import type { LocalOnlyKeys, PublicBuildInput } from './issue-public-types.js';

/**
 * bdboard-qoxj: 本文のたたみの覚え (issue-public-casefold.ts の lastText) は、手元のパスやトークンを含みうる本文を持つので、
 * 1 回の走査の間だけ持つ。組み立て (buildPublicIssueBody) と、本番で動いている編集の再走査 (scanEditedText / withRescannedLeaks /
 * applyDraftEdit) の終わりに、覚えが残らないことを確かめる。覚えは出力から観測できないので、foldedTextRemembered で見る。
 */

const SEED_KEY = caseInsensitiveLiteral('example-project', false);

/** 覚えを作る: 本文を鍵で探すと、たたんだ本文がモジュールに残る。 */
function seedMemo(): void {
  literalSearcher('seed text that mentions Example-Project')(SEED_KEY);
  expect(foldedTextRemembered()).toBe(true);
}

const KEYS: LocalOnlyKeys = {
  projectRoots: ['/work/example-project'],
  properNouns: [{ category: 'project', value: 'example-project' }],
};

const BASE: PublicBuildInput = {
  kind: 'B',
  source: 'example-hook',
  symptom: 'failed in /work/Example-Project/src for example-project',
  versions: { bdboardVersion: '1.2.3', harnessVersion: '2.0.0', os: 'Example OS', nodeVersion: 'v22' },
  occurrenceCount: 2,
  firstOccurredAt: '2026-10-04T00:00:00Z',
  lastOccurredAt: '2026-10-04T01:00:00Z',
};

const PROJECT = {
  name: 'example-project',
  path: '/work/example-project',
  firstSeenAt: '2026-10-04T12:00:00.000Z',
  lastSeenAt: '2026-10-04T12:00:00.000Z',
};

function draft(): IssueDraft {
  const report: ReceiveDraftInput = {
    kind: 'B',
    source: 'stop-ticket-gate.sh',
    errorText: 'jq: command not found',
    envInfo: { bdboardVersion: '0.1.2', harnessVersion: '0.50.0', os: 'darwin', nodeVersion: 'v22.14.0' },
    project: { name: PROJECT.name, path: PROJECT.path },
  };
  return createDraftFromReport(report, {
    id: '1758812345678-a1b2c3d4e5f6a7b8',
    fingerprint: 'B:stop-ticket-gate.sh:0123456789abcdef',
    nowIso: '2026-10-04T12:00:00.000Z',
  });
}

describe('the folded text memo lives for one scan (bdboard-qoxj)', () => {
  it('withFoldedTextMemo keeps the memo while run goes, and drops it when run returns or throws', () => {
    const result = withFoldedTextMemo(() => {
      seedMemo();
      return 42;
    });
    expect(result).toBe(42);
    expect(foldedTextRemembered()).toBe(false);

    expect(() =>
      withFoldedTextMemo(() => {
        seedMemo();
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(foldedTextRemembered()).toBe(false);
  });

  it('buildPublicIssueBody drops the memo after a build, and after a build that throws on the way', () => {
    seedMemo();
    const built = buildPublicIssueBody(BASE, KEYS);
    // 組み立てが本当に鍵を探した (根と名前が印になった) うえで、覚えが残らない。
    expect(built.redactions.length).toBeGreaterThan(0);
    expect(foldedTextRemembered()).toBe(false);

    // 本文の組み立ての終わりの版の欄で投げる (自由記述のたたみは済んでいる)。
    const throwing: PublicBuildInput = {
      ...BASE,
      versions: {
        ...BASE.versions,
        get ghVersion(): string {
          throw new Error('boom');
        },
      },
    };
    seedMemo();
    expect(() => buildPublicIssueBody(throwing, KEYS)).toThrow('boom');
    expect(foldedTextRemembered()).toBe(false);
  });

  it('scanEditedText, withRescannedLeaks and applyDraftEdit drop the memo after the rescan of an edited field', () => {
    const body = 'cwd /Work/Example-Project/src\nname Example-Project';
    seedMemo();
    const scan = scanEditedText({ title: 'a title', body, titleEdited: false, bodyEdited: true }, localKeysOf([PROJECT]));
    // 再走査が本当に鍵を探した (根と名前が疑いに出た) うえで、覚えが残らない。
    expect(scan.suspectedLeaks.map((leak) => leak.kind)).toEqual(expect.arrayContaining(['project-path', 'project']));
    expect(foldedTextRemembered()).toBe(false);

    seedMemo();
    const rescanned = withRescannedLeaks({ ...draft(), body, bodyEditedByUser: true });
    expect((rescanned.suspectedLeaks ?? []).length).toBeGreaterThan(0);
    expect(foldedTextRemembered()).toBe(false);

    seedMemo();
    const edited = applyDraftEdit(draft(), { body }).draft;
    expect((edited.suspectedLeaks ?? []).length).toBeGreaterThan(0);
    expect(foldedTextRemembered()).toBe(false);
  });

  it('scanEditedText drops the memo when the scan throws on the way', () => {
    seedMemo();
    // 実行時に文字列でない欄 (型の外から来た値) で、検出の途中で投げさせる。
    expect(() =>
      scanEditedText({ title: Symbol('not a string') as never, body: 'body', titleEdited: true, bodyEdited: false }, localKeysOf([PROJECT])),
    ).toThrow();
    expect(foldedTextRemembered()).toBe(false);
  });
});
