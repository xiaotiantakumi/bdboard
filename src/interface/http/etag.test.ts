import { describe, expect, it } from 'vitest';
import {
  boardViewDtoStableJson,
  computeStrongEtag,
  computeWeakEtag,
  etagDigestOf,
  ifMatchAccepts,
  ifNoneMatchMatches,
  normalizeEtagToken,
} from './etag.js';

describe('computeWeakEtag', () => {
  it('returns a weak ETag with truncated sha256 hex', () => {
    const etag = computeWeakEtag('hello');
    expect(etag).toMatch(/^W\/"[0-9a-f]{32}"$/);
    expect(etag).toBe(computeWeakEtag('hello'));
  });
});

describe('normalizeEtagToken', () => {
  it('strips W/ prefix and quotes', () => {
    expect(normalizeEtagToken('W/"abc123"')).toBe('abc123');
    expect(normalizeEtagToken('"abc123"')).toBe('abc123');
    expect(normalizeEtagToken('  W / "abc123"  ')).toBe('abc123');
  });
});

describe('ifNoneMatchMatches', () => {
  const etag = computeWeakEtag('stable-body');

  it('matches exact weak ETag', () => {
    expect(ifNoneMatchMatches(etag, etag)).toBe(true);
  });

  it('matches strong-form candidate against weak ETag', () => {
    const digest = normalizeEtagToken(etag);
    expect(ifNoneMatchMatches(`"${digest}"`, etag)).toBe(true);
  });

  it('matches comma-separated list with whitespace', () => {
    const other = computeWeakEtag('other');
    const digest = normalizeEtagToken(etag);
    expect(
      ifNoneMatchMatches(` ${other} ,  W/"${digest}"  `, etag),
    ).toBe(true);
  });

  it('matches wildcard *', () => {
    expect(ifNoneMatchMatches('*', etag)).toBe(true);
    expect(ifNoneMatchMatches('  *  ', etag)).toBe(true);
  });

  it('does not match unrelated ETags', () => {
    const other = computeWeakEtag('other');
    expect(ifNoneMatchMatches(other, etag)).toBe(false);
    expect(ifNoneMatchMatches('W/"deadbeef"', etag)).toBe(false);
  });
});

describe('computeStrongEtag', () => {
  it('returns a strong ETag with the same truncated digest as the weak one', () => {
    const strong = computeStrongEtag('hello');
    expect(strong).toMatch(/^"[0-9a-f]{32}"$/);
    expect(strong).toBe(computeStrongEtag('hello'));
    expect(strong).not.toBe(computeStrongEtag('hello!'));
    expect(`W/${strong}`).toBe(computeWeakEtag('hello'));
  });
});

describe('ifMatchAccepts', () => {
  const etag = computeStrongEtag('current');
  const other = computeStrongEtag('other');
  /** 全体の ETag との一致 (イコール) で判定する accepts。 */
  const sameAs = (current: string) => (token: string) => token === normalizeEtagToken(current);

  it('accepts the exact ETag, a list that contains it, and *', () => {
    expect(ifMatchAccepts(etag, sameAs(etag))).toBe(true);
    expect(ifMatchAccepts(` ${other} ,  ${etag}  `, sameAs(etag))).toBe(true);
    expect(ifMatchAccepts('*', sameAs(etag))).toBe(true);
  });

  it('ignores a W/ prefix, which the gzip middleware or a tunnel puts on a strong ETag', () => {
    expect(ifMatchAccepts(`W/${etag}`, sameAs(etag))).toBe(true);
    expect(ifMatchAccepts(etag, sameAs(`W/${etag}`))).toBe(true);
  });

  it('does not accept another ETag, garbage or an empty value', () => {
    expect(ifMatchAccepts(other, sameAs(etag))).toBe(false);
    expect(ifMatchAccepts('W/"deadbeef"', sameAs(etag))).toBe(false);
    expect(ifMatchAccepts('garbage', sameAs(etag))).toBe(false);
    expect(ifMatchAccepts('', sameAs(etag))).toBe(false);
    expect(ifMatchAccepts(' , ', sameAs(etag))).toBe(false);
  });

  it('hands every entry to accepts with the W/ prefix and the quotes stripped, and judges nothing for * or an empty entry', () => {
    const seen: string[] = [];
    const never = (token: string) => {
      seen.push(token);
      return false;
    };
    expect(ifMatchAccepts(' "a" , W/"b",, garbage ', never)).toBe(false);
    expect(seen).toEqual(['a', 'b', 'garbage']);
    expect(ifMatchAccepts('*', never)).toBe(true);
    expect(seen).toHaveLength(3);
  });
});

describe('etagDigestOf', () => {
  it('is the 32-hex digest that both ETag formats are made of', () => {
    expect(etagDigestOf('hello')).toMatch(/^[0-9a-f]{32}$/);
    expect(computeStrongEtag('hello')).toBe(`"${etagDigestOf('hello')}"`);
    expect(computeWeakEtag('hello')).toBe(`W/"${etagDigestOf('hello')}"`);
  });
});

describe('boardViewDtoStableJson', () => {
  it('excludes generatedAt from stable serialization', () => {
    const dto = {
      mode: 'merged',
      generatedAt: '2026-01-01T00:00:00.000Z',
      projects: [],
      merged: null,
    };
    const other = {
      ...dto,
      generatedAt: '2026-06-02T15:30:00.000Z',
    };

    expect(boardViewDtoStableJson(dto)).toBe(boardViewDtoStableJson(other));
    expect(boardViewDtoStableJson(dto)).not.toContain('generatedAt');
  });
});
