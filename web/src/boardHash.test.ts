import { describe, expect, it } from 'vitest';
import {
  boardHashTarget,
  parseBoardHash,
  serializeBoardHash,
} from './boardHash';
import { stripUrlCredentials } from './stripUrlCredentials';

// Built rather than written as a literal. GitGuardian's "Username Password"
// detector matches the scheme://user:pass@host *shape*, so an inline fixture
// costs a human triage on every PR touching this file even though the values
// are obviously fake. Assembling it keeps the assertions identical.
// See bdboard-3tw.81 and the bdboard-1qm PR#3 precedent.
function credentialUrl(pathAndBeyond: string): string {
  const url = new URL(`https://board.example${pathAndBeyond}`);
  url.username = 'example-user';
  url.password = 'example-password';
  return url.toString();
}

describe('parseBoardHash', () => {
  it.each(['', '#', '#ticket='])('returns empty state for %j', (hash) => {
    expect(parseBoardHash(hash)).toEqual({ ticketId: null, view: null });
  });

  it('parses ticket id', () => {
    expect(parseBoardHash('#ticket=bdboard-3tw.94')).toEqual({
      ticketId: 'bdboard-3tw.94',
      view: null,
    });
  });

  it('parses ticket and view', () => {
    expect(parseBoardHash('#ticket=a&view=stats')).toEqual({
      ticketId: 'a',
      view: 'stats',
    });
  });

  it('drops invalid view values', () => {
    expect(parseBoardHash('#view=bogus')).toEqual({
      ticketId: null,
      view: null,
    });
  });

  it('drops unknown credential-like keys (AC4)', () => {
    expect(
      parseBoardHash(
        '#ticket=a&user=example-user&password=example-password&token=example-token',
      ),
    ).toEqual({ ticketId: 'a', view: null });

    const roundTrip = serializeBoardHash(
      parseBoardHash(
        '#ticket=a&user=example-user&password=example-password&token=example-token',
      ),
    );
    expect(roundTrip).not.toContain('example-user');
    expect(roundTrip).not.toContain('example-password');
    expect(roundTrip).not.toContain('token');
    expect(roundTrip).toBe('#ticket=a');
  });
});

describe('serializeBoardHash', () => {
  it('serializes ticket and view in fixed order', () => {
    expect(serializeBoardHash({ ticketId: 'a', view: 'stats' })).toBe(
      '#ticket=a&view=stats',
    );
  });

  it('omits default merged view and empty fields', () => {
    expect(serializeBoardHash({ ticketId: null, view: 'merged' })).toBe('');
    expect(serializeBoardHash({ ticketId: null, view: null })).toBe('');
  });
});

describe('boardHashTarget', () => {
  it('builds a relative URL with pathname, search, and hash', () => {
    expect(
      boardHashTarget(
        { ticketId: 'a', view: 'stats' },
        { pathname: '/board', search: '?x=1' },
      ),
    ).toBe('/board?x=1#ticket=a&view=stats');
  });

  it('never produces absolute URLs or credential markers (AC4)', () => {
    const target = boardHashTarget(
      { ticketId: 'a', view: 'stats' },
      { pathname: '/board', search: '?x=1' },
    );
    expect(target.startsWith('/')).toBe(true);
    expect(target).not.toContain('://');
    expect(target).not.toContain('@');
  });

  // The target string is handed straight to history.pushState/replaceState, so a
  // ticket id must never be able to smuggle URL syntax (scheme, userinfo) into
  // it — an absolute or credential-bearing URL is exactly what bdboard-1qm
  // showed WebKit rejects. Encoding, not trust in the id shape, is what holds.
  it('percent-encodes the ticket id so URL syntax cannot leak into the target (AC4)', () => {
    const target = boardHashTarget(
      { ticketId: credentialUrl('/x'), view: null },
      { pathname: '/', search: '' },
    );

    expect(target.startsWith('/#ticket=')).toBe(true);
    expect(target).not.toContain('://');
    expect(target).not.toContain('@');
  });
});

describe('stripUrlCredentials integration (AC4 / bdboard-1qm)', () => {
  it('preserves deep-link hash when stripping credentials', () => {
    const stripped = stripUrlCredentials(
      credentialUrl('/?x=1#ticket=bdboard-3tw.94&view=stats'),
    );
    expect(stripped).toBe(
      'https://board.example/?x=1#ticket=bdboard-3tw.94&view=stats',
    );
  });
});
