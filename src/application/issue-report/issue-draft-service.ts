import {
  ISSUE_DRAFT_MAX_IMAGES,
  ISSUE_DRAFT_NEW_PER_HOUR,
  computeDraftFingerprint,
  hourBucketOf,
  isDraftId,
  isMassOccurrenceFingerprint,
  massOccurrenceFingerprint,
  type DraftStatus,
  type IssueDraft,
} from '../../domain/issue-draft.js';
import { fitDraftToByteLimit } from '../../domain/issue-draft-size.js';
import {
  addOccurrence,
  createDraftFromReport,
  foldIntoMassDraft,
  type ReceiveDraftInput,
} from '../../domain/issue-draft-build.js';
import type { IssueDraftStoragePort, StoredDraftImage } from '../ports/issue-draft-storage.js';

export type { ReceiveDraftInput } from '../../domain/issue-draft-build.js';

/**
 * 不具合報告の下書きの受け取りと画面用の読み書き (bdboard-4y8q.1、設計 3・4節)。
 *
 * このサービスは外へ何も送らない: 持っているのは IssueDraftStoragePort (手元のファイル)
 * だけで、gh も bd も呼ばない。投稿は bdboard-4y8q.4 の別の経路。
 */

export type ReceiveDraftResult =
  | { readonly ok: true; readonly outcome: 'created' | 'merged' | 'folded'; readonly draft: IssueDraft }
  | { readonly ok: false; readonly reason: 'missing-identifier' };

export type DismissDraftResult =
  | { readonly ok: true; readonly draft: IssueDraft }
  | { readonly ok: false; readonly reason: 'not-found' }
  | { readonly ok: false; readonly reason: 'not-pending'; readonly status: DraftStatus };

export type AddDraftImageResult =
  | { readonly ok: true; readonly image: StoredDraftImage }
  | { readonly ok: false; readonly reason: 'not-found' | 'limit-reached' };

export interface IssueDraftService {
  receive(input: ReceiveDraftInput): Promise<ReceiveDraftResult>;
  /** 最後に起きた時刻の新しい順。 */
  list(): Promise<readonly IssueDraft[]>;
  get(id: string): Promise<IssueDraft | undefined>;
  dismiss(id: string, reason: string): Promise<DismissDraftResult>;
  addImage(id: string, extension: string, data: Uint8Array): Promise<AddDraftImageResult>;
  /** 下書きが無ければ undefined。 */
  listImages(id: string): Promise<readonly StoredDraftImage[] | undefined>;
  readImage(id: string, fileName: string): Promise<Buffer | undefined>;
}

export interface IssueDraftServiceDeps {
  readonly storage: IssueDraftStoragePort;
  readonly now: () => Date;
  /** `<epochMs>-<16桁hex>` の形 (domain の isDraftId)。 */
  readonly newId: () => string;
}

interface DraftIndex {
  /** 指紋 -> 下書き id。同じ指紋が複数あれば firstOccurredAt が新しいほうを指す。 */
  readonly idByFingerprint: Map<string, string>;
  /** 暦時間バケツ -> その時間に作られた個別の下書きの数 (「大量発生」は数えない)。 */
  readonly newDraftsByHour: Map<string, number>;
}

