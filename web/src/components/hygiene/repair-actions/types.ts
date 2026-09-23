// bdboard-sso1.55: useHygieneRepairActions.ts から、複数の修復系フックが共有する
// パラメータ形だけを move-only で切り出した型ファイル。挙動は変えていない。
import type { QueryClient } from '@tanstack/react-query';
import type { RepairFeedback } from '../types';

/**
 * 単体の修復系フック (repair/harness inject/contract ticket) が共通で必要とする、
 * 親フック (useHygieneRepairActions) が持つフィードバック state への操作。
 */
export interface RepairFeedbackControls {
  readonly clearRepairFeedback: () => void;
  readonly showRepairStatusMessage: (message: string) => void;
  readonly setPendingRepairKey: (rowKey: string | null) => void;
  readonly setConfirmingRepairKey: (rowKey: string | null) => void;
  readonly setRepairError: (feedback: RepairFeedback | null) => void;
}

export interface RepairMutationDeps extends RepairFeedbackControls {
  readonly queryClient: QueryClient;
}
