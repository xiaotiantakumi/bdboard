// bdboard-sso1.11: HygienePanel.tsx から純粋な型を移動しただけのファイル。
// 挙動は一切変えていない。
import type {
  ProjectHarnessContractDto,
  ProjectHarnessPackStatusDto,
} from '../../api';

export interface HygienePanelProps {
  readonly projectIds: readonly string[];
  onSelectTicket: (ticketId: string) => void;
  readonly projectRootPaths?: ReadonlyMap<string, string>;
}

/**
 * プロジェクト × パックの警告行。drift (要更新) と hook 未登録は、行の中身も
 * 直し方 (再注入) も同じなので 1 つの型にまとめる。どちらのリストに入っているかが
 * 種別を決める。
 */
export interface HarnessPackItem {
  readonly projectId: string;
  readonly pack: ProjectHarnessPackStatusDto;
}

export interface HarnessContractItem {
  readonly projectId: string;
  readonly contract: ProjectHarnessContractDto;
}

export interface HarnessHygieneItems {
  readonly driftItems: readonly HarnessPackItem[];
  readonly contractItems: readonly HarnessContractItem[];
  readonly hooksItems: readonly HarnessPackItem[];
}

export type RepairableKind = 'undefer' | 'close';

export type RepairFeedback = {
  readonly rowKey: string;
  readonly message: string;
};
