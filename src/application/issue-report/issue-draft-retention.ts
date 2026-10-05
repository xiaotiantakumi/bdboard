import {
  ISSUE_DRAFT_DIR_MAX_BYTES,
  ISSUE_DRAFT_PRUNE_INTERVAL_MS,
  ISSUE_DRAFT_RESURVEY_GAP_MAX_MS,
  ISSUE_DRAFT_RESURVEY_GAP_MS,
  ISSUE_DRAFT_RETENTION_MS,
  selectDraftsToFree,
  selectExpiredDrafts,
  type DraftFootprint,
} from '../../domain/issue-draft-retention.js';
import type { DraftSurvey, IssueDraftStoragePort } from '../ports/issue-draft-storage.js';

/**
 * 不具合報告の下書きの保持期限と合計容量 (bdboard-00qh、docs/ISSUE-REPORTING.md 4節「保持期限と合計容量」)。
 * 何を消すかは domain/issue-draft-retention.ts、測る・消すのは storage の survey / remove。ここは
 * 「いつ走らせるか」と「失敗したらどうするか」を決める。
 *
 * 失敗の方針: 掃除と容量の確認は**受け取りを落とさない**。survey や remove が失敗したら警告 (code と id だけ。
 * パスも message も出さない: N5) を出して先へ進む。クライアントは 1 秒で諦めて再送しない
 * (docs/ISSUE-REPORTING.md 9節) ので、掃除の失敗で報告を失うほうが害が大きい。測れなかったときの容量の確認は
 * 通す側 (fail-open) に倒す。
 *
 * このモジュールの呼び出しはすべて、サービスの mutex の内側で 1 本ずつ流れる前提 (survey と remove の間に
 * 別の書き込みが割り込まない)。
 */

export interface DraftRetentionOptions {
  /** 見送り・投稿済みを残す期間 (ms)。既定は 30 日。 */
  readonly retentionMs?: number;
  /** 受け取りのついでの掃除の最短の間隔 (ms)。既定は 1 時間。 */
  readonly pruneIntervalMs?: number;
  /** 容量を測り直す最短の間隔 (ms)。既定は 1 分。0 にすると、張り付いたときの間隔の延長 (resurveyGapMaxMs) も効かない。 */
  readonly resurveyGapMs?: number;
  /** 測り直しても空けられないあいだ、間隔を倍々に伸ばす上限 (ms)。既定は 1 時間。resurveyGapMs より小さければ resurveyGapMs。 */
  readonly resurveyGapMaxMs?: number;
  /** issue-drafts 全体の上限 (バイト)。既定は 1 GiB。 */
  readonly maxTotalBytes?: number;
  /** 警告の出力 (既定は console.warn)。code と id だけを渡す。 */
  readonly warn?: (message: string) => void;
}

export interface DraftRetentionDeps extends DraftRetentionOptions {
  readonly storage: Pick<IssueDraftStoragePort, 'survey' | 'remove'>;
  readonly now: () => Date;
  /**
   * 掃除 (pruneNow) が棚卸しを終え、期限切れを消し終えたあとに、その棚卸しと「消せた id」を渡す。サービスが受け取りの
   * 索引をここから作る (起動直後の最初の受け取りが全件をもう一度読まないため、bdboard-xvo2)。容量の測り直し (ensureRoom) の
   * 棚卸しや、失敗した棚卸しでは呼ばない。メモリ内だけの処理で、投げない前提。
   */
  readonly onPruned?: (survey: DraftSurvey, removedIds: ReadonlySet<string>) => void;
}

export interface DraftRetention {
  /** 起動時の掃除。間隔を待たずに走る。投げない。 */
  pruneNow(): Promise<void>;
  /** 受け取りのついでの掃除。前回から pruneIntervalMs 経っていなければ何もしない。投げない。 */
  pruneIfDue(): Promise<void>;
  /**
   * incomingBytes を足しても上限に収まるか。収まらなければ、終端の下書きを古い順に消して空け、それでも
   * 収まらなければ false (開いている下書きは消さない)。測れなかったときは true (fail-open)。投げない。
   * keepId は今まさに書き込む下書き: 空ける候補から外す (自分の画像を消してから draft.json だけ書き戻さない)。
   */
  ensureRoom(incomingBytes: number, keepId?: string): Promise<boolean>;
  /** 書き込みに成功したあとの差分 (増えたバイト数。縮んだら負)。実測の合計をずらさず保つ。 */
  recordWrite(deltaBytes: number): void;
  /**
   * 空けられる下書き (終端の状態) が増えたかもしれない操作 (見送り・投稿) のあとに呼ぶ。上限に張り付いて伸ばした
   * 測り直しの間隔を最短 (resurveyGapMs) に戻す。測り直し自体はここでは走らない。
   */
  noteFreeableDraft(): void;
}

