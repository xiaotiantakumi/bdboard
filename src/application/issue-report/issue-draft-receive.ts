import {
  ISSUE_DRAFT_NEW_PER_HOUR,
  computeDraftFingerprint,
  hourBucketOf,
  massOccurrenceFingerprint,
  type IssueDraft,
} from '../../domain/issue-draft.js';
import {
  addOccurrence,
  canonicalizeReceiveInput,
  createDraftFromReport,
  foldIntoMassDraft,
  type ReceiveDraftInput,
} from '../../domain/issue-draft-build.js';
import type { IssueDraftStoragePort } from '../ports/issue-draft-storage.js';
import { forgetDrafts, noteDraftStatus, type DraftIndexCache } from './issue-draft-index.js';

/*
 * サービスの mutex の内側で動く、受け取りの統合・新規作成・大量発生への丸め込み。
 * サービスから exclusive(() => ...) で呼ぶ前提で、外へ何も送らない。
 */

export type ReceiveDraftResult =
  | { readonly ok: true; readonly outcome: 'created' | 'merged' | 'folded'; readonly draft: IssueDraft }
  | { readonly ok: false; readonly reason: 'missing-identifier' }
  /** issue-drafts の合計容量の上限に収まらない (終端の下書きを消しても足りない)。bdboard-00qh。 */
  | { readonly ok: false; readonly reason: 'storage-full' };

export interface DraftReceiveContext {
  /** 下書きの読み取り。 */
  readonly storage: Pick<IssueDraftStoragePort, 'get'>;
  /** 受け取り用の索引キャッシュ。 */
  readonly indexCache: Pick<DraftIndexCache, 'get'>;
  /** 期限切れの下書きを必要に応じて掃除する。 */
  readonly pruneIfDue: () => Promise<void>;
  /** 合計容量の上限を確認して下書きを保存する。 */
  readonly saveWithinCap: (draft: IssueDraft, previous: IssueDraft | undefined) => Promise<boolean>;
  /** 受け取り時刻を返す。 */
  readonly now: () => Date;
  /** 下書き ID を生成する。 */
  readonly newId: () => string;
}

const storageFull = { ok: false, reason: 'storage-full' } as const;

export async function receiveDraftLocked(
  ctx: DraftReceiveContext,
  rawInput: ReceiveDraftInput,
): Promise<ReceiveDraftResult> {
  // 指紋より前に、source・catalogSlug のユーザーのホームのパスを畳む (トンネルの読み手へ名前を出さない)。
  const input = canonicalizeReceiveInput(rawInput);
  const fingerprint = computeDraftFingerprint(input);
  if (fingerprint === undefined) return { ok: false, reason: 'missing-identifier' };

  // 期限切れの掃除 (1 時間に 1 回まで。失敗しても受け取りは続ける)。掃除の棚卸しが索引も作るので、その後に読む。
  await ctx.pruneIfDue();
  const index = await ctx.indexCache.get();
  const now = ctx.now();
  const nowIso = now.toISOString();

  const knownId = index.idByFingerprint.get(fingerprint);
  const known = knownId === undefined ? undefined : await ctx.storage.get(knownId);
  if (known !== undefined) {
    const merged = addOccurrence(known, input, nowIso);
    if (!(await ctx.saveWithinCap(merged, known))) return storageFull;
    noteDraftStatus(index, merged);
    return { ok: true, outcome: 'merged', draft: merged };
  }
  // 索引にあるのにディスクに無いのは、手で消されたとき。新しい下書きとして作り直す。
  if (knownId !== undefined) forgetDrafts(index, [knownId]); // statusById と、その指紋の idByFingerprint を落とす

  const bucket = hourBucketOf(now);
  if ((index.newDraftsByHour.get(bucket) ?? 0) >= ISSUE_DRAFT_NEW_PER_HOUR) {
    const massFingerprint = massOccurrenceFingerprint(input.kind, now);
    const massId = index.idByFingerprint.get(massFingerprint);
    const existingMass = massId === undefined ? undefined : await ctx.storage.get(massId);
    const folded = foldIntoMassDraft(existingMass, input, {
      id: ctx.newId(),
      massFingerprint,
      foldedFingerprint: fingerprint,
      nowIso,
    });
    if (!(await ctx.saveWithinCap(folded, existingMass))) return storageFull;
    if (massId !== undefined && massId !== folded.id) forgetDrafts(index, [massId]);
    index.idByFingerprint.set(massFingerprint, folded.id);
    noteDraftStatus(index, folded);
    return { ok: true, outcome: 'folded', draft: folded };
  }

  const draft = createDraftFromReport(input, { id: ctx.newId(), fingerprint, nowIso });
  if (!(await ctx.saveWithinCap(draft, undefined))) return storageFull;
  index.idByFingerprint.set(fingerprint, draft.id);
  noteDraftStatus(index, draft);
  index.newDraftsByHour.set(bucket, (index.newDraftsByHour.get(bucket) ?? 0) + 1);
  return { ok: true, outcome: 'created', draft };
}
