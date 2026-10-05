import { createHash } from 'node:crypto';
import type { DraftLeakScan, DraftTextToScan } from '../../domain/issue-draft-edit.js';
import { scanEditedText, scannedFieldsOf } from '../../domain/issue-draft-edit.js';
import type { LocalOnlyKeys } from '../../domain/issue-public-types.js';

export interface RestrictedLeakCache {
  scan(draftId: string, text: DraftTextToScan, keys: LocalOnlyKeys): DraftLeakScan;
}

/**
 * 検出の入力だけから作る指紋 (bdboard-ov0t)。検出がかかる欄 (直した欄。scannedFieldsOf) と鍵 (根のパス・固有名詞) をまるごと入れる。
 * 検出しない欄 (直していない欄の自動の文。受け取りのたびに回数や時刻で変わる) は入れない: 題名だけ直した下書きが、受け取りのたびに
 * キャッシュから外れない。検出する欄・鍵を落とすと、古い結果を返して疑いを見逃すので、scanEditedText と同じ scannedFieldsOf から作る。
 * 欄の有無は JSON の欄の有無で区別される (直していない欄は欄ごと無く、空の文字列とは別の指紋になる)。
 */
function scanFingerprintOf(text: DraftTextToScan, keys: LocalOnlyKeys): string {
  return createHash('sha256').update(JSON.stringify([scannedFieldsOf(text), keys])).digest('hex');
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
      const fingerprint = scanFingerprintOf(text, keys);
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