/** 間隔を倍にする回数の頭打ち (2 ** n が溢れないように。実際の上限は resurveyGapMaxMs)。 */
const MAX_GAP_DOUBLINGS = 30;

/** 経過時間が [0, windowMs) の中か。負 (時計が戻った) は外: 間隔が過ぎたものとして扱う。 */
function isWithin(elapsedMs: number, windowMs: number): boolean {
  return elapsedMs >= 0 && elapsedMs < windowMs;
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : 'unknown';
}

export function createDraftRetention(deps: DraftRetentionDeps): DraftRetention {
  const retentionMs = deps.retentionMs ?? ISSUE_DRAFT_RETENTION_MS;
  const pruneIntervalMs = deps.pruneIntervalMs ?? ISSUE_DRAFT_PRUNE_INTERVAL_MS;
  const resurveyGapMs = deps.resurveyGapMs ?? ISSUE_DRAFT_RESURVEY_GAP_MS;
  const resurveyGapMaxMs = Math.max(resurveyGapMs, deps.resurveyGapMaxMs ?? ISSUE_DRAFT_RESURVEY_GAP_MAX_MS);
  const maxTotalBytes = deps.maxTotalBytes ?? ISSUE_DRAFT_DIR_MAX_BYTES;
  const warn = deps.warn ?? ((message: string) => console.warn(message));

  /**
   * 実測の合計 (最後の survey) に、そのあとの書き込みの差分を足したもの。受け取りごとに歩かずに上限を確かめる
   * ためで、survey の直後と掃除のたびに実測へ戻る。undefined = まだ測れていない。
   */
  let totalBytes: number | undefined;
  /** 最後の survey の中身 (消したものは除く)。上限に迫ったとき、何を消すかをここから選ぶ。 */
  let snapshot: readonly DraftFootprint[] = [];
  let lastSurveyAtMs: number | undefined;
  let lastPruneAtMs: number | undefined;
  /**
   * 続けて「測り直したのに空けられなかった」回数 (bdboard-krvf)。上限に張り付いて断り続けているあいだ、測り直しの間隔を
   * resurveyGapMs × 2^n (resurveyGapMaxMs まで) に伸ばす: 1 GiB の最悪の形では棚卸し 1 回が数秒かかり、その間
   * 受け取りは mutex で待つので、結果の変わらない測り直しを毎分は繰り返さない。0 に戻すのは、ensureRoom で空けられた・
   * 測れず通した (fail-open)・見送り (noteFreeableDraft)・掃除が空きを見つけた (pruneNow) とき。空き容量が十分で
   * 通した場合 (ensureRoom の早い道) と、測らずに断っただけの場合は、数えも戻しもしない。
   */
  let pinnedSurveys = 0;
  /** 同じ警告を何度も出さない (上限に張り付いたまま受け取りが続くと、毎回同じ失敗をしうる)。 */
  const warned = new Set<string>();

  function warnOnce(message: string): void {
    if (warned.has(message)) return;
    warned.add(message);
    warn(message);
  }

  /** incomingBytes を足しても上限に収まるか。まだ測れていない (undefined) ときは収まる側に倒す (fail-open)。 */
  function fits(incomingBytes: number): boolean {
    return totalBytes === undefined || totalBytes + incomingBytes <= maxTotalBytes;
  }

  async function takeSnapshot(): Promise<DraftSurvey | undefined> {
    lastSurveyAtMs = deps.now().getTime();
    try {
      const survey = await deps.storage.survey();
      totalBytes = survey.totalBytes;
      snapshot = survey.drafts;
      if (survey.unmeasured.length > 0) {
        const codes = [...new Set(survey.unmeasured)].sort().join(', ');
        warnOnce(`issue draft sizes are undercounted: ${survey.unmeasured.length} location(s) could not be measured (${codes})`);
      }
      return survey;
    } catch (error) {
      // 測れない = 合計が分からない。前回の合計や一覧で判断し続けず、容量の確認は通す側 (fail-open) に倒す。
      totalBytes = undefined;
      snapshot = [];
      // 試みは 1 時間 (掃除) と 1 分 (容量) に 1 回までなので、毎回警告を出してよい。
      warn(`issue draft survey failed (${errorCode(error)})`);
      return undefined;
    }
  }

  /** 消せたものの id を返す (消せなかったものは警告して残す)。 */
  async function removeAll(targets: readonly DraftFootprint[]): Promise<ReadonlySet<string>> {
    const removed = new Set<string>();
    for (const target of targets) {
      try {
        await deps.storage.remove(target.id);
        removed.add(target.id);
        if (totalBytes !== undefined) totalBytes = Math.max(0, totalBytes - target.bytes);
      } catch (error) {
        warnOnce(`issue draft ${target.id} could not be removed (${errorCode(error)})`);
      }
    }
    snapshot = snapshot.filter((draft) => !removed.has(draft.id));
    return removed;
  }

  /** いまの測り直しの間隔: 張り付いた回数だけ倍にして、resurveyGapMaxMs で止める。 */
  function currentResurveyGapMs(): number {
    return Math.min(resurveyGapMaxMs, resurveyGapMs * 2 ** Math.min(pinnedSurveys, MAX_GAP_DOUBLINGS));
  }

  /**
   * 測り終えた(または間隔内で測らなかった)あとの、上限に収めるための処理。収まれば true。
   * 不変条件 (bdboard-krvf): snapshot は張り付き中、最長 1 時間古い。それでも消す相手の選択に使ってよいのは、終端の状態は
   * 戻らない (終端の下書きには回数だけ足す) から。見送りの取り消しなど開き直す操作を足すなら、選ぶ前に測り直すこと。
   */
  async function freeRoomFor(incomingBytes: number, keepId: string | undefined): Promise<boolean> {
    if (fits(incomingBytes)) return true;
    const candidates = keepId === undefined ? snapshot : snapshot.filter((draft) => draft.id !== keepId);
    const targets = selectDraftsToFree(candidates, (totalBytes ?? 0) + incomingBytes - maxTotalBytes);
    if (targets === undefined) return false;
    await removeAll(targets);
    return fits(incomingBytes);
  }

  async function pruneNow(): Promise<void> {
    const nowMs = deps.now().getTime();
    lastPruneAtMs = nowMs;
    const totalBefore = totalBytes;
    const survey = await takeSnapshot();
    if (survey === undefined) return;
    // 棚卸し直後の実測 (期限切れを消す前)。持っていた合計より小さい = 外で手で消された。
    const freedOutOfBand = totalBefore !== undefined && totalBytes !== undefined && totalBytes < totalBefore;
    const removed = await removeAll(selectExpiredDrafts(snapshot, nowMs, retentionMs));
    // 掃除の棚卸しが空きを見つけたときだけ、張り付いて伸ばした間隔を戻す: 期限切れを消せた、または外で消されていた
    // (実測の合計が、書き込みの差分を足し続けた棚卸し前の合計より小さい)。何も空いていない掃除では戻さない
    // (毎時戻すと、1 時間に 6 回測り直す元の木阿弥)。
    if (removed.size > 0 || freedOutOfBand) pinnedSurveys = 0;
    deps.onPruned?.(survey, removed);
  }

  return {
    pruneNow,

    async pruneIfDue() {
      const nowMs = deps.now().getTime();
      // 時計が戻った (前回より前の時刻) ときは、間隔が過ぎたものとして走らせる。
      if (lastPruneAtMs !== undefined && isWithin(nowMs - lastPruneAtMs, pruneIntervalMs)) return;
      await pruneNow();
    },

    async ensureRoom(incomingBytes, keepId) {
      if (incomingBytes <= 0) return true;
      if (totalBytes !== undefined && fits(incomingBytes)) return true;
      // 上限を超えそうなときだけ実測する。ただし測り直しは currentResurveyGapMs() に 1 回まで (時計が戻ったときは測り直す)。
      const sinceSurveyMs = lastSurveyAtMs === undefined ? Infinity : deps.now().getTime() - lastSurveyAtMs;
      const surveyed = !isWithin(sinceSurveyMs, currentResurveyGapMs());
      if (surveyed) await takeSnapshot();
      const room = await freeRoomFor(incomingBytes, keepId);
      // 測ったのに空けられなかった = 張り付いている: 次の測り直しを遅らせる。空いた・測れず通した (fail-open) なら戻す。
      if (room) pinnedSurveys = 0;
      else if (surveyed) pinnedSurveys += 1;
      return room;
    },

    recordWrite(deltaBytes) {
      if (totalBytes !== undefined) totalBytes = Math.max(0, totalBytes + deltaBytes);
    },

    noteFreeableDraft() {
      pinnedSurveys = 0;
    },
  };
}
