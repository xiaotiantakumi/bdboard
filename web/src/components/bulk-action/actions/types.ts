// bdboard-sso1.60: useBulkActions.ts から、複数の mutation フック
// (useBulkQuickAction/useBulkLabelAction) が共有するパラメータ形だけを
// move-only で切り出した型ファイル。挙動は変えていない。
import type { QueryClient } from '@tanstack/react-query';
import type {
  BulkIdOutcome,
  BulkQuickActionOutcome,
} from '../../../bulkQuickAction';
import type { BulkSelectionContextValue } from '../../BulkSelectionProvider';
import type { BulkConfirmingAction } from '../types';

/**
 * useBulkActions (親フック) が持つ、複数の mutation フックが共通で必要とする
 * state への操作。
 */
export interface BulkActionMutationDeps {
  readonly queryClient: QueryClient;
  readonly bulkSelection: BulkSelectionContextValue | null;
  readonly setLastOutcome: (
    outcome: BulkQuickActionOutcome | BulkIdOutcome | null,
  ) => void;
  readonly setConfirmingAction: (action: BulkConfirmingAction | null) => void;
}
