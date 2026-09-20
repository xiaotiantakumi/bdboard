// bd-tool-catalog.ts (bdboard-sso1.18) の分割で切り出した公開型。
// BdToolDefinition はカタログ配列 (各 *-tools.ts) の要素型、BdArgsBuildResult は
// buildBdToolArgs (各 *-tools.ts の builder と index.ts の合成) の戻り値型。
// 挙動・型は分割前と同一 (移動のみ)。
export interface BdToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly writes: boolean;
}

export type BdArgsBuildResult =
  | { readonly ok: true; readonly args: readonly string[]; readonly stdin?: string }
  | { readonly ok: false; readonly error: string };
