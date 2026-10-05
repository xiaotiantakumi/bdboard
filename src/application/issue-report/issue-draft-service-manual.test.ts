import { describe, expect, it } from 'vitest';
import { ISSUE_DRAFT_NEW_PER_HOUR, isMassOccurrenceFingerprint } from '../../domain/issue-draft.js';
import { ISSUE_DRAFT_MANUAL_PER_HOUR, isManualFingerprint } from '../../domain/issue-draft-manual.js';
import { draftJsonBytes } from '../../domain/issue-draft-size.js';
import type { DraftRetentionOptions } from './issue-draft-retention.js';
import { createIssueDraftService, type IssueDraftService } from './issue-draft-service.js';
import { createInMemoryIssueDraftStorage, type InMemoryIssueDraftStorage } from './issue-draft-test-support.js';

/**
 * bdboard-4y8q.6.7: 人が手で書く下書き (createManual)。まとめない・自動の 20 件/時の枠を共有しない・別の枠 (既定 20 件/時) で数える。
 * 各テストは、同じ保存先と時計の上に新しいサービスを立てて「再起動のあと」も確かめられる (base)。
 */

const START = '2026-10-04T12:00:00.000Z';
const HOUR_MS = 60 * 60 * 1000;
const ENV = { bdboardVersion: '0.1.2', os: 'darwin', nodeVersion: 'v22.14.0' };

interface Harness {
  readonly service: IssueDraftService;
  readonly storage: InMemoryIssueDraftStorage;
  readonly clock: { current: Date };
  advance(ms: number): void;
}

let idSeq = 0;

function createHarness(base?: Harness, retention?: DraftRetentionOptions, envInfo = true): Harness {
  const clock = base?.clock ?? { current: new Date(START) };
  const storage = base?.storage ?? createInMemoryIssueDraftStorage(() => new Date(clock.current));
  const service = createIssueDraftService({
    storage,
    now: () => new Date(clock.current),
    newId: () => `${1758812345000 + (idSeq += 1)}-${idSeq.toString(16).padStart(16, '0')}`,
    ...(envInfo ? { envInfo: () => ENV } : {}),
    ...(retention !== undefined ? { retention } : {}),
  });
  return { service, storage, clock, advance: (ms) => { clock.current = new Date(clock.current.getTime() + ms); } };
}

async function manual(service: IssueDraftService, title = 'The board hangs', description = 'it froze when I opened the tab') {
  return service.createManual({ title, description });
}

async function manualOk(service: IssueDraftService, title?: string, description?: string) {
  const result = await manual(service, title, description);
  if (!result.ok) throw new Error(`createManual failed: ${result.reason}`);
  return result.draft;
}

async function receiveA(service: IssueDraftService, slug: string) {
  const result = await service.receive({ kind: 'A', catalogSlug: slug, symptom: 'symptom', envInfo: ENV });
  if (!result.ok) throw new Error(`receive failed: ${result.reason}`);
  return result;
}

describe('createManual: what is stored', () => {
  it('stores a pending kind C draft: random manual fingerprint, edited title, agent note, server-filled envInfo', async () => {
    const { service, storage } = createHarness();
    const result = await manual(service, 'My report', 'steps to reproduce');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const draft = result.draft;

    expect(draft).toMatchObject({ kind: 'C', source: 'manual', status: 'pending', occurrenceCount: 1, title: 'My report', titleEditedByUser: true, bodyEditedByUser: false });
    expect(draft.fingerprint).toMatch(/^C:manual:[0-9a-f]{16}$/);
    expect(draft.localOnly.agentNoteRaw).toBe('steps to reproduce');
    expect(draft.localOnly.envInfo).toEqual(ENV);
    expect(storage.drafts.get(draft.id)).toEqual(draft);
    // 説明は暫定の公開本文に入らない。
    expect(draft.body).not.toContain('steps to reproduce');
  });

  it('fills the environment with unknown when the service has no envInfo source', async () => {
    const { service } = createHarness(undefined, undefined, false);
    const draft = await manualOk(service);
    expect(draft.localOnly.envInfo).toEqual({ bdboardVersion: 'unknown', os: 'unknown', nodeVersion: 'unknown' });
  });

  it('stores the same text sent twice as two separate drafts (never merged, count stays 1)', async () => {
    const { service, storage } = createHarness();
    const first = await manualOk(service, 'same title', 'same description');
    const second = await manualOk(service, 'same title', 'same description');
    expect(second.id).not.toBe(first.id);
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(storage.drafts.size).toBe(2);
    expect([first.occurrenceCount, second.occurrenceCount]).toEqual([1, 1]);
  });

  it('counts the new draft as pending, also when the pending count was already read before', async () => {
    const { service } = createHarness();
    expect(await service.pendingCount()).toBe(0);
    await manualOk(service);
    expect(await service.pendingCount()).toBe(1);
  });
});