/** 呼び出しを 1 本ずつ直列に流す。受け取り・見送り・画像追加の「確認してから書く」を割り込ませない。 */
function createMutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (fn) => {
    const result = tail.then(fn);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

function compareNewestFirst(a: IssueDraft, b: IssueDraft): number {
  if (a.lastOccurredAt !== b.lastOccurredAt) return a.lastOccurredAt < b.lastOccurredAt ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export function createIssueDraftService(deps: IssueDraftServiceDeps): IssueDraftService {
  const exclusive = createMutex();
  let indexPromise: Promise<DraftIndex> | undefined;

  async function loadIndex(): Promise<DraftIndex> {
    const drafts = [...(await deps.storage.list())].sort((a, b) =>
      a.firstOccurredAt < b.firstOccurredAt ? -1 : a.firstOccurredAt > b.firstOccurredAt ? 1 : 0,
    );
    const idByFingerprint = new Map<string, string>();
    const newDraftsByHour = new Map<string, number>();
    for (const draft of drafts) {
      idByFingerprint.set(draft.fingerprint, draft.id);
      if (!isMassOccurrenceFingerprint(draft.fingerprint)) {
        const bucket = hourBucketOf(new Date(draft.firstOccurredAt));
        newDraftsByHour.set(bucket, (newDraftsByHour.get(bucket) ?? 0) + 1);
      }
    }
    return { idByFingerprint, newDraftsByHour };
  }

  /** 起動後の最初の受け取りで一度だけ保存済みの下書きを読み、以後は書いた分をメモリで足す。 */
  function getIndex(): Promise<DraftIndex> {
    indexPromise ??= loadIndex().catch((error: unknown) => {
      indexPromise = undefined;
      throw error;
    });
    return indexPromise;
  }

  async function receiveLocked(input: ReceiveDraftInput): Promise<ReceiveDraftResult> {
    const fingerprint = computeDraftFingerprint(input);
    if (fingerprint === undefined) return { ok: false, reason: 'missing-identifier' };

    const index = await getIndex();
    const now = deps.now();
    const nowIso = now.toISOString();

    const knownId = index.idByFingerprint.get(fingerprint);
    const known = knownId === undefined ? undefined : await deps.storage.get(knownId);
    if (known !== undefined) {
      const merged = addOccurrence(known, input, nowIso);
      await deps.storage.save(merged);
      return { ok: true, outcome: 'merged', draft: merged };
    }
    // 索引にあるのにディスクに無いのは、手で消されたとき。新しい下書きとして作り直す。
    index.idByFingerprint.delete(fingerprint);

    const bucket = hourBucketOf(now);
    if ((index.newDraftsByHour.get(bucket) ?? 0) >= ISSUE_DRAFT_NEW_PER_HOUR) {
      const massFingerprint = massOccurrenceFingerprint(input.kind, now);
      const massId = index.idByFingerprint.get(massFingerprint);
      const existingMass = massId === undefined ? undefined : await deps.storage.get(massId);
      const folded = foldIntoMassDraft(existingMass, input, {
        id: deps.newId(),
        massFingerprint,
        foldedFingerprint: fingerprint,
        nowIso,
      });
      await deps.storage.save(folded);
      index.idByFingerprint.set(massFingerprint, folded.id);
      return { ok: true, outcome: 'folded', draft: folded };
    }

    const draft = createDraftFromReport(input, { id: deps.newId(), fingerprint, nowIso });
    await deps.storage.save(draft);
    index.idByFingerprint.set(fingerprint, draft.id);
    index.newDraftsByHour.set(bucket, (index.newDraftsByHour.get(bucket) ?? 0) + 1);
    return { ok: true, outcome: 'created', draft };
  }

  return {
    receive: (input) => exclusive(() => receiveLocked(input)),

    async list() {
      return [...(await deps.storage.list())].sort(compareNewestFirst);
    },

    async get(id) {
      return isDraftId(id) ? deps.storage.get(id) : undefined;
    },

    dismiss: (id, reason) =>
      exclusive(async (): Promise<DismissDraftResult> => {
        const draft = isDraftId(id) ? await deps.storage.get(id) : undefined;
        if (draft === undefined) return { ok: false, reason: 'not-found' };
        if (draft.status !== 'pending') return { ok: false, reason: 'not-pending', status: draft.status };
        // 理由のぶんだけ大きくなるので、200KB の上限はここでもかける。
        const dismissed = fitDraftToByteLimit({ ...draft, status: 'dismissed', dismissReason: reason });
        await deps.storage.save(dismissed);
        return { ok: true, draft: dismissed };
      }),

    addImage: (id, extension, data) =>
      exclusive(async (): Promise<AddDraftImageResult> => {
        if (!isDraftId(id) || (await deps.storage.get(id)) === undefined) {
          return { ok: false, reason: 'not-found' };
        }
        if ((await deps.storage.countImages(id)) >= ISSUE_DRAFT_MAX_IMAGES) {
          return { ok: false, reason: 'limit-reached' };
        }
        return { ok: true, image: await deps.storage.saveImage(id, extension, data) };
      }),

    async listImages(id) {
      if (!isDraftId(id) || (await deps.storage.get(id)) === undefined) return undefined;
      return deps.storage.listImages(id);
    },

    async readImage(id, fileName) {
      return isDraftId(id) ? deps.storage.readImage(id, fileName) : undefined;
    },
  };
}
