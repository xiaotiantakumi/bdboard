import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  ISSUE_DRAFT_ERROR_TEXT_EDGE_CHARS,
  ISSUE_DRAFT_FREE_TEXT_MAX_CHARS,
  ISSUE_DRAFT_MAX_IMAGES,
  ISSUE_DRAFT_MAX_JSON_BYTES,
  ISSUE_DRAFT_NEW_PER_HOUR,
  ISSUE_DRAFT_ERROR_TEXT_RAW_MAX_CHARS,
  isMassOccurrenceFingerprint,
  type IssueDraft,
} from '../../domain/issue-draft.js';
import { draftJsonBytes } from '../../domain/issue-draft-size.js';
import {
  createIssueDraftService,
  type IssueDraftService,
  type ReceiveDraftInput,
} from './issue-draft-service.js';
import {
  createInMemoryIssueDraftStorage,
  type InMemoryIssueDraftStorage,
} from './issue-draft-test-support.js';

const ENV = { bdboardVersion: '0.1.2', os: 'darwin', nodeVersion: 'v22.14.0' };

interface Harness {
  readonly service: IssueDraftService;
  readonly storage: InMemoryIssueDraftStorage;
  setNow(iso: string): void;
}

function createHarness(
  startIso = '2026-10-04T12:00:00.000Z',
  existing?: InMemoryIssueDraftStorage,
): Harness {
  let current = new Date(startIso);
  let seq = 0;
  const storage = existing ?? createInMemoryIssueDraftStorage();
  const service = createIssueDraftService({
    storage,
    now: () => new Date(current),
    newId: () => {
      seq += 1;
      return `${1758812345000 + seq}-${seq.toString(16).padStart(16, '0')}`;
    },
  });
  return { service, storage, setNow: (iso) => { current = new Date(iso); } };
}

function catalogInput(slug: string, overrides: Partial<ReceiveDraftInput> = {}): ReceiveDraftInput {
  return { kind: 'A', catalogSlug: slug, symptom: 'symptom', envInfo: ENV, ...overrides };
}

async function expectOk(promise: ReturnType<IssueDraftService['receive']>) {
  const result = await promise;
  if (!result.ok) throw new Error(`receive failed: ${result.reason}`);
  return result;
}

describe('receive: new draft', () => {
  it('stores a pending draft with the fingerprint, count 1 and the hand-only context', async () => {
    const { service, storage } = createHarness();
    const result = await expectOk(
      service.receive({
        kind: 'B',
        source: 'stop-ticket-gate.sh',
        symptom: 'gate silently passed',
        cause: 'jq missing',
        prevention: 'check jq',
        errorText: 'jq: command not found',
        agentNote: 'noticed in session',
        envInfo: { ...ENV, harnessVersion: '0.56.0', bdVersion: '1.0.0', ghVersion: '2.86.0' },
        project: { name: 'example-project', path: '/Users/example-user/example-project' },
        sourceTicketRef: 'example-1',
      }),
    );

    expect(result.outcome).toBe('created');
    const draft = result.draft;
    expect(draft.status).toBe('pending');
    expect(draft.kind).toBe('B');
    expect(draft.fingerprint).toMatch(/^B:stop-ticket-gate\.sh:[0-9a-f]{16}$/);
    expect(draft.occurrenceCount).toBe(1);
    expect(draft.firstOccurredAt).toBe('2026-10-04T12:00:00.000Z');
    expect(draft.lastOccurredAt).toBe('2026-10-04T12:00:00.000Z');
    expect(draft.occurredProjects).toEqual([
      {
        name: 'example-project',
        path: '/Users/example-user/example-project',
        firstSeenAt: '2026-10-04T12:00:00.000Z',
        lastSeenAt: '2026-10-04T12:00:00.000Z',
      },
    ]);
    expect(draft.localOnly).toMatchObject({
      symptomRaw: 'gate silently passed',
      causeRaw: 'jq missing',
      preventionRaw: 'check jq',
      errorTextRaw: 'jq: command not found',
      errorTextHead: 'jq: command not found',
      errorTextTail: '',
      errorTextTruncated: false,
      agentNoteRaw: 'noticed in session',
      envInfo: { bdboardVersion: '0.1.2', harnessVersion: '0.56.0', bdVersion: '1.0.0', ghVersion: '2.86.0' },
    });
    expect(draft.harnessVersionAtOccurrence).toBe('0.56.0');
    expect(draft.sourceTicketRef).toBe('example-1');
    expect(draft.titleEditedByUser).toBe(false);
    expect(draft.bodyEditedByUser).toBe(false);
    expect(draft.draftSchemaVersion).toBe(1);
    expect(storage.drafts.get(draft.id)).toEqual(draft);
  });

  it('fills missing env info with "unknown" so a report from a thin caller is not lost', async () => {
    const { service } = createHarness();
    const result = await expectOk(service.receive({ kind: 'C', source: 'GET /api/x', errorText: 'boom' }));
    expect(result.draft.localOnly.envInfo).toEqual({
      bdboardVersion: 'unknown',
      os: 'unknown',
      nodeVersion: 'unknown',
    });
  });

  it('refuses an input that cannot be fingerprinted', async () => {
    const { service, storage } = createHarness();
    expect(await service.receive({ kind: 'A', envInfo: ENV })).toEqual({
      ok: false,
      reason: 'missing-identifier',
    });
    expect(await service.receive({ kind: 'B', errorText: 'x', envInfo: ENV })).toEqual({
      ok: false,
      reason: 'missing-identifier',
    });
    expect(storage.drafts.size).toBe(0);
  });
});

