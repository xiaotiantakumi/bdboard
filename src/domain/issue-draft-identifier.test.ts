import { describe, expect, it } from 'vitest';
import { computeDraftFingerprint } from './issue-draft.js';
import {
  canonicalizeIdentifier,
  findHomePathRanges,
  foldHomePaths,
  hasVisibleText,
  isSingleLineDisplayText,
  isSingleLineText,
  sanitizeProjectName,
  stripNonLineText,
  stripPasteArtifacts,
} from './issue-draft-identifier.js';
import { LINEAR_TIME_TEST_TIMEOUT_MS, expectLinearTime } from './linear-time-test-support.js';

describe('isSingleLineText', () => {
  it('accepts ordinary one-line text, including API paths and non-ASCII', () => {
    for (const value of ['stop-ticket-gate.sh', 'GET /api/runs/:id', '0.1.2-beta+build.5', '日本語の名前', '']) {
      expect(isSingleLineText(value)).toBe(true);
    }
  });

  it('rejects newlines, other control characters and Unicode line separators', () => {
    for (const value of ['a\nb', 'a\r\nb', 'a\rb', 'a\tb', 'a\u0000b', 'a\u001bb', 'a\u007fb', 'a\u0085b', 'a\u2028b', 'a\u2029b', 'tail\n']) {
      expect(isSingleLineText(value)).toBe(false);
    }
  });

  // 1 つの文字 (または範囲の両端) ごとに 1 行。範囲ごと取りこぼすと、その行が落ちる。
  it.each([
    ['ZERO WIDTH SPACE', '\u200b'],
    ['ZERO WIDTH NON-JOINER', '\u200c'],
    ['ZERO WIDTH JOINER', '\u200d'],
    ['LEFT-TO-RIGHT MARK', '\u200e'],
    ['RIGHT-TO-LEFT MARK', '\u200f'],
    ['ARABIC LETTER MARK', '\u061c'],
    ['LRE', '\u202a'],
    ['RLE', '\u202b'],
    ['PDF', '\u202c'],
    ['LRO', '\u202d'],
    ['RLO', '\u202e'],
    ['WORD JOINER (start of 2060-2064)', '\u2060'],
    ['FUNCTION APPLICATION', '\u2061'],
    ['INVISIBLE TIMES', '\u2062'],
    ['INVISIBLE SEPARATOR', '\u2063'],
    ['INVISIBLE PLUS (end of 2060-2064)', '\u2064'],
    ['LRI', '\u2066'],
    ['RLI', '\u2067'],
    ['FSI', '\u2068'],
    ['PDI', '\u2069'],
    ['INHIBIT SYMMETRIC SWAPPING (start of 206A-206F)', '\u206a'],
    ['NOMINAL DIGIT SHAPES (end of 206A-206F)', '\u206f'],
    ['BOM / ZERO WIDTH NO-BREAK SPACE', '\ufeff'],
    ['INTERLINEAR ANNOTATION ANCHOR (start of FFF9-FFFB)', '\ufff9'],
    ['INTERLINEAR ANNOTATION TERMINATOR (end of FFF9-FFFB)', '\ufffb'],
    ['tag block start (U+E0000, unassigned)', '\u{e0000}'],
    ['unassigned code point inside the tag block (U+E0010)', '\u{e0010}'],
    ['LANGUAGE TAG', '\u{e0001}'],
    ['TAG SPACE', '\u{e0020}'],
    ['TAG LATIN SMALL LETTER A', '\u{e0061}'],
    ['CANCEL TAG (end of E0000-E007F)', '\u{e007f}'],
    ['SOFT HYPHEN', '\u00ad'],
    ['MONGOLIAN VOWEL SEPARATOR', '\u180e'],
    ['HANGUL CHOSEONG FILLER', '\u115f'],
    ['HANGUL JUNGSEONG FILLER', '\u1160'],
    ['HANGUL FILLER', '\u3164'],
    ['HALFWIDTH HANGUL FILLER', '\uffa0'],
  ])('rejects %s', (_name, char) => {
    expect(isSingleLineText(`a${char}b`)).toBe(false);
    expect(isSingleLineText(char)).toBe(false);
  });

  it('accepts the characters just outside those ranges and ordinary non-ASCII', () => {
    for (const value of ['a\u200ab', 'a\u2010b', 'a\u2030b', 'a\u2065b', 'a\ufefeb', 'a\uff00b', 'a b', 'ａｂｃ', '😀 ok']) {
      expect(isSingleLineText(value)).toBe(true);
    }
  });

  it('accepts variation selectors (including ideographic ones), combining marks and the ideographic space', () => {
    expect(isSingleLineText('\u2764\ufe0f')).toBe(true); // 絵文字の異体字選択子 VS16
    expect(isSingleLineText('\u845b\u{e0100}')).toBe(true); // 葛 + IVS (VS17)
    expect(isSingleLineText('\u845b\u{e01ef}')).toBe(true); // IVS の最後 (VS256)
    expect(isSingleLineText('\u304b\u3099')).toBe(true); // か + 結合の濁点 (濁点の分解形)
    expect(isSingleLineText('\u30ab\u3099\u30fc')).toBe(true);
    expect(isSingleLineText('foo\u3000bar')).toBe(true); // 全角スペース
  });
});

