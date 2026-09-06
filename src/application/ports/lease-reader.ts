export interface InProgressWithLease {
  readonly id: string;
  readonly leaseExpiresAt: string | null;
  readonly heartbeatAt: string | null;
  /**
   * 作業開始時刻 (bd の `started_at`)。reclaim の保護窓の起点フォールバックにのみ使う
   * (leaseExpiresAt が無いチケット限定、bdboard-vz01)。未着手なら null。
   */
  readonly startedAt: string | null;
  /**
   * チケット作成時刻 (bd の `created_at`)。startedAt も無いチケットの、保護窓起点の
   * 最終フォールバックに使う (bdboard-vz01)。bd の全チケットに必ず付く値。
   */
  readonly createdAt: string;
}

export interface LeaseReader {
  listInProgressWithLease(projectRootPath: string): Promise<readonly InProgressWithLease[]>;
}