describe('receive: fingerprint merge', () => {
  it('pending: adds to the count, the last-seen time and the project list instead of a new draft', async () => {
    const { service, storage, setNow } = createHarness();
    const first = await expectOk(
      service.receive(catalogInput('slug-x', { project: { name: 'alpha', path: '/p/alpha' } })),
    );

    setNow('2026-10-04T12:10:00.000Z');
    const second = await expectOk(
      service.receive(catalogInput('slug-x', { project: { name: 'beta', path: '/p/beta' } })),
    );
    expect(second.outcome).toBe('merged');
    expect(second.draft.id).toBe(first.draft.id);
    expect(storage.drafts.size).toBe(1);
    expect(second.draft.occurrenceCount).toBe(2);
    expect(second.draft.firstOccurredAt).toBe('2026-10-04T12:00:00.000Z');
    expect(second.draft.lastOccurredAt).toBe('2026-10-04T12:10:00.000Z');
    expect(second.draft.occurredProjects.map((project) => project.name)).toEqual(['alpha', 'beta']);

    setNow('2026-10-04T12:20:00.000Z');
    const third = await expectOk(
      service.receive(catalogInput('slug-x', { project: { name: 'alpha', path: '/p/alpha' } })),
    );
    expect(third.draft.occurrenceCount).toBe(3);
    expect(third.draft.occurredProjects).toHaveLength(2);
    const alpha = third.draft.occurredProjects.find((project) => project.name === 'alpha');
    expect(alpha?.firstSeenAt).toBe('2026-10-04T12:00:00.000Z');
    expect(alpha?.lastSeenAt).toBe('2026-10-04T12:20:00.000Z');
  });

  it('regenerates title and body on merge unless the user edited them', async () => {
    const { service, storage, setNow } = createHarness();
    const first = await expectOk(service.receive(catalogInput('slug-y')));
    expect(first.draft.body).toContain('1');

    // ユーザーが本文だけ編集した状態を仕込む (編集 API は 4y8q.3 側だが、フラグの意味はここで守る)。
    storage.drafts.set(first.draft.id, {
      ...first.draft,
      body: 'edited by a person',
      bodyEditedByUser: true,
    });

    setNow('2026-10-04T12:05:00.000Z');
    const merged = await expectOk(service.receive(catalogInput('slug-y')));
    expect(merged.draft.body).toBe('edited by a person');
    expect(merged.draft.title).toContain('slug-y');
    expect(merged.draft.occurrenceCount).toBe(2);
  });

  it('dismissed: only the count goes up; time and projects stay as they were', async () => {
    const { service, setNow } = createHarness();
    const first = await expectOk(
      service.receive(catalogInput('slug-z', { project: { name: 'alpha', path: '/p/alpha' } })),
    );
    const dismissed = await service.dismiss(first.draft.id, 'not our bug');
    expect(dismissed.ok).toBe(true);

    setNow('2026-10-04T14:00:00.000Z');
    const again = await expectOk(
      service.receive(catalogInput('slug-z', { project: { name: 'beta', path: '/p/beta' } })),
    );
    expect(again.outcome).toBe('merged');
    expect(again.draft.id).toBe(first.draft.id);
    expect(again.draft.status).toBe('dismissed');
    expect(again.draft.dismissReason).toBe('not our bug');
    expect(again.draft.occurrenceCount).toBe(2);
    expect(again.draft.lastOccurredAt).toBe('2026-10-04T12:00:00.000Z');
    expect(again.draft.occurredProjects.map((project) => project.name)).toEqual(['alpha']);
  });

  it('serialises concurrent receives of one fingerprint into a single draft', async () => {
    const { service, storage } = createHarness();
    await Promise.all(Array.from({ length: 8 }, () => service.receive(catalogInput('slug-race'))));
    expect(storage.drafts.size).toBe(1);
    expect([...storage.drafts.values()][0].occurrenceCount).toBe(8);
  });

  it('keeps source and catalogSlug as fields of their own and rebuilds the title from them', async () => {
    const { service, setNow } = createHarness();
    const b = await expectOk(
      service.receive({ kind: 'B', source: '  hook:with:colons.sh ', errorText: 'boom', envInfo: ENV }),
    );
    expect(b.draft.source).toBe('hook:with:colons.sh');
    expect(b.draft).not.toHaveProperty('catalogSlug');
    expect(b.draft.title).toBe('[hook・配布スクリプト] hook:with:colons.sh');

    const a = await expectOk(service.receive(catalogInput(' slug-a ')));
    expect(a.draft.catalogSlug).toBe('slug-a');
    expect(a.draft).not.toHaveProperty('source');

    setNow('2026-10-04T12:30:00.000Z');
    const merged = await expectOk(
      service.receive({ kind: 'B', source: 'hook:with:colons.sh', errorText: 'boom', envInfo: ENV }),
    );
    expect(merged.draft.title).toBe('[hook・配布スクリプト] hook:with:colons.sh');
    expect(merged.draft.source).toBe('hook:with:colons.sh');
  });

  it('finds drafts that were saved before this process started (restart)', async () => {
    const first = createHarness();
    const created = await expectOk(first.service.receive(catalogInput('slug-restart')));
    const restarted = createHarness('2026-10-04T12:30:00.000Z', first.storage);
    const merged = await expectOk(restarted.service.receive(catalogInput('slug-restart')));
    expect(merged.outcome).toBe('merged');
    expect(merged.draft.id).toBe(created.draft.id);
    expect(first.storage.drafts.size).toBe(1);
  });
});

