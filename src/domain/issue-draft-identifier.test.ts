import { describe, expect, it } from 'vitest';
import { computeDraftFingerprint } from './issue-draft.js';
import {
  canonicalizeIdentifier,
  foldHomePaths,
  isSingleLineDisplayText,
  isSingleLineText,
  sanitizeProjectName,
  stripNonLineText,
  stripPasteArtifacts,
} from './issue-draft-identifier.js';

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

describe('stripNonLineText', () => {
  it('removes every character isSingleLineText rejects, newlines included, and keeps the rest', () => {
    expect(stripNonLineText('a\nb\r\nc\u200dd\u202ee\u3164f\u{e0061}g')).toBe('abcdefg');
    expect(stripNonLineText('葛\u{e0100} か\u3099 \u3000 ok')).toBe('葛\u{e0100} か\u3099 \u3000 ok');
    expect(isSingleLineText(stripNonLineText('x\u2028y\u0085z\u200b'))).toBe(true);
  });
});

describe('foldHomePaths', () => {
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
    // \\?\ と file:///C:/ の前置き
    ['\\\\?\\C:\\Users\\example-user\\x.sh', '\\\\?\\~/x.sh'],
    ['file:///C:/Users/example-user/x.sh', 'file:///~/x.sh'],
    // 共有の場所も同じ形なので畳む (区別しない)
    ['/Users/Shared/x.sh', '~/x.sh'],
    ['C:\\Users\\Public\\x.sh', '~/x.sh'],
    ['/home/linuxbrew/.linuxbrew/bin/x', '~/.linuxbrew/bin/x'],
    // 引数が名前に巻き込まれる (ユーザー名を残さないことを優先する)
    ['bash C:\\Users\\example-user --flag', 'bash ~/'],
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

  it('is linear on long hostile input', () => {
    const hostile = [
      `/Users/${'a'.repeat(100_000)}`,
      `${'/Users/'.repeat(20_000)}x`,
      `C:\\Users\\${' '.repeat(100_000)}`,
      `${'/Volumes/x '.repeat(10_000)}`,
      `${'\\\\wsl$\\'.repeat(10_000)}`,
    ];
    const started = Date.now();
    for (const input of hostile) foldHomePaths(input);
    expect(Date.now() - started).toBeLessThan(2000);
  });
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
    ['my\nproj', 'myproj'],
    ['my\r\nproj\u2028', 'myproj'],
    ['👩\u200d💻-tools', '👩💻-tools'],
    ['葛\u{e0100}-tools', '葛\u{e0100}-tools'],
    ['/Users/example-user/proj', '~/proj'],
    ['/Users/example-user\n/proj', '~/proj'],
    // 見えない文字でパスの形を崩した値も、取り除いた後の見た目で畳む
    ['/Us\u200bers/example-user/proj', '~/proj'],
    ['\u200b\n\u202e', ''],
    ['   ', ''],
  ])('%j -> %j', (input, expected) => {
    expect(sanitizeProjectName(input)).toBe(expected);
    expect(sanitizeProjectName(expected)).toBe(expected);
  });
});
