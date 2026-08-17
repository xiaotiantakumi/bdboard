export interface MergeSlotSignal {
  readonly status: string;
  readonly holder: string | null;
  readonly updatedAt: string;
}

export interface MergeSlotReader {
  /** プロジェクトの `<prefix>-merge-slot` (label: gt:slot) ビーズを読む。存在しなければ null */
  readMergeSlotSignal(projectRootPath: string): Promise<MergeSlotSignal | null>;
}