describe('receive: values that change on every run still merge', () => {
  it('folds 25 receives of one error with a random UUID, short SHA and temp dir into one draft', async () => {
    const { service, storage } = createHarness();
    const outcomes: string[] = [];
    for (let index = 0; index < 25; index += 1) {
      const sha = `${index % 10}${randomBytes(3).toString('hex')}`; // 7 文字、数字を含む
      const errorText = [
        `deploy ${randomUUID()} failed at commit ${sha}`,
        `in /private/var/folders/${randomBytes(2).toString('hex')}/T/tmp.${randomBytes(3).toString('hex')}/out.log`,
      ].join(' ');
      const result = await expectOk(service.receive({ kind: 'B', source: 'deploy.sh', errorText, envInfo: ENV }));
      outcomes.push(result.outcome);
    }
    expect(outcomes).toEqual(['created', ...Array.from({ length: 24 }, () => 'merged')]);
    expect(storage.drafts.size).toBe(1);
    expect([...storage.drafts.values()][0].occurrenceCount).toBe(25);
  });
});

describe('receive: size caps', () => {
  it('keeps the raw error text to the cap, and head and tail only for display', async () => {
    const { service, storage } = createHarness();
    const errorText = `HEAD${'m'.repeat(200_000)}TAIL`;
    const result = await expectOk(service.receive({ kind: 'C', source: 's', errorText, envInfo: ENV }));
    const { localOnly } = result.draft;
    expect(localOnly.errorTextRaw).toHaveLength(ISSUE_DRAFT_ERROR_TEXT_RAW_MAX_CHARS);
    expect(localOnly.errorTextHead).toHaveLength(ISSUE_DRAFT_ERROR_TEXT_EDGE_CHARS);
    expect(localOnly.errorTextTail).toHaveLength(ISSUE_DRAFT_ERROR_TEXT_EDGE_CHARS);
    expect(localOnly.errorTextHead?.startsWith('HEAD')).toBe(true);
    expect(localOnly.errorTextTruncated).toBe(true);
    const stored = storage.drafts.get(result.draft.id);
    expect(draftJsonBytes(stored as IssueDraft)).toBeLessThanOrEqual(ISSUE_DRAFT_MAX_JSON_BYTES);
  });

  it('caps each free-text field and keeps the whole draft.json within 200KB even for multibyte text', async () => {
    const { service, storage } = createHarness();
    const long = 'あ'.repeat(100_000);
    const result = await expectOk(
      service.receive({
        kind: 'C',
        source: 's',
        symptom: long,
        cause: long,
        prevention: long,
        agentNote: long,
        errorText: long,
        envInfo: ENV,
      }),
    );
    expect(result.draft.localOnly.symptomRaw).toHaveLength(ISSUE_DRAFT_FREE_TEXT_MAX_CHARS);
    expect(result.draft.localOnly.agentNoteRaw).toHaveLength(ISSUE_DRAFT_FREE_TEXT_MAX_CHARS);
    const stored = storage.drafts.get(result.draft.id);
    expect(draftJsonBytes(stored as IssueDraft)).toBeLessThanOrEqual(ISSUE_DRAFT_MAX_JSON_BYTES);
  });
});

