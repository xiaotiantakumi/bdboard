import type { ContractState } from './harness-contract.js';
import type { HarnessHooksState, PackHookDeclaration } from './harness-hooks.js';

export type { PackHookDeclaration };

export interface PackSummary {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  /**
   * hook 宣言。`files` と違いディレクトリ走査が要らず、Hygiene の hooksState
   * 算出 (= パック一覧しか持たない経路) でも必要になるので、`PackDefinition`
   * ではなく `PackSummary` 側に置く。
   */
  readonly hooks: readonly PackHookDeclaration[];
}

export interface PackFileEntry {
  /** Pack ディレクトリ根からの相対パス (POSIX) */
  readonly relativePath: string;
}

export interface PackDefinition extends PackSummary {
  readonly files: readonly PackFileEntry[];
}

export interface InstalledPackRecord {
  readonly name: string;
  readonly version: string;
  readonly injectedAt: string;
  /** プロジェクトルートからの相対パス */
  readonly files: readonly string[];
  /** `.claude/settings.json` に登録した hook のコマンド文字列。 */
  readonly hooks?: readonly string[];
}

export interface HarnessManifest {
  readonly packs: readonly InstalledPackRecord[];
}

export interface ProjectHarnessPackStatus {
  readonly name: string;
  readonly availableVersion: string;
  readonly installedVersion: string | null;
  readonly drift: boolean;
  /** `.claude/settings.json` への hook 登録状況。drift とは独立に出す。 */
  readonly hooksState: HarnessHooksState;
  /** 未登録の hook コマンド文字列。`hooksState` が `ok` / `none-declared` なら空。 */
  readonly missingHooks: readonly string[];
}

export interface ProjectHarnessStatus {
  readonly packs: readonly ProjectHarnessPackStatus[];
  /**
   * 検証コントラクト (`.claude/bdboard-harness.json`) の状態。パック単位ではなく
   * プロジェクト単位なので、`packs` の外に置く。未注入プロジェクトでは
   * `not-applicable` になり、UI には何も出さない (bdboard-pkr6.3)。
   */
  readonly contract: ContractState;
}

export const EMPTY_HARNESS_MANIFEST: HarnessManifest = { packs: [] };