describe('createManual: the manual limit (default 20 per hour, rolling)', () => {
  it('creates 20 drafts and refuses the 21st with rate-limited, storing nothing more', async () => {
    const { service, storage } = createHarness();
    for (let n = 0; n < ISSUE_DRAFT_MANUAL_PER_HOUR; n += 1) await manualOk(service, `title ${n}`);
    expect(storage.drafts.size).toBe(ISSUE_DRAFT_MANUAL_PER_HOUR);

    expect(await manual(service)).toEqual({ ok: false, reason: 'rate-limited' });
    expect(storage.drafts.size).toBe(ISSUE_DRAFT_MANUAL_PER_HOUR);
  });

  it('keeps counting after a restart (a new service over the same storage reads the list)', async () => {
    const base = createHarness();
    for (let n = 0; n < ISSUE_DRAFT_MANUAL_PER_HOUR; n += 1) await manualOk(base.service, `title ${n}`);
    const restarted = createHarness(base);
    expect(await manual(restarted.service)).toEqual({ ok: false, reason: 'rate-limited' });
  });

  it('counts drafts created within the last 60 minutes: allows again once they are older than an hour', async () => {
    const h = createHarness();
    for (let n = 0; n < ISSUE_DRAFT_MANUAL_PER_HOUR; n += 1) await manualOk(h.service, `title ${n}`);

    h.advance(HOUR_MS - 1);
    expect(await manual(h.service)).toEqual({ ok: false, reason: 'rate-limited' });
    h.advance(1); // ちょうど 1 時間前は、まだ 1 時間以内
    expect(await manual(h.service)).toEqual({ ok: false, reason: 'rate-limited' });
    h.advance(1);
    expect((await manual(h.service)).ok).toBe(true);
  });

  it('is not locked out after the clock goes back (drafts dated in the future are outside the window)', async () => {
    const h = createHarness();
    for (let n = 0; n < ISSUE_DRAFT_MANUAL_PER_HOUR; n += 1) await manualOk(h.service, `title ${n}`);
    h.advance(-2 * 24 * HOUR_MS);
    expect((await manual(h.service)).ok).toBe(true);
  });

  it('counts inside the mutex: concurrent requests never create more than the limit', async () => {
    const { service, storage } = createHarness();
    const results = await Promise.all(
      Array.from({ length: ISSUE_DRAFT_MANUAL_PER_HOUR + 5 }, (_, n) => manual(service, `title ${n}`)),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(ISSUE_DRAFT_MANUAL_PER_HOUR);
    expect(results.filter((result) => !result.ok && result.reason === 'rate-limited')).toHaveLength(5);
    expect(storage.drafts.size).toBe(ISSUE_DRAFT_MANUAL_PER_HOUR);
  });

  it('counts dismissed manual drafts too (the limit is on how many were created)', async () => {
    const { service } = createHarness();
    const drafts = [];
    for (let n = 0; n < ISSUE_DRAFT_MANUAL_PER_HOUR; n += 1) drafts.push(await manualOk(service, `title ${n}`));
    await service.dismiss(drafts[0]?.id ?? '', 'duplicate');
    expect(await manual(service)).toEqual({ ok: false, reason: 'rate-limited' });
  });
});

describe('createManual: the automatic 20 per hour is not shared', () => {
  it('lets an automatic receive create a new draft after 20 manual drafts', async () => {
    const { service, storage } = createHarness();
    for (let n = 0; n < ISSUE_DRAFT_MANUAL_PER_HOUR; n += 1) await manualOk(service, `title ${n}`);

    const result = await receiveA(service, 'slug-a');
    expect(result.outcome).toBe('created');
    expect(isMassOccurrenceFingerprint(result.draft.fingerprint)).toBe(false);
    expect(storage.drafts.size).toBe(ISSUE_DRAFT_MANUAL_PER_HOUR + 1);
  });

  it('lets automatic receives create 20 new drafts after 20 manual drafts, and folds only the 21st automatic one', async () => {
    const { service } = createHarness();
    for (let n = 0; n < ISSUE_DRAFT_MANUAL_PER_HOUR; n += 1) await manualOk(service, `title ${n}`);
    for (let n = 0; n < ISSUE_DRAFT_NEW_PER_HOUR; n += 1) expect((await receiveA(service, `slug-${n}`)).outcome).toBe('created');
    expect((await receiveA(service, 'slug-over')).outcome).toBe('folded');
  });

  it('does not share the limit after a restart either (the rebuilt index does not count manual drafts)', async () => {
    const base = createHarness();
    for (let n = 0; n < ISSUE_DRAFT_MANUAL_PER_HOUR; n += 1) await manualOk(base.service, `title ${n}`);
    const restarted = createHarness(base);
    for (let n = 0; n < ISSUE_DRAFT_NEW_PER_HOUR; n += 1) expect((await receiveA(restarted.service, `slug-${n}`)).outcome).toBe('created');
    expect((await receiveA(restarted.service, 'slug-over')).outcome).toBe('folded');
  });

  it('creates a manual draft of its own when the automatic limit is used up (never folded into the mass-occurrence draft)', async () => {
    const { service, storage } = createHarness();
    for (let n = 0; n < ISSUE_DRAFT_NEW_PER_HOUR; n += 1) await receiveA(service, `slug-${n}`);
    expect((await receiveA(service, 'slug-over')).outcome).toBe('folded');
    const before = storage.drafts.size;

    const draft = await manualOk(service, 'mine', 'my own report');
    expect(isManualFingerprint(draft.fingerprint)).toBe(true);
    expect(draft.occurrenceCount).toBe(1);
    expect(storage.drafts.size).toBe(before + 1);
    // 「大量発生」の下書きは、手書きを数えない・取り込まない。
    const mass = [...storage.drafts.values()].filter((entry) => isMassOccurrenceFingerprint(entry.fingerprint));
    expect(mass).toHaveLength(1);
    expect(mass[0]?.occurrenceCount).toBe(1);
    expect(mass[0]?.localOnly.foldedFingerprints).toEqual(['A:slug-over']);
  });
});

describe('createManual: the total size cap', () => {
  it('refuses with storage-full when the draft does not fit (open drafts are never freed), storing nothing', async () => {
    const base = createHarness();
    await manualOk(base.service, 'open one');
    const total = [...base.storage.drafts.values()].reduce((sum, draft) => sum + draftJsonBytes(draft), 0);
    const h = createHarness(base, { maxTotalBytes: total });

    expect(await manual(h.service, 'does not fit')).toEqual({ ok: false, reason: 'storage-full' });
    expect(base.storage.drafts.size).toBe(1);
  });
});
