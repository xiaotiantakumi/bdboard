import { canonicalizeIdentifier, type DraftEnvInfo, type DraftKind } from './issue-draft.js';

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
 * 受け取った source・catalogSlug のホーム配下の絶対パスを "~/" に畳む (canonicalizeIdentifier)。
 * 指紋・下書きの欄・題名・本文はすべてこの後の値から作るので、受け取りの最初に 1 回かける。
 */
export function canonicalizeReceiveInput(input: ReceiveDraftInput): ReceiveDraftInput {
  return {
    ...input,
    ...(input.source !== undefined ? { source: canonicalizeIdentifier(input.source) } : {}),
    ...(input.catalogSlug !== undefined ? { catalogSlug: canonicalizeIdentifier(input.catalogSlug) } : {}),
  };
}