describe('isSingleLineDisplayText and stripPasteArtifacts (the dismiss reason)', () => {
  it('stripPasteArtifacts removes only the zero-width space and the BOM', () => {
    expect(stripPasteArtifacts('a\u200bb\ufeffc')).toBe('abc');
    expect(stripPasteArtifacts('a\u200db\u200cc\u202ed\n')).toBe('a\u200db\u200cc\u202ed\n');
  });

  it('allows the joiner and the non-joiner (emoji sequences) but nothing else invisible', () => {
    expect(isSingleLineDisplayText('👩\u200d💻 fixed it')).toBe(true);
    expect(isSingleLineDisplayText('می\u200cخواهم')).toBe(true);
    for (const bad of ['a\nb', 'a\u202eb', 'a\u2060b', 'a\u00adb', 'a\u200bb', 'a\ufeffb', 'a\u3164b', 'a\u{e0061}b']) {
      expect(isSingleLineDisplayText(bad)).toBe(false);
    }
  });
});

describe('hasVisibleText', () => {
  it('is false when only whitespace and joiners are left, true as soon as one visible character is', () => {
    for (const empty of ['', ' ', '\u200d', '\u200c\u200d', ' \u200d ', '\t\u200c\n']) {
      expect(hasVisibleText(empty)).toBe(false);
    }
    for (const shown of ['a', '👩\u200d💻', ' \u200d.', '\u3000x']) expect(hasVisibleText(shown)).toBe(true);
  });
});

describe('hasVisibleText — combining marks and the braille blank need something visible to attach to (bdboard-4lea)', () => {
  // 結合文字 (\p{M}) と点字の空白は、手前に付く文字が無ければ何も見えない。1 つの文字ごとに 1 行。
  it.each([
    ['a lone combining acute accent (U+0301)', '\u{0301}'],
    ['a lone Thai combining mark (U+0E31)', '\u{0E31}'],
    ['a lone enclosing mark (U+20DD)', '\u{20DD}'],
    ['VARIATION SELECTOR-16 alone (U+FE0F)', '\u{FE0F}'],
    ['COMBINING GRAPHEME JOINER alone (U+034F)', '\u{034F}'],
    ['BRAILLE PATTERN BLANK alone (U+2800)', '\u{2800}'],
    ['KHMER VOWEL INHERENT AQ alone (U+17B4)', '\u{17B4}'],
    ['an ideographic variation selector alone (U+E0100)', '\u{E0100}'],
    ['marks mixed with whitespace and joiners', ' \u{FE0F}\u{200D}\u{2800}\u{0301}\t'],
  ])('is false for %s', (_name, value) => {
    expect(hasVisibleText(value)).toBe(false);
  });

  it('stays true for text that has a visible character, including emoji sequences and accents', () => {
    expect(hasVisibleText('\u{200D}\u{1F469}\u{200D}\u{1F4BB}')).toBe(true); // 先頭に ZWJ が付いた絵文字の連なり
    expect(hasVisibleText('\u{1F469}\u{200D}\u{1F4BB}')).toBe(true);
    expect(hasVisibleText('e\u{0301}')).toBe(true); // é の分解形
    expect(hasVisibleText('\u{00E9}')).toBe(true); // é の合成形
    expect(hasVisibleText('\u{2764}\u{FE0F}')).toBe(true); // ❤ + VS16
    expect(hasVisibleText('\u{845B}\u{E0100}')).toBe(true); // 葛 + IVS
    expect(hasVisibleText('\u{0301} x')).toBe(true); // 結合文字のほかに、見える文字がある
    expect(hasVisibleText('\u{2800}\u{2801}')).toBe(true); // 点字 U+2801 (点が 1 つ) は見える
  });
});

