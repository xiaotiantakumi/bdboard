import { describe, expect, it } from 'vitest';
import {
  resolveCredentialRedirect,
  stripUrlCredentials,
} from './stripUrlCredentials';

describe('stripUrlCredentials', () => {
  it('removes both username and password', () => {
    const stripped = stripUrlCredentials(
      'https://example-user:example-password@brave-lamp-47.trycloudflare.com/',
    );

    expect(stripped).not.toBeNull();
    const parsed = new URL(stripped!);
    expect(parsed.username).toBe('');
    expect(parsed.password).toBe('');
    expect(parsed.host).toBe('brave-lamp-47.trycloudflare.com');
  });

  it('keeps the path, query and hash intact', () => {
    const stripped = stripUrlCredentials(
      'https://example-user:example-password@host.example.com/board?view=next#lane-3',
    );

    expect(stripped).toBe('https://host.example.com/board?view=next#lane-3');
  });

  it('strips a username-only userinfo', () => {
    const stripped = stripUrlCredentials('https://example-user@host.example.com/');

    expect(stripped).toBe('https://host.example.com/');
  });

  it('returns null when there is nothing to strip', () => {
    // Callers use null to skip rewriting history at all, which is the normal
    // desktop case — no QR involved.
    expect(stripUrlCredentials('https://host.example.com/board')).toBeNull();
    expect(stripUrlCredentials('http://localhost:8787/')).toBeNull();
  });

  it('returns null for a value that is not a URL', () => {
    expect(stripUrlCredentials('not a url')).toBeNull();
  });
});

describe('resolveCredentialRedirect', () => {
  const DIRTY = 'https://example-user:example-password@host.example.com/board';
  const CLEAN = 'https://host.example.com/board';

  it('redirects when the document URL carries credentials', () => {
    expect(resolveCredentialRedirect(DIRTY, DIRTY, false)).toBe(CLEAN);
  });

  it('redirects when only baseURI carries them', () => {
    // WebKit's Location::href() strips credentials while the base URL relative
    // fetches resolve against keeps them. Detecting only via the clean-looking
    // accessor is exactly how the first fix silently did nothing.
    expect(resolveCredentialRedirect(CLEAN, DIRTY, false)).toBe(CLEAN);
  });

  it('redirects when only the document URL carries them', () => {
    expect(resolveCredentialRedirect(DIRTY, CLEAN, false)).toBe(CLEAN);
  });

  it('does not redirect when both are already clean', () => {
    expect(resolveCredentialRedirect(CLEAN, CLEAN, false)).toBeNull();
  });

  it('does not redirect twice', () => {
    // Without this the page would reload forever if the credentials somehow
    // survived the navigation.
    expect(resolveCredentialRedirect(DIRTY, DIRTY, true)).toBeNull();
  });

  it('preserves path, query and hash when redirecting', () => {
    expect(
      resolveCredentialRedirect(
        'https://example-user:example-password@host.example.com/board?view=next#lane-3',
        CLEAN,
        false,
      ),
    ).toBe('https://host.example.com/board?view=next#lane-3');
  });
});
