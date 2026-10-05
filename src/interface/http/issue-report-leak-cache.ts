import { createHash } from 'node:crypto';
import type { DraftLeakScan, DraftTextToScan } from '../../domain/issue-draft-edit.js';
import { scanEditedText } from '../../domain/issue-draft-edit.js';
import type { LocalOnlyKeys } from '../../domain/issue-public-types.js';

export interface RestrictedLeakCache {
  scan(draftId: string, text: DraftTextToScan, keys: LocalOnlyKeys): DraftLeakScan;
}

export function createRestrictedLeakCache(options: {
  readonly maxEntries?: number;
  readonly scan?: typeof scanEditedText;
} = {}): RestrictedLeakCache {
  const maxEntries = Math.max(0, Math.floor(options.maxEntries ?? 256));
  const scanText = options.scan ?? scanEditedText;
  const entries = new Map<string, { readonly fingerprint: string; readonly result: DraftLeakScan }>();
  return {
    scan(draftId, text, keys) {
      const fingerprint = createHash('sha256')
        .update(JSON.stringify([text.title, text.body, text.titleEdited, text.bodyEdited, keys.projectRoots, keys.properNouns]))
        .digest('hex');
      const cached = entries.get(draftId);
      if (cached?.fingerprint === fingerprint) {
        entries.delete(draftId);
        entries.set(draftId, cached);
        return cached.result;
      }
      const result = scanText(text, keys);
      entries.delete(draftId);
      if (maxEntries > 0) {
        entries.set(draftId, { fingerprint, result });
        if (entries.size > maxEntries) entries.delete(entries.keys().next().value as string);
      }
      return result;
    },
  };
}
