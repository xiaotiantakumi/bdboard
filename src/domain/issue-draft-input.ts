import type { DraftEnvInfo, DraftKind } from './issue-draft.js';
import { canonicalizeIdentifier, foldHomePathsInValues, sanitizeProjectName } from './issue-draft-identifier.js';

/** 受け取った 1 回分の報告の入力 (bdboard-4y8q.1)。下書きを作る・足す純粋関数 (issue-draft-build.ts) に渡す。 */

export interface ReceiveDraftInput {
  readonly kind: DraftKind;
  /** A のみ必須: failure-catalog の短い名前。 */
  readonly catalogSlug?: string;
  /** B/C のみ必須: 出どころ (hook 名・スクリプト名・API のパスなど)。 */
  readonly source?: string;
  readonly symptom?: string;
  readonly cause?: string;
  readonly prevention?: string;
  readonly errorText?: string;
  readonly agentNote?: string;
  readonly envInfo?: Partial<DraftEnvInfo>;
  readonly project?: { readonly name: string; readonly path: string };
  readonly sourceTicketRef?: string;
}

/**
 * 受け取った名前の欄のホーム配下の絶対パスを "~/" に畳む (issue-draft-identifier.ts の foldHomePaths)。
 * 対象は source・catalogSlug・版の文字列 (envInfo の各文字列)・プロジェクト名で、題名・本文・指紋・
 * harnessVersionAtOccurrence・トンネル向けの応答に出る欄。指紋・下書きの欄はすべてこの後の値から作るので、
 * 受け取りの最初に 1 回かける (かけ直しても同じ結果)。プロジェクト名はさらに、1 行の検査で弾く文字を
 * 取り除く (表示用の欄なので拒否はしない)。プロジェクトのパス (project.path) は手元限定で、触らない。
 */
export function canonicalizeReceiveInput(input: ReceiveDraftInput): ReceiveDraftInput {
  return {
    ...input,
    ...(input.source !== undefined ? { source: canonicalizeIdentifier(input.source) } : {}),
    ...(input.catalogSlug !== undefined ? { catalogSlug: canonicalizeIdentifier(input.catalogSlug) } : {}),
    ...(input.envInfo !== undefined ? { envInfo: foldHomePathsInValues(input.envInfo) } : {}),
    ...(input.project !== undefined
      ? { project: { name: sanitizeProjectName(input.project.name), path: input.project.path } }
      : {}),
  };
}