describe('stripNonLineText', () => {
  it('removes every character isSingleLineText rejects, newlines included, and keeps the rest', () => {
    expect(stripNonLineText('a\nb\r\nc\u200dd\u202ee\u3164f\u{e0061}g')).toBe('abcdefg');
    expect(stripNonLineText('葛\u{e0100} か\u3099 \u3000 ok')).toBe('葛\u{e0100} か\u3099 \u3000 ok');
    expect(isSingleLineText(stripNonLineText('x\u2028y\u0085z\u200b'))).toBe(true);
  });
});

describe('foldHomePaths', () => {
  it('reports the exact ranges that folding replaces', () => {
    const input = 'x /Users/example-user/proj y C:\\Users\\example-user\\file';
    const ranges = findHomePathRanges(input);
    expect(ranges.map(({ start, end }) => input.slice(start, end))).toEqual([
      '/Users/example-user/',
      'C:\\Users\\example-user\\',
    ]);
    let rebuilt = '';
    let offset = 0;
    for (const range of ranges) {
      rebuilt += input.slice(offset, range.start) + '~/';
      offset = range.end;
    }
    expect(rebuilt + input.slice(offset)).toBe(foldHomePaths(input));
  });

  it.each([
    ['/home/example-user/x', '/home/example-user/'],
    ['C:\\Users\\example-user\\x', 'C:\\Users\\example-user\\'],
    ['\\\\wsl$\\Ubuntu\\home\\example-user\\x', '\\\\wsl$\\Ubuntu\\home\\example-user\\'],
  ])('finds the home-root portion of %s', (input, expected) => {
    const [range] = findHomePathRanges(input);
    expect(range).toBeDefined();
    expect(input.slice(range?.start, range?.end)).toBe(expected);
  });

  // 畳む形の一覧 (issue-draft-identifier.ts の foldHomePaths のコメントと docs/ISSUE-REPORTING.md と同じ)。
  it.each([
    // いまある形
    ['/Users/example-user/proj/.claude/hooks/stop.sh', '~/proj/.claude/hooks/stop.sh'],
    ['/home/example-user/.claude/hooks/stop.sh', '~/.claude/hooks/stop.sh'],
    ['C:\\Users\\example-user\\proj\\stop.sh', '~/proj\\stop.sh'],
    ['D:/Users/example-user/proj/stop.sh', '~/proj/stop.sh'],
    ['c:\\users\\example-user\\stop.sh', '~/stop.sh'],
    ['C:\\Users\\John Smith\\stop.sh', '~/stop.sh'],
    ['C:\\\\Users\\\\example-user\\\\stop.sh', '~/stop.sh'],
    ['/Users/example-user', '~/'],
    ['bash /home/example-user/x.sh --flag', 'bash ~/x.sh --flag'],
    ['--script=/Users/example-user/x.sh', '--script=~/x.sh'],
    ['"/Users/example-user/x.sh"', '"~/x.sh"'],
    ["'/Users/example-user/x.sh'", "'~/x.sh'"],
    ['file:///Users/example-user/x.sh', 'file://~/x.sh'],
    // 末尾に区切りが無い形 (引用符の直前・空白の直前で名前が終わる)
    ['"/Users/example-user"', '"~/"'],
    ['/Users/example-user --flag', '~/ --flag'],
    ['cd /home/example-user && ls', 'cd ~/ && ls'],
    // WSL・Git Bash・Cygwin
    ['/mnt/c/Users/example-user/proj/x.sh', '~/proj/x.sh'],
    ['/mnt/d/Users/example-user/x.sh', '~/x.sh'],
    ['/c/Users/example-user/proj/x.sh', '~/proj/x.sh'],
    ['/cygdrive/c/Users/example-user/proj/x.sh', '~/proj/x.sh'],
    ['\\\\wsl$\\Ubuntu\\home\\example-user\\proj\\x.sh', '~/proj\\x.sh'],
    ['\\\\wsl.localhost\\Ubuntu-22.04\\home\\example-user\\x.sh', '~/x.sh'],
    // macOS・BSD・コンテナのホームの別の置き場所
    ['/System/Volumes/Data/Users/example-user/proj/x.sh', '~/proj/x.sh'],
    ['/Volumes/Data/Users/example-user/proj/x.sh', '~/proj/x.sh'],
    ['/Volumes/Macintosh HD/Users/example-user/x.sh', '~/x.sh'],
    ['/var/home/example-user/x.sh', '~/x.sh'],
    ['/usr/home/example-user/x.sh', '~/x.sh'],
    ['/users/example-user/x.sh', '~/x.sh'],
    ['/USERS/example-user/x.sh', '~/x.sh'],
    // 直前の記号: ` [ , ; | < { ( = :
    ['`/Users/example-user/x.sh`', '`~/x.sh`'],
    ['[/Users/example-user/x.sh]', '[~/x.sh]'],
    ['a,/Users/example-user/x.sh', 'a,~/x.sh'],
    ['a;/Users/example-user/x.sh', 'a;~/x.sh'],
    ['a|/Users/example-user/x.sh', 'a|~/x.sh'],
    ['cat</Users/example-user/x.sh', 'cat<~/x.sh'],
    ['{/Users/example-user/x.sh}', '{~/x.sh}'],
    ['(/Users/example-user/x.sh)', '(~/x.sh)'],
    ['PATH=/usr/bin:/Users/example-user/bin:/bin', 'PATH=/usr/bin:~/bin:/bin'],
    // 名前は区切りで止まる: 一覧の区切りをまたいで、次のパスまで巻き込まない
    ['/home/example-user:/home/example-user/.local/bin', '~/:~/.local/bin'],
    ['x=/Users/example-user;y=/Users/example-user/z', 'x=~/;y=~/z'],
    ['C:\\Users\\example-user;C:\\Users\\example-user\\bin', '~/;~/bin'],
    ['C:\\Users\\example-user,D:\\Users\\example-other\\x', '~/,~/x'],
    ['/Users/example-user|/home/example-other/x', '~/|~/x'],
    // \\?\ と file:///C:/ の前置き
    ['\\\\?\\C:\\Users\\example-user\\x.sh', '\\\\?\\~/x.sh'],
    ['file:///C:/Users/example-user/x.sh', 'file:///~/x.sh'],
    // 共有の場所も同じ形なので畳む (区別しない)
    ['/Users/Shared/x.sh', '~/x.sh'],
    ['C:\\Users\\Public\\x.sh', '~/x.sh'],
    ['/home/linuxbrew/.linuxbrew/bin/x', '~/.linuxbrew/bin/x'],
    // 引数が名前に巻き込まれる (ユーザー名を残さないことを優先する)
    ['bash C:\\Users\\example-user --flag', 'bash ~/'],
    ['C:\\Users\\John Smith --flag', '~/'],
    // Windows の名前は空白を含みうるが、空白の直後がドライブ文字か / \ なら次のパスの頭なので、そこで名前を終える (bdboard-4lea)
    ['cd C:\\Users\\example-user && node C:\\Users\\example-user\\proj\\x.js', 'cd ~/ ~/proj\\x.js'],
    ['C:\\Users\\example-user D:\\Users\\example-user\\x', '~/ ~/x'],
    ['cp C:\\Users\\example-user /home/example-user/x', 'cp ~/ ~/x'],
    ['C:\\Users\\example-user D:/Users/example-other/x', '~/ ~/x'],
    ['C:\\Users\\example-user /Users/example-other/x', '~/ ~/x'],
    ['C:\\Users\\example-user  D:\\Users\\example-user\\x', '~/ ~/x'],
    ['C:\\Users\\John Smith D:\\Users\\example-user\\x', '~/ ~/x'],
    ['C:\\Users\\example-user \\\\wsl$\\Ubuntu\\home\\example-other\\x', '~/ ~/x'],
    ['C:\\Users\\example-user D:\\data', '~/ D:\\data'],
    // 空白か "(" の直後が次のパスの頭 ("(" を挟んでもよい) なら、その手前で名前を終える (4lea の再レビューの F1・F2)
    ['C:\\Users\\example-user (D:\\Users\\example-other\\x)', '~/ (~/x)'],
    ['C:\\Users\\example-user (/home/example-other/x)', '~/ (~/x)'],
    ['C:\\Users\\example-user (\\\\wsl$\\Ubuntu\\home\\example-other\\x)', '~/ (~/x)'],
    ['C:\\Users\\example-user failed (C:\\Users\\example-other\\x)', '~/ (~/x)'],
    ['C:\\Users\\example-user x(D:\\Users\\example-other)', '~/(~/)'],
    ['C:\\Users\\example-user(D:\\Users\\example-other\\x)', '~/(~/x)'],
    ['cwd C:\\Users\\example-user (C:\\Users\\example-user\\x.js:1:2)', 'cwd ~/ (~/x.js:1:2)'],
    ['/home/example-user(/home/example-other/y', '~/(~/y'],
    ['\\\\wsl$\\Ubuntu\\home\\example-user(/home/example-other/y', '~/(~/y'],
    // 名前の中の "(" は、後ろが次のパスの頭でなければ名前に入れる (止まる文字にはしない)
    ['/Users/(example-user/x', '~/x'],
    ['C:\\Users\\(example-user\\x', '~/x'],
    ['C:\\Users\\example-user (work\\x', '~/x'],
    ['two /Users/a/x.sh and /home/b/y.sh', 'two ~/x.sh and ~/y.sh'],
    ['  /Users/example-user/x.sh  ', '  ~/x.sh  '],
  ])('%s -> %s', (input, expected) => {
    expect(foldHomePaths(input)).toBe(expected);
    expect(foldHomePaths(expected)).toBe(expected);
  });

  it.each([
    'stop-ticket-gate.sh',
    'GET /api/runs/:id',
    'GET /api/home/x/y',
    'POST /api/Users/42/profile',
    '/opt/Users/example-user/x.sh',
    '/Volumes/Data/projects/Users/example-user',
    '/mnt/cc/Users/example-user/x.sh',
    '/api/c/Users/42',
    '/srv/home/example-user/x.sh',
    'C:\\Program Files\\Users\\x',
    '~/proj/stop.sh',
    '~example-user/stop.sh',
    './hooks/stop.sh',
    'Users/example-user/x.sh',
    'jq-missing',
  ])('leaves %s alone', (value) => {
    expect(foldHomePaths(value)).toBe(value);
  });

  // 名前の終わりの記号。どの形の「ホームの根」でも、名前だけを畳んで記号とそのあとは残す。
  it.each(['`', ':', ';', ',', '|', '<', '>', ')', ']', '}', '=', '"', "'", '\n', '\r', '\r\n'])(
    'stops a bare home root at %j and keeps what follows',
    (delimiter) => {
      for (const root of ['/Users/example-user', 'C:\\Users\\example-user', '\\\\wsl$\\Ubuntu\\home\\example-user']) {
        expect(foldHomePaths(`${root}${delimiter}rest`)).toBe(`~/${delimiter}rest`);
      }
    },
  );

  it('keeps every other line of a multi-line body when one line holds a raw Windows home root', () => {
    const lines = Array.from({ length: 11 }, (_, i) => `line${i}`);
    for (const raw of ['C:\\Users\\example-user', 'C:\\Users\\example-user\\bin', '/Users/example-user']) {
      for (const eol of ['\n', '\r\n']) {
        const folded = foldHomePaths(lines.map((line, i) => (i === 5 ? `${line} ${raw}` : line)).join(eol));
        expect(folded.split(/\r?\n/)).toHaveLength(11);
        for (const [i, line] of lines.entries()) {
          if (i !== 5) expect(folded).toContain(line);
        }
        expect(folded).not.toContain('example-user');
      }
    }
  });

  it('still reads a Windows user name with a space, and stops at the first delimiter after it', () => {
    expect(foldHomePaths('C:\\Users\\John Smith\\x')).toBe('~/x');
    expect(foldHomePaths('C:\\Users\\John Smith;rest')).toBe('~/;rest');
  });

  // bdboard-4lea: 空白を含む Windows の名前が、空白のあとの次のパスの頭 (ドライブ文字・/・\) まで飲み込むと、
  // 次のパスのユーザー名が残った ("cd ~/:\Users\alice\proj\x.js")。どの形でも、ユーザー名は 1 つも残らない。
  it.each([
    ['a second Windows path after a command', 'cd C:\\Users\\example-user && node C:\\Users\\example-user\\proj\\x.js'],
    ['a second drive path right after the bare root', 'C:\\Users\\example-user D:\\Users\\example-user\\x'],
    ['a POSIX path right after the bare root', 'cp C:\\Users\\example-user /home/example-user/x'],
    ['two users on two drives', 'C:\\Users\\example-user D:\\Users\\example-other\\x'],
    ['a drive path inside parentheses', 'C:\\Users\\example-user (D:\\Users\\example-other\\x)'],
    ['a POSIX path inside parentheses', 'C:\\Users\\example-user (/home/example-other/x)'],
    ['a WSL UNC path inside parentheses', 'C:\\Users\\example-user (\\\\wsl$\\Ubuntu\\home\\example-other\\x)'],
    ['a word and a parenthesised path', 'C:\\Users\\example-user failed (C:\\Users\\example-other\\x)'],
    ['a parenthesised path glued to a word', 'C:\\Users\\example-user x(D:\\Users\\example-other)'],
    ['a parenthesised path glued to the bare root', 'C:\\Users\\example-user(D:\\Users\\example-other\\x)'],
    ['a stack frame in parentheses', 'cwd C:\\Users\\example-user (C:\\Users\\example-other\\x.js:1:2)'],
    ['a POSIX path glued behind a bare POSIX root', '/home/example-user(/home/example-other/y'],
    ['a POSIX path glued behind a bare WSL root', '\\\\wsl$\\Ubuntu\\home\\example-user(/home/example-other/y'],
  ])('leaves no user name behind: %s', (_label, input) => {
    const folded = foldHomePaths(input);
    expect(folded).not.toContain('example-user');
    expect(folded).not.toContain('example-other');
    expect(folded).not.toContain('Users');
    expect(folded).not.toContain(':\\');
  });

  // 既知の取りこぼし (docs/ISSUE-REPORTING.md の「ホーム配下のパス」): ` ) { } ' は Windows のアカウント名に使えるが、
  // 名前の終わりの記号でもある。名前の途中にあると、そこから先の名前が残る。名前の終わりの記号のテスト
  // ("C:\Users\u)rest" が "~/)rest") と両立しないので、これらを名前に入れる案は見送った。変えるなら docs も直す。
  it.each([
    ["a quote inside the name (O'Brien-like)", "C:\\Users\\example'user\\x", "~/'user\\x"],
    ['a closing parenthesis inside the name', 'C:\\Users\\example)user\\x', '~/)user\\x'],
    ['a closing brace inside the name', 'C:\\Users\\example}user\\x', '~/}user\\x'],
    ['a backtick inside the name', 'C:\\Users\\example`user\\x', '~/`user\\x'],
    ['a name that starts with a brace is not folded at all', 'C:\\Users\\{example-user}\\x', 'C:\\Users\\{example-user}\\x'],
  ])('known miss: %s', (_label, input, expected) => {
    expect(foldHomePaths(input)).toBe(expected);
  });

  // bdboard-0101: 壁時計の絶対値 (2000ms) ではなく、同じ形を 1/10 の長さと元の長さで測った比で線形を見る。
  it('is linear on long hostile input', () => {
    expectLinearTime('issue-draft-identifier: foldHomePaths hostile input', (n) => {
      const hostile = [
        `/Users/${'a'.repeat(n(100_000))}`,
        `${'/Users/'.repeat(n(20_000))}x`,
        `C:\\Users\\${' '.repeat(n(100_000))}`,
        `${'/Volumes/x '.repeat(n(10_000))}`,
        `${'\\\\wsl$\\'.repeat(n(10_000))}`,
        `${'C:\\Users\\a D:\\Users\\b '.repeat(n(10_000))}`,
        `C:\\Users\\${'a '.repeat(n(50_000))}`,
        `C:\\Users\\${'a ('.repeat(n(30_000))}`,
        `C:\\Users\\${'(('.repeat(n(50_000))}`,
        `${'/home/a('.repeat(n(20_000))}`,
        `/home/${'('.repeat(n(100_000))}`,
      ];
      return () => {
        for (const input of hostile) foldHomePaths(input);
      };
    });
  }, LINEAR_TIME_TEST_TIMEOUT_MS);
});