describe('receive: at most 20 new drafts per hour', () => {
  async function receiveDistinct(service: IssueDraftService, count: number, prefix: string, kind: 'A' | 'B' | 'C' = 'A') {
    for (let index = 0; index < count; index += 1) {
      await expectOk(
        service.receive(
          kind === 'A'
            ? catalogInput(`${prefix}-${index}`)
            : { kind, source: 's', errorText: `${prefix} distinct message ${'x'.repeat(index + 1)}`, envInfo: ENV },
        ),
      );
    }
  }

  const drafts = (storage: InMemoryIssueDraftStorage): IssueDraft[] => [...storage.drafts.values()];
  const individual = (storage: InMemoryIssueDraftStorage) =>
    drafts(storage).filter((draft) => !isMassOccurrenceFingerprint(draft.fingerprint));
  const mass = (storage: InMemoryIssueDraftStorage) =>
    drafts(storage).filter((draft) => isMassOccurrenceFingerprint(draft.fingerprint));

  it('folds the 21st and later new fingerprints into one 大量発生 draft', async () => {
    const { service, storage } = createHarness();
    await receiveDistinct(service, ISSUE_DRAFT_NEW_PER_HOUR, 'fp');
    expect(individual(storage)).toHaveLength(20);
    expect(mass(storage)).toHaveLength(0);

    const folded = await expectOk(service.receive(catalogInput('fp-overflow-1')));
    expect(folded.outcome).toBe('folded');
    expect(folded.draft.fingerprint).toBe('mass-occurrence:A:2026-10-04T12');
    expect(folded.draft.title).toContain('大量発生');
    expect(folded.draft.occurrenceCount).toBe(1);
    expect(folded.draft.localOnly.foldedFingerprints).toEqual(['A:fp-overflow-1']);

    await expectOk(service.receive(catalogInput('fp-overflow-2')));
    const again = await expectOk(service.receive(catalogInput('fp-overflow-2')));
    expect(again.draft.id).toBe(folded.draft.id);
    expect(again.draft.occurrenceCount).toBe(3);
    expect(again.draft.localOnly.foldedFingerprints).toEqual(['A:fp-overflow-1', 'A:fp-overflow-2']);
    expect(again.draft.body).toContain('2');

    expect(individual(storage)).toHaveLength(20);
    expect(mass(storage)).toHaveLength(1);
    expect(mass(storage)[0].status).toBe('pending');
  });

  it.each(['dismissed', 'posted'] as const)(
    'adds to a %s 大量発生 draft only by count: no new text, fingerprints, time or project',
    async (status) => {
      const { service, storage, setNow } = createHarness();
      await receiveDistinct(service, ISSUE_DRAFT_NEW_PER_HOUR, 'fp');
      const first = await expectOk(
        service.receive(catalogInput('fp-over-1', { project: { name: 'alpha', path: '/p/alpha' } })),
      );
      expect(first.outcome).toBe('folded');
      const massId = first.draft.id;
      if (status === 'dismissed') {
        expect((await service.dismiss(massId, 'noise')).ok).toBe(true);
      } else {
        storage.drafts.set(massId, { ...(storage.drafts.get(massId) as IssueDraft), status: 'posted' });
      }
      const before = structuredClone(storage.drafts.get(massId)) as IssueDraft;

      setNow('2026-10-04T12:30:00.000Z');
      const again = await expectOk(
        service.receive(catalogInput('fp-over-2', { project: { name: 'beta', path: '/p/beta' } })),
      );
      expect(again.outcome).toBe('folded');
      expect(again.draft.id).toBe(massId);
      // 回数のほかは 1 バイトも変わらない (題名・本文・指紋の一覧・最終時刻・プロジェクト)。
      expect(again.draft).toEqual({ ...before, occurrenceCount: before.occurrenceCount + 1 });
      expect(storage.drafts.get(massId)).toEqual(again.draft);
      expect(mass(storage)).toHaveLength(1);
    },
  );

  it('still merges a known fingerprint into its existing draft after the cap is reached', async () => {
    const { service, storage } = createHarness();
    await receiveDistinct(service, ISSUE_DRAFT_NEW_PER_HOUR, 'fp');
    const merged = await expectOk(service.receive(catalogInput('fp-0')));
    expect(merged.outcome).toBe('merged');
    expect(merged.draft.occurrenceCount).toBe(2);
    expect(mass(storage)).toHaveLength(0);
  });

  it('starts counting afresh in the next UTC hour', async () => {
    const { service, storage, setNow } = createHarness('2026-10-04T12:05:00.000Z');
    await receiveDistinct(service, ISSUE_DRAFT_NEW_PER_HOUR, 'fp');
    await expectOk(service.receive(catalogInput('fp-overflow')));
    expect(mass(storage)).toHaveLength(1);

    setNow('2026-10-04T13:00:00.000Z');
    const next = await expectOk(service.receive(catalogInput('fp-next-hour')));
    expect(next.outcome).toBe('created');
    expect(individual(storage)).toHaveLength(21);
    expect(mass(storage)).toHaveLength(1);
  });

  it('keeps the 大量発生 drafts per kind and does not count them toward the 20', async () => {
    const { service, storage } = createHarness();
    await receiveDistinct(service, 12, 'a', 'A');
    await receiveDistinct(service, 8, 'b', 'B');
    expect(individual(storage)).toHaveLength(20);

    const foldedA = await expectOk(service.receive(catalogInput('a-over')));
    const foldedC = await expectOk(
      service.receive({ kind: 'C', source: 's', errorText: 'over distinct', envInfo: ENV }),
    );
    expect(foldedA.draft.fingerprint).toBe('mass-occurrence:A:2026-10-04T12');
    expect(foldedC.draft.fingerprint).toBe('mass-occurrence:C:2026-10-04T12');
    expect(mass(storage)).toHaveLength(2);
    expect(individual(storage)).toHaveLength(20);
  });
});

