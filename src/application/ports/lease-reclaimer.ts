import type { CommandFailureKind } from './command-runner.js';

export interface ReclaimRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly failureKind?: CommandFailureKind;
}

export interface LeaseReclaimer {
  /**
   * @param ticketIds 指定すると `bd reclaim --id` で**この ID だけ**に絞る。
   *   絞り込みであって広げるものではない (lease が失効していなければ回収されない)。
   *   未指定なら従来どおりプロジェクト全体の stale lease が対象。
   *   **空配列を渡してはいけない** — bd から見れば「--id 指定なし」と区別できず、
   *   「1件も回収しない」のつもりが全件回収になる。呼び出し側で握り潰すこと。
   */
  reclaim(
    projectRootPath: string,
    olderThan: string,
    ticketIds?: readonly string[],
  ): Promise<ReclaimRunResult>;
}
