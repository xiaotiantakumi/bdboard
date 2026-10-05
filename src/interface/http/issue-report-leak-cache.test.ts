import { describe, expect, it, vi } from 'vitest';
import { createRestrictedLeakCache } from './issue-report-leak-cache.js';
import type { DraftLeakScan, DraftTextToScan } from '../../domain/issue-draft-edit.js';
import type { LocalOnlyKeys } from '../../domain/issue-public-types.js';

// 検出は直した欄 (titleEdited / bodyEdited が true の欄) だけにかかる (scanEditedText)。指紋もその欄だけから作る (bdboard-ov0t)。
const text: DraftTextToScan = { title: 'title', body: 'body', titleEdited: true, bodyEdited: true };
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
  // 検出する欄が変われば外れる: 検出する欄を指紋から落とすと、古い結果を返して置き換え漏れの疑いを見逃す。
  it.each<readonly [string, string, DraftTextToScan, LocalOnlyKeys]>([
    ['the title (edited)', 'a', { ...text, title: 'changed' }, keys],
    ['the body (edited)', 'a', { ...text, body: 'changed' }, keys],
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

  // 検出しない欄 (直していない欄) だけが変わっても当たる: 自動の文は受け取りのたびに回数・時刻で変わるが、検出の入力ではない。
  it.each<readonly [string, DraftTextToScan, DraftTextToScan]>([
    [
      'the title of a draft whose title was not edited',
      { ...text, titleEdited: false },
      { ...text, titleEdited: false, title: 'automatic title, receive 2' },
    ],
    [
      'the body of a draft whose body was not edited',
      { ...text, bodyEdited: false },
      { ...text, bodyEdited: false, body: '発生回数: 2' },
    ],
    [
      'the title and the body of a draft with no edited field',
      { ...text, titleEdited: false, bodyEdited: false },
      { ...text, titleEdited: false, bodyEdited: false, title: 'changed', body: 'changed' },
    ],
  ])('reuses the result when only %s changes', (_label, base, variant) => {
    const result: DraftLeakScan = { suspectedLeaks: [{ field: 'body', kind: 'email', start: 0, end: 1 }], omitted: 0 };
    const scan = vi.fn(() => result);
    const cache = createRestrictedLeakCache({ scan });
    const first = cache.scan('a', base, keys);
    const second = cache.scan('a', variant, keys);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  // 直した欄が空の文字列のときと、直していない欄 (検出しない) のときは別の指紋 (欄が無いことと空の文字列を取り違えない)。
  it('tells an edited empty field from a field that is not scanned', () => {
    const scan = vi.fn(() => empty);
    const cache = createRestrictedLeakCache({ scan });
    cache.scan('a', { title: '', body: '', titleEdited: false, bodyEdited: false }, keys);
    cache.scan('a', { title: '', body: '', titleEdited: true, bodyEdited: false }, keys);
    cache.scan('a', { title: '', body: '', titleEdited: true, bodyEdited: true }, keys);
    expect(scan).toHaveBeenCalledTimes(3);
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
