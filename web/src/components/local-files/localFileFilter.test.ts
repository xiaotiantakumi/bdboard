import { afterEach, describe, expect, it } from 'vitest';
import type { LocalFileRefDto } from '../../api/local-files';
import {
  filterLocalFiles,
  LOCAL_FILE_FILTER_STORAGE_KEY,
  readStoredLocalFileFilter,
  writeStoredLocalFileFilter,
} from './localFileFilter';

const files: LocalFileRefDto[] = [
  { path: 'a.mp4', kind: 'video', size: 1 },
  { path: 'b.json', kind: 'json', size: 1 },
  { path: 'c.md', kind: 'markdown', size: 1 },
  { path: 'out', kind: 'directory', size: null },
  { path: 'd.png', kind: 'image', size: 1 },
];

describe('filterLocalFiles', () => {
  it('returns everything for all', () => {
    expect(filterLocalFiles(files, 'all')).toHaveLength(5);
  });
  it.each([
    ['video', 'a.mp4'],
    ['json', 'b.json'],
    ['markdown', 'c.md'],
    ['directory', 'out'],
  ] as const)('keeps only %s', (filter, path) => {
    expect(filterLocalFiles(files, filter).map((f) => f.path)).toEqual([path]);
  });
});

describe('stored filter', () => {
  afterEach(() => window.localStorage.clear());
  it('defaults to all and ignores invalid values', () => {
    expect(readStoredLocalFileFilter()).toBe('all');
    window.localStorage.setItem(LOCAL_FILE_FILTER_STORAGE_KEY, 'bogus');
    expect(readStoredLocalFileFilter()).toBe('all');
  });
  it('round-trips', () => {
    writeStoredLocalFileFilter('json');
    expect(readStoredLocalFileFilter()).toBe('json');
  });
});
