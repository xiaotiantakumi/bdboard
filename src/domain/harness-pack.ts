import type { ContractState } from './harness-contract.js';
import type { HarnessHooksState, PackHookDeclaration } from './harness-hooks.js';

export type { PackHookDeclaration };

/**
 * パックの役割 (pack.json の `role`)。
 * - `base`: ベースのハーネス。bd 運用プロジェクトへ従来どおり入れる土台。
 * - `optional`: 任意パック。ベースを前提に載せる (`requires` で依存先を宣言する)。
 */
export const PACK_ROLES = ['base', 'optional'] as const;
export type PackRole = (typeof PACK_ROLES)[number];

/** pack.json に `role` が無い旧形式のパックの解釈。既存の注入先はこれで動き続ける。 */
export const DEFAULT_PACK_ROLE: PackRole = 'base';

export interface PackSummary {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  /** 役割。pack.json に無ければ `DEFAULT_PACK_ROLE` (= base)。 */
  readonly role: PackRole;
  /** 依存先のパック名。pack.json に無ければ空 (依存なし)。 */
  readonly requires: readonly string[];
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
  /** `.claude/settings.local.json` (自己注入は `.claude/settings.json`) に登録した hook のコマンド文字列。 */
  readonly hooks?: readonly string[];
}

export interface HarnessManifest {
  readonly packs: readonly InstalledPackRecord[];
}

/**
 * パックを注入できない理由の種別 (bdboard-l1m1.1)。UI は文言 (`reason`) を表示するだけで、
 * 規則を複製しない。`code` はテストと API 利用側の分岐用。判定は
 * `evaluatePackInjectability` (harness-pack-injectability.ts)。
 */
export type PackInjectabilityCode =
  | 'base-has-requires'
  | 'optional-without-requires'
  | 'requires-pack-missing'
  | 'requires-cycle'
  | 'requires-not-injected';

export type PackInjectability =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: PackInjectabilityCode; readonly reason: string };

export interface ProjectHarnessPackStatus {
  readonly name: string;
  /** 選択 UI に出す pack.json 由来の表示情報 (bdboard-l1m1.1)。 */
  readonly description: string;
  readonly role: PackRole;
  readonly requires: readonly string[];
  readonly availableVersion: string;
  readonly installedVersion: string | null;
  readonly drift: boolean;
  /** `.claude/settings.local.json` / `.claude/settings.json` への hook 登録状況 (和集合)。drift とは独立に出す。 */
  readonly hooksState: HarnessHooksState;
  /** 未登録の hook コマンド文字列。`hooksState` が `ok` / `none-declared` なら空。 */
  readonly missingHooks: readonly string[];
  /**
   * このプロジェクトに今このパックを注入できるか (bdboard-l1m1.1)。選択状態は注入記録
   * (`.claude/bdboard-packs.json`) が正で、ここは「選べるか」の判定と理由だけ。
   * 規則は `evaluatePackInjectability` の 1 か所 (UI に複製しない)。
   */
  readonly injectable: PackInjectability;
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
