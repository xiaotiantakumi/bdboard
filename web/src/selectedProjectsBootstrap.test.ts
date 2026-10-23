import { describe, expect, it, vi } from 'vitest';
import {
  bootstrapSelectedProjects,
  encodeProjectsParam,
  fetchServerSelectedProjects,
  parseProjectsParam,
  stripProjectsParam,
} from './selectedProjectsBootstrap';
import { UI_STORAGE_KEYS } from './uiPersistedState/storageKeys';

const KEY = UI_STORAGE_KEYS.selectedProjectIds;

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
}

function makeDeps(
  href: string,
  storage = memoryStorage(),
  server: string[] | null = null,
) {
  const replaceUrl = vi.fn();
  const fetchServerSelection = vi.fn(async () => server);
  return {
    storage,
    deps: { storage, href, replaceUrl, fetchServerSelection },
    replaceUrl,
    fetchServerSelection,
  };
}

describe('parseProjectsParam', () => {
  it('returns null when absent or empty', () => {
    expect(parseProjectsParam('')).toBeNull();
    expect(parseProjectsParam('?x=1')).toBeNull();
    expect(parseProjectsParam('?projects=')).toBeNull();
  });

  it('round-trips ids containing commas and spaces', () => {
    const ids = ['/a/b c', '/p,q', '/z'];
    expect(parseProjectsParam(`?t=1&projects=${encodeProjectsParam(ids)}`)).toEqual(ids);
  });

  it('dedupes and ignores broken escapes', () => {
    expect(parseProjectsParam('?projects=a,a,b')).toEqual(['a', 'b']);
    expect(parseProjectsParam('?projects=%E0%A4%A')).toBeNull();
  });
});

describe('stripProjectsParam', () => {
  it('removes only projects and keeps the rest', () => {
    expect(stripProjectsParam('https://h/board?x=1&projects=a,b#f')).toBe('/board?x=1#f');
    expect(stripProjectsParam('https://h/?projects=a')).toBe('/');
  });
  it('returns null when there is nothing to strip', () => {
    expect(stripProjectsParam('https://h/?x=1')).toBeNull();
  });
});

describe('bootstrapSelectedProjects', () => {
  it('applies the query param, overwrites a saved selection, and strips the URL', async () => {
    const { storage, deps, replaceUrl, fetchServerSelection } = makeDeps(
      'https://h/?projects=%2Fa,%2Fb',
      memoryStorage({ [KEY]: '["/old"]' }),
      ['/server'],
    );
    expect(await bootstrapSelectedProjects(deps)).toBe('query');
    expect(JSON.parse(storage.data.get(KEY)!)).toEqual(['/a', '/b']);
    expect(replaceUrl).toHaveBeenCalledWith('/');
    expect(fetchServerSelection).not.toHaveBeenCalled();
  });

  it('uses the server selection on a fresh device', async () => {
    const { storage, deps, replaceUrl } = makeDeps('https://h/', memoryStorage(), ['/s']);
    expect(await bootstrapSelectedProjects(deps)).toBe('server');
    expect(JSON.parse(storage.data.get(KEY)!)).toEqual(['/s']);
    expect(replaceUrl).not.toHaveBeenCalled();
  });

  it('keeps the device own saved selection (even an empty one) over the server', async () => {
    const { storage, deps, fetchServerSelection } = makeDeps(
      'https://h/',
      memoryStorage({ [KEY]: '[]' }),
      ['/s'],
    );
    expect(await bootstrapSelectedProjects(deps)).toBe('none');
    expect(storage.data.get(KEY)).toBe('[]');
    expect(fetchServerSelection).not.toHaveBeenCalled();
  });

  it('writes nothing when the server has no (or an all-projects) selection', async () => {
    const { storage, deps } = makeDeps('https://h/', memoryStorage(), null);
    expect(await bootstrapSelectedProjects(deps)).toBe('none');
    expect(storage.data.has(KEY)).toBe(false);
  });

  it('strips a broken projects param without applying it', async () => {
    const { storage, deps, replaceUrl } = makeDeps(
      'https://h/?projects=%E0%A4%A',
      memoryStorage(),
      null,
    );
    expect(await bootstrapSelectedProjects(deps)).toBe('none');
    expect(replaceUrl).toHaveBeenCalledWith('/');
    expect(storage.data.has(KEY)).toBe(false);
  });
});

describe('fetchServerSelectedProjects', () => {
  const respond = (body: unknown, ok = true) =>
    (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;

  it('returns ids, and null for empty / null / malformed / failed', async () => {
    expect(await fetchServerSelectedProjects(respond({ projectIds: ['/a'] }))).toEqual(['/a']);
    expect(await fetchServerSelectedProjects(respond({ projectIds: [] }))).toBeNull();
    expect(await fetchServerSelectedProjects(respond({ projectIds: null }))).toBeNull();
    expect(await fetchServerSelectedProjects(respond({ projectIds: [1] }))).toBeNull();
    expect(await fetchServerSelectedProjects(respond({}, false))).toBeNull();
    const boom = (async () => {
      throw new Error('net');
    }) as unknown as typeof fetch;
    expect(await fetchServerSelectedProjects(boom)).toBeNull();
  });
});