describe('draft.json stays within 200KB however hostile the input', () => {
  // JSON で 1 文字が 2〜6 バイトに膨らむ文字 (引用符・バックスラッシュ・制御文字) と 3 バイト文字。
  const NASTY = '"\\\u0001あ';
  const bytesOf = (storage: InMemoryIssueDraftStorage, id: string) =>
    draftJsonBytes(storage.drafts.get(id) as IssueDraft);

  it('drops the oldest projects instead of growing past the cap (100 long names and paths)', async () => {
    const { service, storage, setNow } = createHarness();
    let id = '';
    for (let index = 0; index < 100; index += 1) {
      setNow(`2026-10-04T12:${String(index % 60).padStart(2, '0')}:00.000Z`);
      const result = await expectOk(
        service.receive({
          kind: 'B',
          source: 'hostile.sh',
          errorText: 'same error',
          envInfo: ENV,
          project: { name: `${index}-${NASTY.repeat(49)}`, path: `/${index}/${NASTY.repeat(249)}` },
        }),
      );
      id = result.draft.id;
      expect(bytesOf(storage, id)).toBeLessThanOrEqual(ISSUE_DRAFT_MAX_JSON_BYTES);
    }
    const stored = storage.drafts.get(id) as IssueDraft;
    expect(stored.occurrenceCount).toBe(100);
    // 全部は入らないので古い行から落ちている。いちばん新しいプロジェクトは残る。
    expect(stored.occurredProjects.length).toBeGreaterThan(0);
    expect(stored.occurredProjects.length).toBeLessThan(100);
    expect(stored.occurredProjects.at(-1)?.name.startsWith('99-')).toBe(true);
    expect(stored.occurredProjects.some((entry) => entry.name.startsWith('0-'))).toBe(false);
  });

  it('keeps a 大量発生 draft within the cap with 200 long folded fingerprints plus hostile projects', async () => {
    const { service, storage } = createHarness();
    for (let index = 0; index < ISSUE_DRAFT_NEW_PER_HOUR; index += 1) {
      await expectOk(service.receive({ kind: 'C', source: `ok-${index}`, errorText: 'e', envInfo: ENV }));
    }
    let massId = '';
    for (let index = 0; index < 220; index += 1) {
      const result = await expectOk(
        service.receive({
          kind: 'C',
          source: `${index}-${'あ'.repeat(190)}`,
          errorText: 'e',
          envInfo: ENV,
          project: { name: `${index}-${NASTY.repeat(49)}`, path: `/${index}/${NASTY.repeat(249)}` },
        }),
      );
      expect(result.outcome).toBe('folded');
      massId = result.draft.id;
      expect(bytesOf(storage, massId)).toBeLessThanOrEqual(ISSUE_DRAFT_MAX_JSON_BYTES);
    }
    const stored = storage.drafts.get(massId) as IssueDraft;
    expect(stored.occurrenceCount).toBe(220);
    expect(stored.localOnly.foldedFingerprints).toHaveLength(200);
  });

  it('keeps the cap when a reason is added by dismiss or a count digit is added to a dismissed draft', async () => {
    const { service, storage } = createHarness();
    const input = { kind: 'B', source: 'cap.sh', errorText: 'boom', envInfo: ENV } as const;
    const created = await expectOk(service.receive(input));

    // ちょうど 200KB まで詰めた下書きを仕込む (ASCII で埋めて、バイト数をぴったり合わせる)。
    const empty: IssueDraft = { ...created.draft, localOnly: { ...created.draft.localOnly, errorTextRaw: '' } };
    const pad = ISSUE_DRAFT_MAX_JSON_BYTES - draftJsonBytes(empty);
    const atCap = (extra: Partial<IssueDraft>): IssueDraft => {
      const draft = { ...empty, ...extra, localOnly: { ...empty.localOnly, errorTextRaw: 'x'.repeat(pad) } };
      // 回数などで桁が変わる分は、埋める量で吸収して常にちょうど上限にする。
      const diff = draftJsonBytes(draft) - ISSUE_DRAFT_MAX_JSON_BYTES;
      return { ...draft, localOnly: { ...draft.localOnly, errorTextRaw: 'x'.repeat(pad - diff) } };
    };

    storage.drafts.set(created.draft.id, atCap({}));
    expect(bytesOf(storage, created.draft.id)).toBe(ISSUE_DRAFT_MAX_JSON_BYTES);
    const dismissed = await service.dismiss(created.draft.id, 'う'.repeat(200));
    expect(dismissed.ok).toBe(true);
    expect(bytesOf(storage, created.draft.id)).toBeLessThanOrEqual(ISSUE_DRAFT_MAX_JSON_BYTES);

    // 見送り済みで回数が 9 -> 10 (桁が増えて 1 バイト増える) のとき。
    storage.drafts.set(created.draft.id, atCap({ status: 'dismissed', occurrenceCount: 9 }));
    expect(bytesOf(storage, created.draft.id)).toBe(ISSUE_DRAFT_MAX_JSON_BYTES);
    const again = await expectOk(service.receive(input));
    expect(again.draft.occurrenceCount).toBe(10);
    expect(bytesOf(storage, created.draft.id)).toBeLessThanOrEqual(ISSUE_DRAFT_MAX_JSON_BYTES);
  });
});

