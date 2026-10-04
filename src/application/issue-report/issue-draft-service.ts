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
import { draftJsonBytes, fitDraftToByteLimit } from '../../domain/issue-draft-size.js';
import {
  addOccurrence,
  canonicalizeReceiveInput,
  createDraftFromReport,
  foldIntoMassDraft,
  type ReceiveDraftInput,
} from '../../domain/issue-draft-build.js';
import type { IssueDraftStoragePort, StoredDraftImage } from '../ports/issue-draft-storage.js';
import { createDraftRetention, type DraftRetentionOptions } from './issue-draft-retention.js';

export type { ReceiveDraftInput } from '../../domain/issue-draft-build.js';

/**
 * 不具合報告の下書きの受け取りと画面用の読み書き (bdboard-4y8q.1、設計 3・4節)。
 *
 * このサービスは外へ何も送らない: 持っているのは IssueDraftStoragePort (手元のファイル)
 * だけで、gh も bd も呼ばない。投稿は bdboard-4y8q.4 の別の経路。
 */

export type ReceiveDraftResult =
  | { readonly ok: true; readonly outcome: 'created' | 'merged' | 'folded'; readonly draft: IssueDraft }
  | { readonly ok: false; readonly reason: 'missing-identifier' }
  /** issue-drafts の合計容量の上限に収まらない (終端の下書きを消しても足りない)。bdboard-00qh。 */
  | { readonly ok: false; readonly reason: 'storage-full' };

export type DismissDraftResult =
  | { readonly ok: true; readonly draft: IssueDraft }
  | { readonly ok: false; readonly reason: 'not-found' }
  | { readonly ok: false; readonly reason: 'not-pending'; readonly status: DraftStatus };

export type AddDraftImageResult =
  | { readonly ok: true; readonly image: StoredDraftImage }
  | { readonly ok: false; readonly reason: 'not-found' | 'limit-reached' | 'storage-full' }
  /** 画像を足せるのは pending の下書きだけ (見送り・投稿済みには足さない)。bdboard-00qh。 */
  | { readonly ok: false; readonly reason: 'not-pending'; readonly status: DraftStatus };

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
  /**
   * 起動時の掃除: 見送り・投稿済みで保持期限を過ぎた下書きを画像ごと消す (bdboard-00qh)。受け取りのついでの
   * 掃除 (1 時間に 1 回まで) と同じ処理で、こちらは間隔を待たない。失敗しても投げない (警告だけ)。
   */
  pruneOnStart(): Promise<void>;
}

export interface IssueDraftServiceDeps {
  readonly storage: IssueDraftStoragePort;
  /** 受け取りの時刻、保持期限、掃除の間隔の時計。 */
  readonly now: () => Date;
  /** `<epochMs>-<16桁hex>` の形 (domain の isDraftId)。 */
  readonly newId: () => string;
  /** 保持期限・掃除の間隔・合計容量の上限・警告の出力。省略時は domain の既定値 (30 日・1 時間・1 GiB)。 */
  readonly retention?: DraftRetentionOptions;
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
  const retention = createDraftRetention({ ...deps.retention, storage: deps.storage, now: deps.now });
  const storageFull = { ok: false, reason: 'storage-full' } as const;
  let indexPromise: Promise<DraftIndex> | undefined;

  /**
   * 合計容量の上限に収まるときだけ書く (収まらなければ false で、何も書かない)。previous は上書きされる前の
   * 下書きで、差分 (新しい大きさ - 古い大きさ) だけを数える。上書きする下書き自身は、容量を空けるために
   * 消す候補から外す (消すと画像まで失い、draft.json だけが書き戻る)。
   */
  async function saveWithinCap(draft: IssueDraft, previous: IssueDraft | undefined): Promise<boolean> {
    const delta = draftJsonBytes(draft) - (previous === undefined ? 0 : draftJsonBytes(previous));
    if (!(await retention.ensureRoom(delta, previous?.id))) return false;
    await deps.storage.save(draft);
    retention.recordWrite(delta);
    return true;
  }

