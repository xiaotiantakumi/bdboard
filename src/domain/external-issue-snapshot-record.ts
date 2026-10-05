/**
 * 届いた issue の「判定時点の写し」の記録と、その保持の規則 (bdboard-4y8q.9.3、docs/ISSUE-REPORTING.md 8節)。
 * IO を持たない純粋関数だけ。保存は `ExternalIssueSnapshotStoragePort`、流れは `external-issue-service.ts`。
 *
 * 記録の中身: 題名・切り詰めた本文・全長・updatedAt (4y8q.9.1 の `ExternalIssueSnapshot`) に、写しの時刻、機械の検査の
 * 結果、needsRejudge、一覧から外れた時刻を足したもの。コメントは入れない (取りにも行かない)。
 */
import {
  runMachineChecks,
  truncateExternalIssue,
  type ExternalIssueText,
  type MachineCheckResult,
  type TruncatedExternalIssue,
} from './external-issue-checks.js';
import type { ExternalIssueSnapshot } from './external-issue-snapshot.js';

/** 番号の形。ファイル名 (`<number>.json`) になるので、10 桁までの正の整数だけを通す (パスの閉じ込めを兼ねる)。 */
export const EXTERNAL_ISSUE_NUMBER_PATTERN = /^[1-9][0-9]{0,9}$/;

/** 写しを残す日数。一覧 (open かつ bd に紐付いていないもの) から外れてからこの日数が過ぎた写しは消す。 */
export const EXTERNAL_ISSUE_SNAPSHOT_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
export const EXTERNAL_ISSUE_SNAPSHOT_RETENTION_MS = EXTERNAL_ISSUE_SNAPSHOT_RETENTION_DAYS * DAY_MS;

/** 写しの数の上限。一覧に載っている issue の写しは消さないので、一覧もこの数までに切る。 */
export const EXTERNAL_ISSUE_SNAPSHOT_MAX_COUNT = 500;

export function isExternalIssueNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && EXTERNAL_ISSUE_NUMBER_PATTERN.test(String(value));
}

/** gh が返した 1 件の、切り詰めと機械の検査を済ませた形。 */
export interface PreparedExternalIssue extends TruncatedExternalIssue {
  readonly number: number;
  /** GitHub の現在の updatedAt (gh が返した文字列のまま)。 */
  readonly updatedAt: string;
  /** 切り詰めた後の題名・本文にかけた検査。 */
  readonly checks: MachineCheckResult;
}

/**
 * 切り詰め → 検査の順にかける。検査は切り詰めた後の文字列に対してなので、切り捨てた先の文字列は検査にも保存にも渡らない。
 * `bodyLength` (上流の jq が測った本文の全長) があれば全長として使う (`truncateExternalIssue` と同じ)。
 */
export function prepareExternalIssue(raw: ExternalIssueText & { readonly number: number; readonly updatedAt: string }): PreparedExternalIssue {
  const truncated = truncateExternalIssue(raw);
  return { ...truncated, number: raw.number, updatedAt: raw.updatedAt, checks: runMachineChecks(truncated) };
}

/** 保存する記録 1 件 (`<number>.json`)。 */
export interface StoredExternalIssueSnapshot extends ExternalIssueSnapshot {
  readonly number: number;
  readonly titleTruncated: boolean;
  readonly bodyTruncated: boolean;
  /** 写しを取った時刻 (ISO 8601 UTC。最初に見た時点か、`resnapshot` で取り直した時点)。 */
  readonly snapshotAt: string;
  /** 写しを取った時点の機械の検査の結果。 */
  readonly checks: MachineCheckResult;
  /**
   * 写しと違う題名か本文を見たら立て、取り直す (`resnapshot`) まで下ろさない。元の文章に戻されても残る
   * (比べる相手は判定した時点の写しで、戻ったかどうかは判定をやり直す理由にならない。やり直すかは人が決める)。
   */
  readonly needsRejudge: boolean;
  /**
   * 一覧 (open で、bd に紐付いていない) から外れたのを最初に見た時刻。載っているあいだは null。保持期限と
   * 上限の数え方の元で、載り直したら null に戻す。
   */
  readonly missingSince: string | null;
}

/** 最初に見た時点 (または取り直した時点) の記録。`prepared` の現在の内容がそのまま写しになる。 */
export function createSnapshotRecord(prepared: PreparedExternalIssue, snapshotAt: string): StoredExternalIssueSnapshot {
  return {
    number: prepared.number,
    title: prepared.title,
    body: prepared.body,
    titleLength: prepared.titleLength,
    bodyLength: prepared.bodyLength,
    titleTruncated: prepared.titleTruncated,
    bodyTruncated: prepared.bodyTruncated,
    updatedAt: prepared.updatedAt,
    snapshotAt,
    checks: prepared.checks,
    needsRejudge: false,
    missingSince: null,
  };
}

export interface SnapshotRetentionOptions {
  readonly nowMs: number;
  /**
   * 一覧が最後まで読めたか。読めなかったとき (gh のページの上限で打ち切った) は、一覧に無い issue がまだ open かも
   * しれないので、日数での削除をしない。上限の数での削除は、一覧が読めたかによらず行う。
   */
  readonly listingComplete: boolean;
}

/**
 * 消す写しの番号を選ぶ。
 * 1. 一覧から外れて `EXTERNAL_ISSUE_SNAPSHOT_RETENTION_DAYS` 日以上たったもの (一覧が最後まで読めたときだけ)。
 * 2. それでも `EXTERNAL_ISSUE_SNAPSHOT_MAX_COUNT` を超えるなら、一覧から外れたもののうち外れた時刻が古いものから。
 * 一覧に載っている写し (`missingSince` が null) は、どちらでも消さない。
 */
export function selectSnapshotsToRemove(
  records: readonly Pick<StoredExternalIssueSnapshot, 'number' | 'missingSince'>[],
  options: SnapshotRetentionOptions,
): number[] {
  const removals = new Set<number>();
  if (options.listingComplete) {
    for (const record of records) {
      if (record.missingSince !== null && options.nowMs - Date.parse(record.missingSince) >= EXTERNAL_ISSUE_SNAPSHOT_RETENTION_MS) {
        removals.add(record.number);
      }
    }
  }
  const excess = records.length - removals.size - EXTERNAL_ISSUE_SNAPSHOT_MAX_COUNT;
  if (excess > 0) {
    const oldestFirst = records
      .filter((record) => record.missingSince !== null && !removals.has(record.number))
      .sort((a, b) => Date.parse(a.missingSince ?? '') - Date.parse(b.missingSince ?? '') || a.number - b.number);
    for (const record of oldestFirst.slice(0, excess)) removals.add(record.number);
  }
  return [...removals];
}
