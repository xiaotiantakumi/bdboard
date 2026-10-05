import { describe, expect, it, vi } from 'vitest';
import { createRestrictedLeakCache } from './issue-report-leak-cache.js';
import type { DraftLeakScan, DraftTextToScan } from '../../domain/issue-draft-edit.js';
import type { LocalOnlyKeys } from '../../domain/issue-public-types.js';

const text: DraftTextToScan = { title: 'title', body: 'body', titleEdited: true, bodyEdited: false };
const keys: LocalOnlyKeys = { projectRoots: [], properNouns: [] };
const empty: DraftLeakScan = { suspectedLeaks: [], omitted: 0 };

describe('createRestrictedLeakCache', () => {
  it('reuses the result for the same draft and the same scan input', () => {
    const scan = vi.fn(() => empty);
    const cache = createRestrictedLeakCache({ scan });
    cache.scan('a', text, keys);
    cache.scan('a', { ...text }, { projectRoots: [], properNouns: [] });
    expect(scan).toHaveBeenCalledTimes(1);
  });

  // 変える入力ごとに新しいキャッシュで「基準 → その入力だけ変えたもの」を比べる。直前の呼び出しとの比較だと、別の欄の違いで
  // 外れになり、その欄が指紋に入っていなくても通ってしまう (bdboard-pnvj の PR #889 のレビュー MINOR-1)。
  it.each<readonly [string, string, DraftTextToScan, LocalOnlyKeys]>([
    ['the title', 'a', { ...text, title: 'changed' }, keys],
    ['the body', 'a', { ...text, body: 'changed' }, keys],
    ['titleEdited', 'a', { ...text, titleEdited: !text.titleEdited }, keys],
    ['bodyEdited', 'a', { ...text, bodyEdited: !text.bodyEdited }, keys],
    ['a project name key', 'a', text, { ...keys, properNouns: [{ category: 'project', value: 'name' }] }],
    ['a project root key', 'a', text, { ...keys, projectRoots: ['/work/proj'] }],
    ['the draft id', 'b', text, keys],
  ])('scans again when only %s changes', (_label, id, variantText, variantKeys) => {
    const scan = vi.fn(() => empty);
    const cache = createRestrictedLeakCache({ scan });
    cache.scan('a', text, keys);
    cache.scan(id, variantText, variantKeys);
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it('evicts least recently used entries when it exceeds its limit', () => {
    const scan = vi.fn(() => empty);
    const cache = createRestrictedLeakCache({ maxEntries: 2, scan });
    cache.scan('a', text, keys);
    cache.scan('b', text, keys);
    cache.scan('a', text, keys);
    cache.scan('c', text, keys);
    cache.scan('a', text, keys);
    cache.scan('b', text, keys);
    expect(scan).toHaveBeenCalledTimes(4);
  });
});
