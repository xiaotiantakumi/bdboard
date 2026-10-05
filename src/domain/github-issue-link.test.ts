import { describe, expect, it } from 'vitest';
import {
  excludePullRequests,
  findUnlinkedIssues,
  linkedIssueNumbers,
  parseRepoSlug,
} from './github-issue-link.js';

// 用例の多くは scripts/check-gh-issues.test.mjs から写した (判定がスクリプトと一致することの確認)。
describe('parseRepoSlug', () => {
  it('derives a slug from the repository URL', () => {
    expect(parseRepoSlug('git+https://github.com/xiaotiantakumi/bdboard.git')).toBe(
      'xiaotiantakumi/bdboard',
    );
  });

  it('accepts ssh, https and bare owner/repo forms', () => {
    expect(parseRepoSlug('git@github.com:owner/repo.git')).toBe('owner/repo');
    expect(parseRepoSlug('https://github.com/owner/repo')).toBe('owner/repo');
    expect(parseRepoSlug('  owner/repo  ')).toBe('owner/repo');
    expect(parseRepoSlug('owner/my.repo_1-x')).toBe('owner/my.repo_1-x');
  });

  it('throws when the value is not a string', () => {
    expect(() => parseRepoSlug(undefined)).toThrow('GitHub repository URL is missing');
    expect(() => parseRepoSlug(42)).toThrow('GitHub repository URL is missing');
  });

  it.each(['', 'owner', 'a/b/c', 'https://example.com/o/r', 'a b/c'])(
    'rejects the malformed value %j',
    (value) => {
      expect(() => parseRepoSlug(value)).toThrow('GitHub repository URL is invalid');
    },
  );

  it.each(['../x', 'a/..', './r', 'o/.', 'o/r?x=1', 'o/r#frag', 'o%2f/r', 'o/r%00', 'o/r:x'])(
    'rejects path-like or special characters in the slug: %j',
    (value) => {
      expect(() => parseRepoSlug(value)).toThrow('GitHub repository URL is invalid');
    },
  );
});

describe('linkedIssueNumbers', () => {
  it('recognizes short refs and this repository issue URLs case-insensitively', () => {
    const refs = [
      'GH-431',
      'https://github.com/xiaotiantakumi/bdboard/issues/432',
      'https://github.com/elsewhere/bdboard/issues/433',
    ];
    expect([...linkedIssueNumbers(refs, 'xiaotiantakumi/bdboard')]).toEqual([431, 432]);
  });

  it('matches case-insensitively, trims, and accepts http', () => {
    const refs = [' gh-1 ', 'HTTP://GITHUB.COM/Owner/Repo/issues/2'];
    expect([...linkedIssueNumbers(refs, 'owner/repo')]).toEqual([1, 2]);
  });

  it('does not recognize look-alike refs', () => {
    const refs = [
      'gh-abc',
      'gh-',
      'gh-12x',
      'xgh-12',
      'https://github.com/owner/repo/issues/12/comments',
      'https://github.com/owner/repo/pull/12',
      'https://github.com/owner/repo/issues/',
      '',
    ];
    expect(linkedIssueNumbers(refs, 'owner/repo').size).toBe(0);
  });

  it('does not treat a dot in the slug as a wildcard', () => {
    const refs = ['https://github.com/aXb/c/issues/12', 'https://github.com/a.b/c/issues/13'];
    expect([...linkedIssueNumbers(refs, 'a.b/c')]).toEqual([13]);
  });
});

describe('findUnlinkedIssues', () => {
  it('finds only issues without a link, keeping the rows as they are', () => {
    const issues = [
      { number: 1, title: 'one' },
      { number: 2, title: 'two' },
    ];
    expect(findUnlinkedIssues(issues, new Set([2]))).toEqual([{ number: 1, title: 'one' }]);
    expect(findUnlinkedIssues(issues, new Set())).toEqual(issues);
    expect(findUnlinkedIssues([], new Set([1]))).toEqual([]);
  });
});

describe('excludePullRequests', () => {
  it('removes pull requests and drops the pullRequest marker from the rest', () => {
    const rows = [
      { number: 431, title: 'issue', pullRequest: false },
      { number: 432, title: 'PR', pullRequest: true },
    ];
    expect(excludePullRequests(rows)).toEqual([{ number: 431, title: 'issue' }]);
    expect('pullRequest' in excludePullRequests(rows)[0]).toBe(false);
  });

  it('does not mutate its input', () => {
    const rows = [{ number: 1, pullRequest: false }];
    excludePullRequests(rows);
    expect(rows).toEqual([{ number: 1, pullRequest: false }]);
  });
});