describe('list / get', () => {
  it('lists the newest activity first and gets one by id', async () => {
    const { service, setNow } = createHarness();
    const older = await expectOk(service.receive(catalogInput('older')));
    setNow('2026-10-04T12:10:00.000Z');
    const newer = await expectOk(service.receive(catalogInput('newer')));

    const listed = await service.list();
    expect(listed.map((draft) => draft.id)).toEqual([newer.draft.id, older.draft.id]);
    expect(await service.get(older.draft.id)).toEqual(older.draft);
    expect(await service.get('1758812345678-ffffffffffffffff')).toBeUndefined();
  });
});

describe('dismiss', () => {
  it('moves a pending draft to dismissed with the one-line reason', async () => {
    const { service, storage } = createHarness();
    const created = await expectOk(service.receive(catalogInput('slug-d')));
    const result = await service.dismiss(created.draft.id, 'not a harness problem');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.draft.status).toBe('dismissed');
      expect(result.draft.dismissReason).toBe('not a harness problem');
    }
    expect(storage.drafts.get(created.draft.id)?.status).toBe('dismissed');
  });

  it('reports not-found and not-pending distinctly', async () => {
    const { service } = createHarness();
    expect(await service.dismiss('1758812345678-ffffffffffffffff', 'x')).toEqual({
      ok: false,
      reason: 'not-found',
    });
    const created = await expectOk(service.receive(catalogInput('slug-e')));
    await service.dismiss(created.draft.id, 'first');
    expect(await service.dismiss(created.draft.id, 'second')).toEqual({
      ok: false,
      reason: 'not-pending',
      status: 'dismissed',
    });
  });
});

