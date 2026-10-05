import { describe, expect, it, vi } from 'vitest';
import { createRestrictedLeakCache } from './issue-report-leak-cache.js';
import type { DraftLeakScan, DraftTextToScan } from '../../domain/issue-draft-edit.js';
import type { LocalOnlyKeys } from '../../domain/issue-public-types.js';

const text: DraftTextToScan = { title: 'title', body: 'body', titleEdited: true, bodyEdited: false };
const keys: LocalOnlyKeys = { projectRoots: [], properNouns: [] };
const empty: DraftLeakScan = { suspectedLeaks: [], omitted: 0 };

describe('createRestrictedLeakCache', () => {
  it('reuses the result only for the same draft and complete scan input', () => {
    const scan = vi.fn(() => empty);
    const cache = createRestrictedLeakCache({ scan });
    cache.scan('a', text, keys);
    cache.scan('a', text, keys);
    expect(scan).toHaveBeenCalledTimes(1);
    cache.scan('a', { ...text, body: 'changed' }, keys);
    cache.scan('a', { ...text, title: 'changed' }, keys);
    cache.scan('a', { ...text, bodyEdited: true }, keys);
    cache.scan('a', text, { ...keys, properNouns: [{ category: 'project', value: 'name' }] });
    cache.scan('b', text, keys);
    expect(scan).toHaveBeenCalledTimes(6);
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
