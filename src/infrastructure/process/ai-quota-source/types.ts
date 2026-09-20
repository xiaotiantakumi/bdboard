import type { AiQuotaMetric, AiQuotaProviderSnapshot } from '../../../application/ports/ai-quota-source.js';

export interface NodeAiQuotaSourceOptions {
  readonly command?: string;
  /** 既定は `all`。登録済みの全プロバイダについて、ライブ値または確認方法を取得する。 */
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
}

export interface ProviderBlock {
  readonly header: string;
  readonly lines: readonly string[];
}

export interface ParsedBlockContent {
  readonly plan?: string;
  readonly metrics: readonly AiQuotaMetric[];
  readonly availability: AiQuotaProviderSnapshot['availability'];
  /** `ai-quota` が出した確認方法だけを保持し、probe例外の原文は返さない。 */
  readonly detail?: string;
}