describe('images', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it('attaches, lists and reads an image of an existing draft', async () => {
    const { service } = createHarness();
    const created = await expectOk(service.receive(catalogInput('slug-i')));
    const added = await service.addImage(created.draft.id, 'png', PNG);
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.image.fileName).toMatch(/\.png$/);
    expect((await service.listImages(created.draft.id))?.map((image) => image.fileName)).toEqual([
      added.image.fileName,
    ]);
    expect(await service.readImage(created.draft.id, added.image.fileName)).toEqual(Buffer.from(PNG));
  });

  it('refuses an image for an unknown draft', async () => {
    const { service } = createHarness();
    expect(await service.addImage('1758812345678-ffffffffffffffff', 'png', PNG)).toEqual({
      ok: false,
      reason: 'not-found',
    });
    expect(await service.listImages('1758812345678-ffffffffffffffff')).toBeUndefined();
  });

  it('stops at the per-draft image limit, even for simultaneous uploads', async () => {
    const { service, storage } = createHarness();
    const created = await expectOk(service.receive(catalogInput('slug-limit')));
    const results = await Promise.all(
      Array.from({ length: ISSUE_DRAFT_MAX_IMAGES + 5 }, () => service.addImage(created.draft.id, 'png', PNG)),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(ISSUE_DRAFT_MAX_IMAGES);
    expect(results.filter((result) => !result.ok && result.reason === 'limit-reached')).toHaveLength(5);
    expect(await storage.countImages(created.draft.id)).toBe(ISSUE_DRAFT_MAX_IMAGES);
  });
});