describe('canonicalizeIdentifier', () => {
  it('trims and folds home paths', () => {
    expect(canonicalizeIdentifier('  /Users/example-user/proj/stop.sh \n')).toBe('~/proj/stop.sh');
    expect(canonicalizeIdentifier('  stop.sh  ')).toBe('stop.sh');
    expect(canonicalizeIdentifier('GET /api/home/x')).toBe('GET /api/home/x');
  });

  it('gives two users running the same script the same fingerprint', () => {
    const fingerprintFor = (source: string) =>
      computeDraftFingerprint({ kind: 'B', source: canonicalizeIdentifier(source), errorText: 'boom' });
    expect(fingerprintFor('/Users/example-user/proj/stop.sh')).toBe(
      fingerprintFor('/home/example-other/proj/stop.sh'),
    );
    expect(fingerprintFor('/mnt/c/Users/example-user/proj/stop.sh')).toBe(
      fingerprintFor('C:/Users/example-other/proj/stop.sh'),
    );
  });
});

describe('sanitizeProjectName', () => {
  it.each([
    ['proj', 'proj'],
    ['  proj  ', 'proj'],
    // 行の区切りと空白は、取り除かず空白に替える (つなげるとパスが前の語に貼り付く)
    ['my\nproj', 'my proj'],
    ['my\r\nproj\u2028', 'my proj'],
    ['a\t\tb', 'a b'],
    ['proj\u200b\u200b', 'proj'],
    ['👩\u200d💻-tools', '👩💻-tools'],
    ['葛\u{e0100}-tools', '葛\u{e0100}-tools'],
    ['/Users/example-user/proj', '~/proj'],
    ['/Users/example-user\n/proj', '~/ /proj'],
    // 見えない文字でパスの形を崩した値も、取り除いた後の見た目で畳む
    ['/Us\u200bers/example-user/proj', '~/proj'],
    // パスの手前の区切りになる文字 (タブ・改行・BOM・行区切り) は、前の語にパスを貼り付けない
    ['proj\t/Users/example-user/proj', 'proj ~/proj'],
    ['proj\n/Users/example-user/proj', 'proj ~/proj'],
    ['proj\r/Users/example-user/proj', 'proj ~/proj'],
    ['proj\v/Users/example-user/proj', 'proj ~/proj'],
    ['proj\f/Users/example-user/proj', 'proj ~/proj'],
    ['proj\ufeff/Users/example-user/proj', 'proj ~/proj'],
    ['proj\u2028/Users/example-user/proj', 'proj ~/proj'],
    ['proj\u2029/Users/example-user/proj', 'proj ~/proj'],
    ['proj\t/Us\u200bers/example-user/proj', 'proj ~/proj'],
    ['\u200b\n\u202e', ''],
    // 画面では空白に見える文字 (ハングルの埋め字 U+115F・U+1160・U+3164・U+FFA0 と U+180E) も、取り除かず空白に替える:
    // 取り除くと前の語にパスが貼り付き、畳めない (bdboard-4lea)
    ['proj\u{3164}/Users/example-user/proj', 'proj ~/proj'],
    ['proj\u{115F}/Users/example-user/proj', 'proj ~/proj'],
    ['proj\u{1160}/Users/example-user/proj', 'proj ~/proj'],
    ['proj\u{FFA0}/Users/example-user/proj', 'proj ~/proj'],
    ['proj\u{180E}/Users/example-user/proj', 'proj ~/proj'],
    ['proj\u{3164}C:\\Users\\example-user\\proj', 'proj ~/proj'],
    ['pro\u{3164}j', 'pro j'],
    ['a\u{3164}\u{3164}\u{FFA0}b', 'a b'],
    ['\u{3164}proj\u{180E}', 'proj'],
    ['   ', ''],
  ])('%j -> %j', (input, expected) => {
    expect(sanitizeProjectName(input)).toBe(expected);
    expect(sanitizeProjectName(expected)).toBe(expected);
  });

  // 決めたこと (bdboard-4lea): 幅ゼロで何も見えない文字 (ZWSP U+200B・WORD JOINER U+2060・ソフトハイフン U+00AD) は
  // 空白に替えず取り除く。空白に替えると "/Us<ZWSP>ers/name" のような形崩しが畳めなくなる。取り除いた結果は画面に見える
  // 文字列と一致する (手前の語にパスが貼り付いて見えるなら、貼り付いたまま)。
  it.each([['U+200B', '\u{200B}'], ['U+2060', '\u{2060}'], ['U+00AD', '\u{00AD}']])(
    'strips the invisible zero-width %s instead of turning it into a space',
    (_name, ch) => {
      expect(sanitizeProjectName(`pro${ch}j`)).toBe('proj');
      expect(sanitizeProjectName(`/Us${ch}ers/example-user/proj`)).toBe('~/proj');
      expect(sanitizeProjectName(`proj${ch}/Users/example-user/proj`)).toBe(
        sanitizeProjectName('proj/Users/example-user/proj'),
      );
    },
  );
});
