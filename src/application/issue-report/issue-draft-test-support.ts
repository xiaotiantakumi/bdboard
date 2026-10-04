/**
 * bdboard-4y8q.1: IssueDraftStoragePort のテスト用 in-memory fake。
 * *-test-support.ts なので本番コードからの import は src/test-support-import-guard.test.ts が止める。
 *
 * 保存・取得のたびに structuredClone して「ディスクに書いて読み直す」ことを模す
 * (呼び出し側が返り値を書き換えても保存済みの下書きが変わらない)。
 */
import type { IssueDraft } from '../../domain/issue-draft.js';
import { draftJsonBytes } from '../../domain/issue-draft-size.js';
import type { DraftFootprint } from '../../domain/issue-draft-retention.js';
import type {
  IssueDraftStoragePort,
  StoredDraftImage,
} from '../ports/issue-draft-storage.js';

export interface InMemoryIssueDraftStorage extends IssueDraftStoragePort {
  /** テストから直接見る・仕込むための保存内容 (id -> draft)。 */
  readonly drafts: Map<string, IssueDraft>;
  readonly images: Map<string, Map<string, { entry: StoredDraftImage; data: Buffer }>>;
  /**
   * draft.json の最終更新時刻 (id -> ms)。save のたびに now() になる。テストが古く仕込める (bdboard-00qh)。
   * `drafts` へ直接足した下書きはここに無く、survey が `known` なしで返す (= 自動では消えない)。
   */
  readonly updatedAtMs: Map<string, number>;
  /** 読めない下書き (survey が `known` なしで返す = 状態が分からない)。bdboard-00qh。 */
  readonly unreadable: Set<string>;
}

export function createInMemoryIssueDraftStorage(
  now: () => Date = () => new Date('2026-10-04T12:00:00.000Z'),
): InMemoryIssueDraftStorage {
  const drafts = new Map<string, IssueDraft>();
  const images = new Map<string, Map<string, { entry: StoredDraftImage; data: Buffer }>>();
  const updatedAtMs = new Map<string, number>();
  const unreadable = new Set<string>();
  let imageSeq = 0;

  function imageBytes(id: string): number {
    return [...(images.get(id)?.values() ?? [])].reduce((sum, image) => sum + image.data.byteLength, 0);
  }

  return {
    drafts,
    images,
    updatedAtMs,
    unreadable,
    async list() {
      return [...drafts.values()].map((draft) => structuredClone(draft));
    },
    async scan() {
      return { drafts: [...drafts.values()].map((draft) => structuredClone(draft)), complete: true };
    },
    async survey() {
      const footprints: DraftFootprint[] = [...drafts.values()].map((draft) => {
        const bytes = draftJsonBytes(draft) + imageBytes(draft.id);
        const updated = updatedAtMs.get(draft.id);
        return unreadable.has(draft.id) || updated === undefined
          ? { id: draft.id, bytes }
          : { id: draft.id, bytes, known: { status: draft.status, updatedAtMs: updated } };
      });
      return { drafts: footprints, totalBytes: footprints.reduce((sum, item) => sum + item.bytes, 0), unmeasured: [] };
    },
    async remove(id) {
      drafts.delete(id);
      images.delete(id);
      updatedAtMs.delete(id);
    },
    async get(id) {
      const draft = drafts.get(id);
      return draft === undefined || unreadable.has(id) ? undefined : structuredClone(draft);
    },
    async save(draft) {
      drafts.set(draft.id, structuredClone(draft));
      updatedAtMs.set(draft.id, now().getTime());
    },
    async countImages(id) {
      return images.get(id)?.size ?? 0;
    },
    async saveImage(id, extension, data) {
      imageSeq += 1;
      const fileName = `${1758300000000 + imageSeq}-${imageSeq.toString(16).padStart(16, '0')}.${extension}`;
      const entry: StoredDraftImage = { fileName, byteLength: data.byteLength, createdAt: now() };
      const forDraft = images.get(id) ?? new Map();
      forDraft.set(fileName, { entry, data: Buffer.from(data) });
      images.set(id, forDraft);
      return entry;
    },
    async listImages(id) {
      return [...(images.get(id)?.values() ?? [])].map((value) => value.entry);
    },
    async readImage(id, fileName) {
      return images.get(id)?.get(fileName)?.data;
    },
  };
}