  async function loadIndex(): Promise<{ readonly index: DraftIndex; readonly complete: boolean }> {
    const listing = await deps.storage.scan();
    const drafts = [...listing.drafts].sort((a, b) =>
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
    return { index: { idByFingerprint, newDraftsByHour }, complete: listing.complete };
  }

  /**
   * 起動後の最初の受け取りで一度だけ保存済みの下書きを読み、以後は書いた分をメモリで足す。
   * 読むのに失敗したとき、またはあとで読めるかもしれない理由 (未列挙のエラー、再試行を使い切った
   * ファイル単位の失敗) で飛ばした下書きがあって一覧が欠けているとき (complete: false) は、キャッシュ
   * しない。欠けた索引を使い続けると既知の指紋が新規として二重に作られるので、次の受け取りでもう一度
   * 全件を読み直す (その回の受け取りには欠けた索引を使う)。
   * `indexPromise === loading` の照合は念のための保険: getIndex は receive の中でしか呼ばれず、receive は
   * mutex で 1 本ずつ直列なので、読み込み中に別の読み込みが indexPromise を置き換えることは今は無い。
   */
  function getIndex(): Promise<DraftIndex> {
    if (indexPromise !== undefined) return indexPromise;
    const loading: Promise<DraftIndex> = loadIndex().then(
      ({ index, complete }) => {
        if (!complete && indexPromise === loading) indexPromise = undefined;
        return index;
      },
      (error: unknown) => {
        if (indexPromise === loading) indexPromise = undefined;
        throw error;
      },
    );
    indexPromise = loading;
    return loading;
  }

  async function receiveLocked(rawInput: ReceiveDraftInput): Promise<ReceiveDraftResult> {
    // 指紋より前に、source・catalogSlug のユーザーのホームのパスを畳む (トンネルの読み手へ名前を出さない)。
    const input = canonicalizeReceiveInput(rawInput);
    const fingerprint = computeDraftFingerprint(input);
    if (fingerprint === undefined) return { ok: false, reason: 'missing-identifier' };

    // 期限切れの掃除 (1 時間に 1 回まで。失敗しても受け取りは続ける)。索引を読む前に済ませる。
    await retention.pruneIfDue();
    const index = await getIndex();
    const now = deps.now();
    const nowIso = now.toISOString();

    const knownId = index.idByFingerprint.get(fingerprint);
    const known = knownId === undefined ? undefined : await deps.storage.get(knownId);
    if (known !== undefined) {
      const merged = addOccurrence(known, input, nowIso);
      if (!(await saveWithinCap(merged, known))) return storageFull;
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
      if (!(await saveWithinCap(folded, existingMass))) return storageFull;
      index.idByFingerprint.set(massFingerprint, folded.id);
      return { ok: true, outcome: 'folded', draft: folded };
    }

    const draft = createDraftFromReport(input, { id: deps.newId(), fingerprint, nowIso });
    if (!(await saveWithinCap(draft, undefined))) return storageFull;
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
        // 見送りは利用者の操作なので、容量の上限では断らない (見送ると、あとで容量を空けられる下書きが増える)。
        await deps.storage.save(dismissed);
        retention.recordWrite(draftJsonBytes(dismissed) - draftJsonBytes(draft));
        // 空けられる (終端の) 下書きが増えた: 上限に張り付いて伸びた測り直しの間隔を戻す (bdboard-krvf)。
        retention.noteFreeableDraft();
        return { ok: true, draft: dismissed };
      }),

    addImage: (id, extension, data) =>
      exclusive(async (): Promise<AddDraftImageResult> => {
        const draft = isDraftId(id) ? await deps.storage.get(id) : undefined;
        if (draft === undefined) return { ok: false, reason: 'not-found' };
        // 見送り・投稿済みの下書きには足さない (期限が来れば画像ごと消える下書きに、画像だけ増やさせない)。
        if (draft.status !== 'pending') return { ok: false, reason: 'not-pending', status: draft.status };
        if ((await deps.storage.countImages(id)) >= ISSUE_DRAFT_MAX_IMAGES) {
          return { ok: false, reason: 'limit-reached' };
        }
        if (!(await retention.ensureRoom(data.byteLength, id))) return storageFull;
        const image = await deps.storage.saveImage(id, extension, data);
        retention.recordWrite(image.byteLength);
        return { ok: true, image };
      }),

    pruneOnStart: () => exclusive(() => retention.pruneNow()),

    async listImages(id) {
      if (!isDraftId(id) || (await deps.storage.get(id)) === undefined) return undefined;
      return deps.storage.listImages(id);
    },

    async readImage(id, fileName) {
      return isDraftId(id) ? deps.storage.readImage(id, fileName) : undefined;
    },
  };
}
