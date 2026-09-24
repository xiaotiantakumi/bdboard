// bdboard-sso1.23 PR-A: BulkActionBar.tsx から純粋な型を移動しただけのファイル。
// 挙動は一切変えていない。
import type { BoardCardDto } from '../../api';
import type { BulkAgentRunConfig } from './agent-run/useBulkAgentRun';

export type BulkConfirmingAction =
  | { kind: 'close' }
  | { kind: 'defer'; untilDate: string }
  | { kind: 'priority-up' }
  | { kind: 'priority-down' }
  | { kind: 'add-label'; label: string };

export interface BulkActionBarProps {
  cardsById: ReadonlyMap<string, BoardCardDto>;
  availableLabels?: readonly string[];
  /**
   * bdboard-mkm1.2: 渡すと「▶ 実行」(選択カードのエージェント一括実行) を出す。
   * 実行ループのコントローラは App が持つものを渡す (ビューを切り替えても続くように)。
   */
  agentRun?: BulkAgentRunConfig;
}
