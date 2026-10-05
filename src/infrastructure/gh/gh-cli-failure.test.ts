import { describe, expect, it } from 'vitest';
import { looksLikeGhUnauthenticated, looksLikeRateLimit } from './gh-cli-failure.js';

describe('looksLikeRateLimit', () => {
  it.each([
    'API rate limit exceeded for user ID 1. (HTTP 403)',
    'You have exceeded a secondary rate limit.',
    'gh: HTTP 429',
  ])('recognizes %j', (text) => {
    expect(looksLikeRateLimit(text)).toBe(true);
  });

  it('does not treat a bare HTTP 403 (permission / SSO) as a rate limit', () => {
    expect(looksLikeRateLimit('gh: Resource protected by organization SAML enforcement (HTTP 403)')).toBe(
      false,
    );
  });
});

describe('looksLikeGhUnauthenticated', () => {
  it.each([
    'To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.',
    'You are not logged into any GitHub hosts. To log in, run: gh auth login',
    'gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN environment variable.',
    'gh: Bad credentials (HTTP 401)',
    'authentication required',
  ])('recognizes %j', (text) => {
    expect(looksLikeGhUnauthenticated(text)).toBe(true);
  });

  it('does not react to the authenticated-requests hint of a rate limit message', () => {
    const text =
      'API rate limit exceeded for 203.0.113.1. (But here is the good news: Authenticated requests get a higher rate limit. Check out the documentation for more details.) (HTTP 403)';
    expect(looksLikeRateLimit(text)).toBe(true);
    expect(looksLikeGhUnauthenticated(text)).toBe(false);
  });

  it.each(['gh: Not Found (HTTP 404)', 'gh: Server Error (HTTP 500)', 'connection reset', ''])(
    'does not recognize %j',
    (text) => {
      expect(looksLikeGhUnauthenticated(text)).toBe(false);
    },
  );
});
