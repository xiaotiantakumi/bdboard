import { readFileSync } from 'node:fs';
import { URL as NodeUrl, fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canUseMatchMedia,
  matchesMediaQuery,
  MOBILE_LAYOUT_MEDIA_QUERY,
  REDUCED_MOTION_MEDIA_QUERY,
} from './mediaQueries';

/**
 * bdboard-ymrj: JS 側のメディアクエリ文字列は index.css の @media と対で持つ。
 * 呼び出し側のテストはこの定数そのものと比較するため、定数の文字列が CSS とずれても
 * 気付けない。ここで CSS 側に同じ文字列の @media 規則があることを固定する。
 */
describe('media query constants stay paired with index.css', () => {
  const css = readFileSync(fileURLToPath(new NodeUrl('./index.css', import.meta.url)), 'utf8');

  it.each([
    ['REDUCED_MOTION_MEDIA_QUERY', REDUCED_MOTION_MEDIA_QUERY],
    ['MOBILE_LAYOUT_MEDIA_QUERY', MOBILE_LAYOUT_MEDIA_QUERY],
  ])('%s has a matching @media block', (_name, query) => {
    expect(css).toContain(`@media ${query} {`);
  });
});

describe('matchMedia helpers', () => {
  let original: PropertyDescriptor | undefined;

  beforeEach(() => {
    original = Object.getOwnPropertyDescriptor(window, 'matchMedia');
  });

  afterEach(() => {
    if (original) {
      Object.defineProperty(window, 'matchMedia', original);
    } else {
      delete (window as { matchMedia?: unknown }).matchMedia;
    }
  });

  it('returns false when matchMedia is unavailable', () => {
    Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: undefined });

    expect(canUseMatchMedia()).toBe(false);
    expect(matchesMediaQuery(REDUCED_MOTION_MEDIA_QUERY)).toBe(false);
  });

  it('reads the current match once via matchMedia', () => {
    const matchMedia = vi.fn((query: string) => ({ matches: query === REDUCED_MOTION_MEDIA_QUERY }));
    Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: matchMedia });

    expect(canUseMatchMedia()).toBe(true);
    expect(matchesMediaQuery(REDUCED_MOTION_MEDIA_QUERY)).toBe(true);
    expect(matchesMediaQuery(MOBILE_LAYOUT_MEDIA_QUERY)).toBe(false);
    expect(matchMedia).toHaveBeenCalledTimes(2);
  });
});
