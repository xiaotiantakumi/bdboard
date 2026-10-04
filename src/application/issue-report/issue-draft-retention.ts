import {
  ISSUE_DRAFT_DIR_MAX_BYTES,
  ISSUE_DRAFT_PRUNE_INTERVAL_MS,
  ISSUE_DRAFT_RESURVEY_GAP_MS,
  ISSUE_DRAFT_RETENTION_MS,
  selectDraftsToFree,
  selectExpiredDrafts,
  type DraftFootprint,
} from '../../domain/issue-draft-retention.js';
import type { IssueDraftStoragePort } from '../ports/issue-draft-storage.js';

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
  /** 容量を測り直す最短の間隔 (ms)。既定は 1 分。 */
  readonly resurveyGapMs?: number;
  /** issue-drafts 全体の上限 (バイト)。既定は 1 GiB。 */
  readonly maxTotalBytes?: number;
  /** 警告の出力 (既定は console.warn)。code と id だけを渡す。 */
  readonly warn?: (message: string) => void;
}

export interface DraftRetentionDeps extends DraftRetentionOptions {
  readonly storage: Pick<IssueDraftStoragePort, 'survey' | 'remove'>;
  readonly now: () => Date;
}

export interface DraftRetention {
  /** 起動時の掃除。間隔を待たずに走る。投げない。 */
  pruneNow(): Promise<void>;
  /** 受け取りのついでの掃除。前回から pruneIntervalMs 経っていなければ何もしない。投げない。 */
  pruneIfDue(): Promise<void>;
  /**
   * incomingBytes を足しても上限に収まるか。収まらなければ、終端の下書きを古い順に消して空け、それでも
   * 収まらなければ false (開いている下書きは消さない)。測れなかったときは true (fail-open)。投げない。
   */
  ensureRoom(incomingBytes: number): Promise<boolean>;
  /** 書き込みに成功したあとの差分 (増えたバイト数。縮んだら負)。実測の合計をずらさず保つ。 */
  recordWrite(deltaBytes: number): void;
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : 'unknown';
}

export function createDraftRetention(deps: DraftRetentionDeps): DraftRetention {
  const retentionMs = deps.retentionMs ?? ISSUE_DRAFT_RETENTION_MS;
  const pruneIntervalMs = deps.pruneIntervalMs ?? ISSUE_DRAFT_PRUNE_INTERVAL_MS;
  const resurveyGapMs = deps.resurveyGapMs ?? ISSUE_DRAFT_RESURVEY_GAP_MS;
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

  async function takeSnapshot(): Promise<boolean> {
    lastSurveyAtMs = deps.now().getTime();
    try {
      const survey = await deps.storage.survey();
      totalBytes = survey.totalBytes;
      snapshot = survey.drafts;
      if (survey.unmeasured.length > 0) {
        const codes = [...new Set(survey.unmeasured)].sort().join(', ');
        warnOnce(`issue draft sizes are undercounted: ${survey.unmeasured.length} location(s) could not be measured (${codes})`);
      }
      return true;
    } catch (error) {
      // 試みは 1 時間 (掃除) と 1 分 (容量) に 1 回までなので、毎回警告を出してよい。
      warn(`issue draft survey failed (${errorCode(error)})`);
      return false;
    }
  }

  async function removeAll(targets: readonly DraftFootprint[]): Promise<void> {
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
  }

  async function pruneNow(): Promise<void> {
    const nowMs = deps.now().getTime();
    lastPruneAtMs = nowMs;
    if (!(await takeSnapshot())) return;
    await removeAll(selectExpiredDrafts(snapshot, nowMs, retentionMs));
  }

  return {
    pruneNow,

    async pruneIfDue() {
      const nowMs = deps.now().getTime();
      if (lastPruneAtMs !== undefined && nowMs - lastPruneAtMs < pruneIntervalMs) return;
      await pruneNow();
    },

    async ensureRoom(incomingBytes) {
      if (incomingBytes <= 0) return true;
      if (totalBytes !== undefined && fits(incomingBytes)) return true;
      // 上限を超えそうなときだけ実測する。ただし測り直しは resurveyGapMs に 1 回まで。
      const sinceSurveyMs = lastSurveyAtMs === undefined ? Infinity : deps.now().getTime() - lastSurveyAtMs;
      if (sinceSurveyMs >= resurveyGapMs) await takeSnapshot();
      if (fits(incomingBytes)) return true;
      const targets = selectDraftsToFree(snapshot, (totalBytes ?? 0) + incomingBytes - maxTotalBytes);
      if (targets === undefined) return false;
      await removeAll(targets);
      return fits(incomingBytes);
    },

    recordWrite(deltaBytes) {
      if (totalBytes !== undefined) totalBytes = Math.max(0, totalBytes + deltaBytes);
    },
  };
}
