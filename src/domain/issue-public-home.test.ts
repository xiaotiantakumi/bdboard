import { describe, expect, it } from 'vitest';
import { foldHomePaths } from './issue-draft-identifier.js';
import { findPublicHomeRanges } from './issue-public-home.js';

// 名前はすべて偽の値 (jdoe)。バックスラッシュは String.raw で書く。
const BS = '\\';

function found(text: string): string[] {
  return findPublicHomeRanges(text).map((range) => text.slice(range.start, range.end));
}

describe('home paths where the fingerprint matcher (foldHomePaths) stays silent', () => {
  it.each([
    ['a CJK corner bracket', '「/Users/jdoe/work/x.ts」を開けない', '/Users/jdoe/'],
    ['a full-width parenthesis', '（/Users/jdoe/work/x.ts）', '/Users/jdoe/'],
    ['a full-width colon', 'パス：/Users/jdoe/work/x.ts', '/Users/jdoe/'],
    ['a CJK comma', 'ログ、/Users/jdoe/work/x.ts', '/Users/jdoe/'],
    ['an arrow', '→/Users/jdoe/work/x.ts', '/Users/jdoe/'],
    ['a CJK bracket and /home', '『/home/jdoe/x』', '/home/jdoe/'],
    ['CJK letters directly before', 'パス/home/jdoe/xで失敗', '/home/jdoe/'],
    ['a no-break space', 'a\u00A0/home/jdoe/x', '/home/jdoe/'],
    ['an ideographic space', 'a\u3000/home/jdoe/x', '/home/jdoe/'],
    ['a JSON-escaped newline', `{"o":"a${BS}n/Users/jdoe/x"}`, '/Users/jdoe/'],
    ['a JSON-escaped tab', `{"o":"a${BS}t/home/jdoe/x"}`, '/home/jdoe/'],
    ['a JSON-escaped CRLF', `{"o":"a${BS}r${BS}n/Users/jdoe/x"}`, '/Users/jdoe/'],
    ['a percent-encoded newline', 'x%0A/Users/jdoe/x', '/Users/jdoe/'],
    ['a percent-encoded equals sign', 'p%3D/home/jdoe/x', '/home/jdoe/'],
    ['Vite /@fs/', 'at http://localhost:5173/@fs/Users/jdoe/lib/x.js', '/Users/jdoe/'],
    ['vscode://file', 'open vscode://file/Users/jdoe/x.ts:1', '/Users/jdoe/'],
    ['an upper-case FILE:///', 'FILE:///Users/jdoe/x.ts', '/Users/jdoe/'],
    ['a star', 'glob */Users/jdoe/x', '/Users/jdoe/'],
    ['an at sign', 'pkg@/Users/jdoe/x', '/Users/jdoe/'],
    ['an exclamation mark', 'x!/home/jdoe/x', '/home/jdoe/'],
    ['a plus', 'a+/home/jdoe/x', '/home/jdoe/'],
    ['a hash', '#/home/jdoe/x', '/home/jdoe/'],
    ['an ampersand', 'a&/home/jdoe/x', '/home/jdoe/'],
    ['a question mark', 'a?/home/jdoe/x', '/home/jdoe/'],
    ['a dot', 'a./home/jdoe/x', '/home/jdoe/'],
  ])('finds the name after %s', (_name, text, expected) => {
    expect(found(text)).toEqual([expected]);
  });

  it('really covers a gap: the fingerprint matcher (foldHomePaths, left unchanged on purpose) leaves these names in', () => {
    for (const text of ['「/Users/jdoe/x」', `a${BS}n/Users/jdoe/x`, '/@fs/Users/jdoe/x', 'glob */Users/jdoe/x', 'パス/home/jdoe/x']) {
      expect(foldHomePaths(text)).toContain('jdoe');
      expect(found(text).length).toBe(1);
    }
  });

  it('is only about the start: the same paths are found where the fingerprint matcher already finds them', () => {
    for (const text of ['/Users/jdoe/x', 'at /home/jdoe/x:1', '"/Users/jdoe/x"', 'cwd=/home/jdoe/x']) {
      expect(found(text).length).toBe(1);
      expect(foldHomePaths(text)).not.toContain('jdoe');
    }
  });
});

