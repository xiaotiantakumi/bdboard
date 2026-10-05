import { describe, expect, it } from 'vitest';
import { foldHomePaths } from './issue-draft-identifier.js';
import { findLooseHomeRanges, findPublicHomeRanges } from './issue-public-home.js';
import { LINEAR_TIME_TEST_TIMEOUT_MS, expectLinearTime } from './linear-time-test-support.js';

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
  // 日本語の名前は偽の値 (「小田」を encodeURIComponent したもの)。
  const JP = encodeURIComponent('小田');
  it.each([
    ['upper-case hex', 'p=%2FUsers%2Fjdoe%2Fx', '%2FUsers%2Fjdoe'],
    ['lower-case hex', 'p=%2fhome%2fjdoe%2fx', '%2fhome%2fjdoe'],
    ['the end of the text', 'p=%2FUsers%2Fjdoe', '%2FUsers%2Fjdoe'],
    ['a lower-case "users"', 'p=%2Fusers%2Fjdoe%2Fx', '%2Fusers%2Fjdoe'],
    ['an encoded Japanese name', `/__open-in-editor?file=%2FUsers%2F${JP}%2Fwork%2Fx.ts`, `%2FUsers%2F${JP}`],
    ['an encoded space in the name', 'file=%2FUsers%2FJohn%20Smith%2Fx', '%2FUsers%2FJohn%20Smith'],
    ['encoded backslashes (a Windows path)', 'C%3A%5CUsers%5Cjdoe%5Cx.ts', '%5CUsers%5Cjdoe'],
    ['an encoded Windows path with encoded slashes', `C%3A%2FUsers%2F${JP}%2Fwork`, `%2FUsers%2F${JP}`],
    ['encoded backslashes with a lower-case hex digit', 'C%3a%5cUsers%5cjdoe%5cx', '%5cUsers%5cjdoe'],
  ])('finds the name in %s', (_name, text, expected) => {
    expect(found(text)).toEqual([expected]);
  });

  it('stops the name at an encoded separator or a delimiter, and at a lone percent sign', () => {
    expect(found('a=%2FUsers%2Fjdoe&b=%2Fx')).toEqual(['%2FUsers%2Fjdoe']);
    expect(found('a=%2FUsers%2Fjdoe%5Cx')).toEqual(['%2FUsers%2Fjdoe']);
    expect(found('a=%2FUsers%2Fjdoe%zz')).toEqual(['%2FUsers%2Fjdoe']);
    expect(found('a=%2FUsers%2F%2Fx')).toEqual([]);
  });

  it('leaves a name that is not a home directory alone', () => {
    expect(found('p=%2Fvar%2Flog%2Fx')).toEqual([]);
    expect(found('p=%2FUsersx%2Fjdoe')).toEqual([]);
  });
});

describe('a single-letter flag directly before the path (compiler and linker output)', () => {
  it.each([
    ['-I', 'c++ -I/Users/jdoe/Library/Caches/node-gyp/22.0.0/include/node -c x.cc', '/Users/jdoe/'],
    ['-L', 'ld: -L/home/jdoe/lib -lfoo', '/home/jdoe/'],
    ['-F', 'clang -F/Users/jdoe/Library/Frameworks x.m', '/Users/jdoe/'],
    ['-B at the start of the text', '-B/home/jdoe/x', '/home/jdoe/'],
    ['-I after a quote', `"-I/Users/jdoe/inc"`, '/Users/jdoe/'],
    ['-I after a comma', 'cc -Wl,-L/home/jdoe/lib', '/home/jdoe/'],
    ['-I with a Windows path', `cl -IC:${BS}Users${BS}jdoe${BS}inc x.c`, `C:${BS}Users${BS}jdoe${BS}`],
  ])('finds the name after %s', (_name, text, expected) => {
    expect(found(text)).toEqual([expected]);
  });

  it('is only for a flag that starts a word: a longer option or a word is not a flag', () => {
    expect(found('--include/Users/jdoe/x')).toEqual([]);
    expect(found('x-I/Users/jdoe/x')).toEqual([]);
    expect(found('foo-bar/Users/jdoe/x')).toEqual([]);
  });
});