// bdboard-r50m: 受け取りの索引 (最初の受け取りが作る) のキャッシュ。ストアが scan() で「一覧が欠けているかも」
// (complete: false = 未列挙の読み取りエラーで飛ばした下書きがある) と知らせた回の索引は、その回の受け取りには使うが
// キャッシュしない。次の受け取りが読み直す。
describe('receive: the index is cached only when the listing is complete', () => {
  /** in-memory のストアの scan() の complete を、テストから切り替えられるようにする。 */
  function createGappedHarness(listing: { complete: boolean }, existing?: InMemoryIssueDraftStorage) {
    const storage = existing ?? createInMemoryIssueDraftStorage();
    const realScan = storage.scan.bind(storage);
    const scan = vi
      .spyOn(storage, 'scan')
      .mockImplementation(async () => ({ drafts: (await realScan()).drafts, complete: listing.complete }));
    return { ...createHarness(undefined, storage), scan };
  }

  it('an incomplete listing is read again on every receive; a complete one is cached from then on', async () => {
    const listing = { complete: false };
    const { service, scan } = createGappedHarness(listing);

    await service.receive(catalogInput('a'));
    await service.receive(catalogInput('b'));
    await service.receive(catalogInput('c'));
    expect(scan).toHaveBeenCalledTimes(3);

    listing.complete = true;
    await service.receive(catalogInput('d'));
    expect(scan).toHaveBeenCalledTimes(4);
    await service.receive(catalogInput('e'));
    await service.receive(catalogInput('a'));
    expect(scan).toHaveBeenCalledTimes(4);
  });

  it('the receive that sees an incomplete listing still works with what it could read', async () => {
    const seeded = createHarness();
    const first = await expectOk(seeded.service.receive(catalogInput('known')));
    const { service, scan } = createGappedHarness({ complete: false }, seeded.storage);

    const merged = await expectOk(service.receive(catalogInput('known')));
    expect(merged.outcome).toBe('merged');
    expect(merged.draft.id).toBe(first.draft.id);
    expect(merged.draft.occurrenceCount).toBe(2);
    expect((await expectOk(service.receive(catalogInput('other')))).outcome).toBe('created');
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it('what an incomplete pass wrote is found by the next pass (the same fingerprint is not created twice)', async () => {
    const listing = { complete: false };
    const { service, storage } = createGappedHarness(listing);

    const created = await expectOk(service.receive(catalogInput('x')));
    expect(created.outcome).toBe('created');
    listing.complete = true;
    const again = await expectOk(service.receive(catalogInput('x')));
    expect(again.outcome).toBe('merged');
    expect(again.draft.id).toBe(created.draft.id);
    expect(storage.drafts.size).toBe(1);
  });

  it('a rejected scan is not cached either: the next receive reads again', async () => {
    const { service, scan } = createGappedHarness({ complete: true });
    scan.mockRejectedValueOnce(new Error('example scan failure'));

    await expect(service.receive(catalogInput('a'))).rejects.toThrow('example scan failure');
    expect((await expectOk(service.receive(catalogInput('a')))).outcome).toBe('created');
    expect(scan).toHaveBeenCalledTimes(2);
    await service.receive(catalogInput('b'));
    expect(scan).toHaveBeenCalledTimes(2);
  });
});
