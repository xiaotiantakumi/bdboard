import type { CommandFailureKind } from './command-runner.js';

export interface ReclaimRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly failureKind?: CommandFailureKind;
}

/** 空配列を型レベルで表現不能にする */
export type NonEmptyTicketIds = readonly [string, ...string[]];

export interface LeaseReclaimer {
  /**
   * @param ticketIds `bd reclaim --id` で絞り込む ID。**必ず 1 件以上**。
   *   絞り込みであって広げるものではない (lease が失効していなければ回収されない)。
   *
   *   空を渡せないよう型で塞いである。bd から見れば「--id 指定なし」と区別できず、
   *   「1件も回収しない」のつもりが**全件回収**になるため (bdboard-6aci)。
   *   回収対象が無いときは呼び出し側が bd を呼ばないこと。
   */
  reclaim(
    projectRootPath: string,
    olderThan: string,
    ticketIds: NonEmptyTicketIds,
  ): Promise<ReclaimRunResult>;
}
