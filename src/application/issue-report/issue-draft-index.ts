import { hourBucketOf, isMassOccurrenceFingerprint, type DraftStatus, type IssueDraft } from '../../domain/issue-draft.js';
import type { DraftIndexEntry, DraftIndexSeed, IssueDraftStoragePort } from '../ports/issue-draft-storage.js';

/**
 * 受け取りの索引 (bdboard-4y8q.1) と未処理件数 (bdboard-4y8q.3.1)。保存済みの下書きを一度だけ読み、以後は書いた分を
 * メモリで足す。呼び出しはすべてサービスの mutex の内側で 1 本ずつ流れる前提。掃除の棚卸しからも作れる (seed)。
 *
 * 未処理件数は statusById から数える: タブのバッジとデイリーダイジェストが開くたびに全件の draft.json を読み直さない
 * (docs/ISSUE-REPORTING.md 4節「索引ファイルは作らない」の全件読みを、起動後の最初の 1 回にとどめる)。
 * 割り切り: 手で消された pending の下書きは、受け取りがその指紋で作り直すか、再起動するまで数に残る。期限と容量の掃除が
 * 消すのは終端 (見送り・投稿済み) だけなので、掃除は未処理件数を変えない。
 */

export interface DraftIndex {
  /** 指紋 -> 下書き id。同じ指紋が複数あれば firstOccurredAt が新しいほうを指す。 */
  readonly idByFingerprint: Map<string, string>;
  /** 暦時間バケツ -> その時間に作られた個別の下書きの数 (「大量発生」は数えない)。 */
  readonly newDraftsByHour: Map<string, number>;
  /** 下書き id -> 状態。未処理 (pending) の件数を数える。 */
  readonly statusById: Map<string, DraftStatus>;
}

export interface DraftIndexCache {
  /** 索引。まだ読んでいなければ (または前回の一覧が欠けていたら) 全件を読む。 */
  get(): Promise<DraftIndex>;
  /** 読み込み済みの索引。読んでいなければ undefined (読み込みは起こさない)。 */
  loaded(): Promise<DraftIndex | undefined>;
  /** 完全な棚卸しから索引を作る。読み込み中・読み込み済みなら上書きしない。 */
  seed(seed: DraftIndexSeed, withoutIds?: ReadonlySet<string>): void;
}

export function countPending(index: DraftIndex): number {
  let count = 0;
  for (const status of index.statusById.values()) if (status === 'pending') count += 1;
  return count;
}

/** 書いた下書きを索引に反映する (状態だけ。指紋とバケツは書いた側が足す)。 */
export function noteDraftStatus(index: DraftIndex, draft: IssueDraft): void {
  index.statusById.set(draft.id, draft.status);
}

export function buildIndex(entries: readonly DraftIndexEntry[]): DraftIndex {
  const drafts = [...entries].sort((a, b) =>
    a.firstOccurredAt < b.firstOccurredAt ? -1 : a.firstOccurredAt > b.firstOccurredAt ? 1 : 0,
  );
  const idByFingerprint = new Map<string, string>();
  const newDraftsByHour = new Map<string, number>();
  const statusById = new Map<string, DraftStatus>();
  for (const draft of drafts) {
    idByFingerprint.set(draft.fingerprint, draft.id);
    statusById.set(draft.id, draft.status);
    if (!isMassOccurrenceFingerprint(draft.fingerprint)) {
      const bucket = hourBucketOf(new Date(draft.firstOccurredAt));
      newDraftsByHour.set(bucket, (newDraftsByHour.get(bucket) ?? 0) + 1);
    }
  }
  return { idByFingerprint, newDraftsByHour, statusById };
}

async function loadIndex(storage: Pick<IssueDraftStoragePort, 'scan'>): Promise<{ readonly index: DraftIndex; readonly complete: boolean }> {
  const listing = await storage.scan();
  return { index: buildIndex(listing.drafts), complete: listing.complete };
}

/**
 * 起動後の最初の呼び出しで一度だけ保存済みの下書きを読み、以後は同じ索引を返す。
 * 読むのに失敗したとき、またはあとで読めるかもしれない理由 (未列挙のエラー、再試行を使い切った
 * ファイル単位の失敗) で飛ばした下書きがあって一覧が欠けているとき (complete: false) は、キャッシュ
 * しない。欠けた索引を使い続けると既知の指紋が新規として二重に作られるので、次の呼び出しでもう一度
 * 全件を読み直す (その回には欠けた索引を使う)。
 * `indexPromise === loading` の照合は念のための保険: get は mutex の内側でしか呼ばれないので、読み込み中に
 * 別の読み込みが indexPromise を置き換えることは今は無い。
 */
export function createDraftIndexCache(storage: Pick<IssueDraftStoragePort, 'scan'>): DraftIndexCache {
  let indexPromise: Promise<DraftIndex> | undefined;
  return {
    get() {
      if (indexPromise !== undefined) return indexPromise;
      const loading: Promise<DraftIndex> = loadIndex(storage).then(
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
    },
    async loaded() {
      return indexPromise === undefined ? undefined : indexPromise;
    },
    seed(seed, withoutIds) {
      if (indexPromise !== undefined || !seed.complete) return;
      try {
        const entries = withoutIds === undefined ? seed.entries : seed.entries.filter((entry) => !withoutIds.has(entry.id));
        indexPromise = Promise.resolve(buildIndex(entries));
      } catch {
        // 次の get() が scan() で読み直し、同じ失敗はそちらで表に出る。
      }
    },
  };
}