describe('Windows home paths', () => {
  it.each([
    ['backslashes', `C:${BS}Users${BS}jdoe${BS}x`, `C:${BS}Users${BS}jdoe${BS}`],
    ['slashes', 'C:/Users/jdoe/x', 'C:/Users/jdoe/'],
    ['JSON-escaped backslashes', `C:${BS}${BS}Users${BS}${BS}jdoe${BS}${BS}x`, `C:${BS}${BS}Users${BS}${BS}jdoe${BS}${BS}`],
    ['lower case', `c:${BS}users${BS}jdoe${BS}x`, `c:${BS}users${BS}jdoe${BS}`],
    ['CJK letters before', `パスC:${BS}Users${BS}jdoe${BS}x`, `C:${BS}Users${BS}jdoe${BS}`],
    ['a JSON-escaped newline before', `a${BS}nC:${BS}${BS}Users${BS}${BS}jdoe${BS}${BS}x`, `C:${BS}${BS}Users${BS}${BS}jdoe${BS}${BS}`],
    ['a space in the name', `x C:${BS}Users${BS}John Smith${BS}x`, `C:${BS}Users${BS}John Smith${BS}`],
  ])('finds %s', (_name, text, expected) => {
    expect(found(text)).toEqual([expected]);
  });

  it('finds the WSL views of a Windows home', () => {
    expect(found('at /mnt/c/Users/jdoe/work/x')).toEqual(['/mnt/c/Users/jdoe/']);
    expect(found(`at ${BS}${BS}wsl$${BS}Ubuntu${BS}home${BS}jdoe${BS}x`)).toEqual([`${BS}${BS}wsl$${BS}Ubuntu${BS}home${BS}jdoe${BS}`]);
  });
});

describe('percent-encoded slashes', () => {
  it.each([
    ['upper-case hex', 'p=%2FUsers%2Fjdoe%2Fx', '%2FUsers%2Fjdoe'],
    ['lower-case hex', 'p=%2fhome%2fjdoe%2fx', '%2fhome%2fjdoe'],
    ['the end of the text', 'p=%2FUsers%2Fjdoe', '%2FUsers%2Fjdoe'],
  ])('finds the name in %s', (_name, text, expected) => {
    expect(found(text)).toEqual([expected]);
  });
});

describe('paths that are not home directories', () => {
  it.each([
    ['a REST path', 'GET /api/users/42'],
    ['a relative path', 'src/users/x.ts'],
    ['a versioned REST path', 'GET /v1/home/feed'],
    ['a host path', 'https://example.com/home/feed'],
    ['a directory without a name', '/Users/'],
    ['/usr/bin', 'plain text 😀 /usr/bin/node'],
  ])('leaves %s alone', (_name, text) => {
    expect(found(text)).toEqual([]);
  });

  it('accepts over-redaction after "file" (a trade-off for catching file:// URLs written in odd ways)', () => {
    expect(found('profile/home/x')).toEqual(['/home/x']);
  });

  it('documents what is not covered: other home layouts and names with an apostrophe', () => {
    expect(found(' /export/home/jdoe/x')).toEqual([]);
    expect(found(` C:${BS}Documents and Settings${BS}jdoe${BS}x`)).toEqual([]);
    expect(found(' ~jdoe/x')).toEqual([]);
    expect(found(` C:${BS}Users${BS}O'Brien${BS}x`)).toEqual([`C:${BS}Users${BS}O`]);
  });
});

describe('state and time', () => {
  it('builds a fresh pattern on every call (no lastIndex carried between calls)', () => {
    const text = 'a /Users/jdoe/x ' + 'pad '.repeat(40);
    expect(found(text)).toEqual(['/Users/jdoe/']);
    expect(found(text)).toEqual(['/Users/jdoe/']);
    expect(found('/home/jdoe/x')).toEqual(['/home/jdoe/']);
  });

  it('scans hostile 100k inputs in well under three seconds', () => {
    const hostile = [
      '/Users/'.repeat(14_000),
      '/home/'.repeat(16_000),
      `C:${BS}Users${BS}`.repeat(10_000),
      '%2FUsers%2F'.repeat(9_000),
      `${BS}n/Users/a`.repeat(9_000),
      '/Users/' + 'a '.repeat(50_000),
      `C:${BS}Users${BS}` + 'a '.repeat(50_000),
      `C:${BS}Users${BS}` + '('.repeat(100_000),
      '/Volumes/' + 'a '.repeat(50_000),
      '/Volumes/a'.repeat(10_000),
      '/mnt/c/'.repeat(14_000),
      `${BS}${BS}wsl$${BS}`.repeat(14_000),
      '/'.repeat(100_000),
      'a'.repeat(100_000),
      '%2F'.repeat(33_000),
    ];
    const started = performance.now();
    for (const value of hostile) findPublicHomeRanges(value);
    expect(performance.now() - started).toBeLessThan(3000);
  });
});
