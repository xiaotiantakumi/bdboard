import { randomBytes } from 'node:crypto';
import type { DraftEnvInfo, IssueDraft } from '../../domain/issue-draft.js';
import {
  ISSUE_DRAFT_MANUAL_PER_HOUR,
  ISSUE_DRAFT_MANUAL_WINDOW_MS,
  countManualDraftsSince,
  createManualDraft,
  manualFingerprint,
  type ManualDraftInput,
} from '../../domain/issue-draft-manual.js';
import type { IssueDraftStoragePort } from '../ports/issue-draft-storage.js';
import type { DraftIndexCache } from './issue-draft-index.js';
import type { DraftReceiveContext } from './issue-draft-receive.js';

/*
 * サービスの mutex の内側で動く、手書きの下書き (「新しく報告」) の作成と件数の上限 (bdboard-4y8q.6.7)。
 * issue-draft-receive.ts の隣で、同じ mutex の中で動く前提 (createManual: exclusive(() => createManualLocked(...)))。
 * 自動の受け取りと違い、まとめない・「大量発生」へ丸めない・自動の 20 件/時の枠を使わない・数えない。外へ何も送らない。
 */

/** 画面から送られる入力。版 (envInfo) はサーバーが埋めるので、ここには無い。 */
export type CreateManualDraftInput = Omit<ManualDraftInput, 'envInfo'>;

export type CreateManualDraftResult =
  | { readonly ok: true; readonly draft: IssueDraft }
  /** 1 時間以内に作った手書きの下書きが上限に達している (429 manual-rate-limited)。何も書いていない。 */
  | { readonly ok: false; readonly reason: 'rate-limited' }
  /** issue-drafts の合計容量の上限に収まらない (終端の下書きを消しても足りない)。 */
  | { readonly ok: false; readonly reason: 'storage-full' };

export interface DraftManualContext extends DraftReceiveContext {
  /** 手書きの件数は一覧 (scan) から数える (索引の形式は変えない)。 */
  readonly storage: Pick<IssueDraftStoragePort, 'get' | 'scan'>;
  /** 書いた下書きの状態を索引へ反映する (未処理の件数)。 */
  readonly indexCache: Pick<DraftIndexCache, 'get' | 'noteStatus'>;
  /** サーバーの版 (bdboard・OS・Node)。省略時は 'unknown'。 */
  readonly envInfo?: (() => DraftEnvInfo) | undefined;
  /** 指紋の 16 桁 hex の乱数 (既定は randomBytes(8))。テストが差し替える。 */
  readonly randomHex?: (() => string) | undefined;
  /** 1 時間あたりの上限 (既定は ISSUE_DRAFT_MANUAL_PER_HOUR)。 */
  readonly perHour?: number | undefined;
}

const UNKNOWN_ENV: DraftEnvInfo = { bdboardVersion: 'unknown', os: 'unknown', nodeVersion: 'unknown' };

export async function createManualLocked(
  ctx: DraftManualContext,
  input: CreateManualDraftInput,
): Promise<CreateManualDraftResult> {
  // 期限切れの掃除 (受け取りと同じく 1 時間に 1 回まで。失敗しても作成は続ける)。
  await ctx.pruneIfDue();
  const now = ctx.now();
  const nowIso = now.toISOString();

  // 走っている 1 時間 (UTC の暦時間ではない) に作られた手書きの下書きを一覧から数える。自動の枠 (newDraftsByHour) は見ない・増やさない。
  const listing = await ctx.storage.scan();
  const recent = countManualDraftsSince(listing.drafts, now.getTime() - ISSUE_DRAFT_MANUAL_WINDOW_MS);
  if (recent >= (ctx.perHour ?? ISSUE_DRAFT_MANUAL_PER_HOUR)) return { ok: false, reason: 'rate-limited' };

  const randomHex = ctx.randomHex?.() ?? randomBytes(8).toString('hex');
  const draft = createManualDraft(
    { ...input, envInfo: ctx.envInfo?.() ?? UNKNOWN_ENV },
    { id: ctx.newId(), fingerprint: manualFingerprint(randomHex), nowIso },
  );
  if (!(await ctx.saveWithinCap(draft, undefined))) return { ok: false, reason: 'storage-full' };
  // 索引へは状態だけ反映する。指紋は毎回ランダムで引き当てに使わず、自動の枠 (newDraftsByHour) には数えない。
  await ctx.indexCache.noteStatus(draft);
  return { ok: true, draft };
}
