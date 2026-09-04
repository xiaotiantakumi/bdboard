import type { ContractState } from './harness-contract.js';

export interface PackSummary {
  readonly name: string;
  readonly version: string;
  readonly description: string;
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
}

export interface HarnessManifest {
  readonly packs: readonly InstalledPackRecord[];
}

export interface ProjectHarnessPackStatus {
  readonly name: string;
  readonly availableVersion: string;
  readonly installedVersion: string | null;
  readonly drift: boolean;
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
