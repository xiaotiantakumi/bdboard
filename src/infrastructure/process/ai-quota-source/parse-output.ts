import type { AiQuotaProviderSnapshot } from '../../../application/ports/ai-quota-source.js';
import { extractProviderBlocks, parseHeader } from './block-extraction.js';
import { parseBlockContent } from './block-content-parser.js';

export function parseAiQuotaOutput(
  stdout: string,
  fetchedAt: Date,
): readonly AiQuotaProviderSnapshot[] {
  const blocks = extractProviderBlocks(stdout);
  const providers: AiQuotaProviderSnapshot[] = [];

  for (const block of blocks) {
    const { id, label, vendor } = parseHeader(block.header);
    const content = parseBlockContent(block.lines, fetchedAt);

    providers.push({
      id,
      label,
      ...(vendor !== undefined ? { vendor } : {}),
      ...(content.plan !== undefined ? { plan: content.plan } : {}),
      availability: content.availability,
      ...(content.detail !== undefined ? { detail: content.detail } : {}),
      metrics: content.metrics,
    });
  }

  return providers;
}
