// bdboard-sso1.23 PR-A: BulkActionBar.tsx から純粋な型を移動しただけのファイル。
// 挙動は一切変えていない。
import type { BoardCardDto } from '../../api';

export type BulkConfirmingAction =
  | { kind: 'close' }
  | { kind: 'defer'; untilDate: string }
  | { kind: 'priority-up' }
  | { kind: 'priority-down' }
  | { kind: 'add-label'; label: string };

export interface BulkActionBarProps {
  cardsById: ReadonlyMap<string, BoardCardDto>;
  availableLabels?: readonly string[];
}