describe('findLooseHomeRanges: what the last net reports even though the strict finder leaves it alone', () => {
  function loose(text: string): string[] {
    return findLooseHomeRanges(text).map((range) => text.slice(range.start, range.end));
  }

  it.each([
    ['a digit before', '12:00:00/Users/jdoe/x', '/Users/jdoe'],
    ['a letter before', 'abc/home/jdoe/x', '/home/jdoe'],
    ['a Windows path after a letter', `abcC:${BS}Users${BS}jdoe${BS}x`, `C:${BS}Users${BS}jdoe`],
    ['the stripped remains of an ANSI colour', '[36m/Users/jdoe/x', '/Users/jdoe'],
    ['a lower-case Windows path after the remains of tput sgr0', `Error:(Bc:${BS}users${BS}jdoe${BS}x`, `c:${BS}users${BS}jdoe`],
    ['a lower-case Windows path after the remains of an ANSI colour', `[36mc:${BS}users${BS}jdoe`, `c:${BS}users${BS}jdoe`],
    ['an upper-case USERS in a Windows path after a letter', `abC:${BS}USERS${BS}jdoe${BS}x`, `C:${BS}USERS${BS}jdoe`],
  ])('finds %s', (_name, text, expected) => {
    expect(findPublicHomeRanges(text)).toEqual([]);
    expect(loose(text)).toEqual([expected]);
  });

  it('does not report the ordinary routes it was meant to spare (lower-case users, a missing name)', () => {
    for (const text of ['GET /api/users/42', 'src/users/x.ts', '/Users/', '/home/', 'plain /usr/bin/node']) {
      expect(loose(text)).toEqual([]);
    }
  });

  it('reports a route that happens to be spelled /home/<word> (a deliberate over-report)', () => {
    expect(loose('https://example.com/home/feed')).toEqual(['/home/feed']);
  });

  it('stops the name at a delimiter', () => {
    expect(loose('x1/Users/jdoe/y')).toEqual(['/Users/jdoe']);
    expect(loose('x1/Users/jdoe:y')).toEqual(['/Users/jdoe']);
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

  // bdboard-0101: 壁時計の絶対値 (3000ms) ではなく、同じ形を 1/10 の長さと元の長さで測った比で線形を見る。
  it('scans hostile 100k inputs in time linear in their length', () => {
    expectLinearTime('issue-public-home: hostile 100k inputs', (n) => {
      const hostile = [
        '/Users/'.repeat(n(14_000)),
        '/home/'.repeat(n(16_000)),
        `C:${BS}Users${BS}`.repeat(n(10_000)),
        '%2FUsers%2F'.repeat(n(9_000)),
        `${BS}n/Users/a`.repeat(n(9_000)),
        '/Users/' + 'a '.repeat(n(50_000)),
        `C:${BS}Users${BS}` + 'a '.repeat(n(50_000)),
        `C:${BS}Users${BS}` + '('.repeat(n(100_000)),
        '/Volumes/' + 'a '.repeat(n(50_000)),
        '/Volumes/a'.repeat(n(10_000)),
        '/mnt/c/'.repeat(n(14_000)),
        `${BS}${BS}wsl$${BS}`.repeat(n(14_000)),
        '/'.repeat(n(100_000)),
        'a'.repeat(n(100_000)),
        '%2F'.repeat(n(33_000)),
        '%5C'.repeat(n(33_000)),
        '%2FUsers%2F' + '%E5'.repeat(n(33_000)),
        '%2FUsers%2F' + 'a%'.repeat(n(50_000)),
        '-I'.repeat(n(50_000)),
        `C:${BS}Users${BS}`.repeat(3) + BS.repeat(n(100_000)),
        'C:' + BS.repeat(n(100_000)),
      ];
      return () => {
        for (const value of hostile) {
          findPublicHomeRanges(value);
          findLooseHomeRanges(value);
        }
      };
    });
  }, LINEAR_TIME_TEST_TIMEOUT_MS);
});
