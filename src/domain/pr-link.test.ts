import { describe, expect, it } from 'vitest';
import { extractLatestPrUrl } from './pr-link.js';

describe('extractLatestPrUrl', () => {
  it('extracts a single PR URL from one comment', () => {
    const url = extractLatestPrUrl([
      { text: 'PR: https://github.com/xiaotiantakumi/bdboard/pull/42' },
    ]);

    expect(url).toBe('https://github.com/xiaotiantakumi/bdboard/pull/42');
  });

  it('uses the latest PR URL when multiple comments contain PR links', () => {
    const url = extractLatestPrUrl([
      { text: 'PR: https://github.com/xiaotiantakumi/bdboard/pull/1' },
      { text: 'reopened with PR: https://github.com/xiaotiantakumi/bdboard/pull/2' },
    ]);

    expect(url).toBe('https://github.com/xiaotiantakumi/bdboard/pull/2');
  });

  it('strips trailing punctuation from URLs embedded in Japanese prose', () => {
    const url = extractLatestPrUrl([
      {
        text: '詳細は PR: https://github.com/xiaotiantakumi/bdboard/pull/1 を見てください。',
      },
    ]);

    expect(url).toBe('https://github.com/xiaotiantakumi/bdboard/pull/1');
  });

  it('strips wrapping parentheses from URLs', () => {
    const url = extractLatestPrUrl([
      { text: 'PR: (https://github.com/xiaotiantakumi/bdboard/pull/2)' },
    ]);

    expect(url).toBe('https://github.com/xiaotiantakumi/bdboard/pull/2');
  });

  it('returns null when no PR pattern is present', () => {
    const url = extractLatestPrUrl([
      { text: 'no link here' },
      { text: 'still nothing' },
    ]);

    expect(url).toBeNull();
  });

  it('ignores non-http PR values and returns null', () => {
    const url = extractLatestPrUrl([{ text: 'PR: 未定' }]);

    expect(url).toBeNull();
  });
});
