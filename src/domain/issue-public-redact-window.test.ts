import { describe, expect, it } from 'vitest';
import type { FieldEdges } from './issue-public-fragments.js';
import { prepareKeys } from './issue-public-keys.js';
import { redactText } from './issue-public-redact.js';

// 2 回目の置き換えの鍵の探索を印の周りの窓に絞っても、絞らない版 (secondPass = 'full') と同じ結果になること (bdboard-uudb)。
// トークン・鍵ブロックは実行時に組み立てる (シークレットスキャナに反応させない)。
const TOKEN = 'ghp_' + 'x'.repeat(36);
const SK = 'sk-proj-' + 'ab_-'.repeat(12);
const BEARER = 'Bearer ' + 'y'.repeat(30);
const JWT = 'eyJ' + 'a'.repeat(20) + '.eyJ' + 'b'.repeat(20) + '.' + 'c'.repeat(20);
const BEGIN = '-----' + 'BEGIN PRIVATE KEY' + '-----';
const HIGH = String.fromCharCode(0xd83d);

const EDGES: readonly FieldEdges[] = [
  { start: false, end: false },
  { start: false, end: true },
  { start: true, end: true },
];

// 周期のある名前 ("abab…")・互いの前置部分になる名前・根の直後の文字の条件・パーセント表記の変種を持つ根を混ぜる。
const KEYS = prepareKeys({
  // '/srv/qq/docs' のフォルダ名 docs は名前として足されない (一般的なディレクトリ名) ので、根の一致だけが働く。
  projectRoots: ['/work/example-project', '/work/abab-abab', '/work/漢字が/x', '/srv/qq/docs'],
  properNouns: [
    { category: 'project', value: 'example-project' },
    { category: 'user', value: 'example-user' },
    { category: 'host', value: 'abababab' },
    { category: 'branch', value: 'feature-example' },
    { category: 'user', value: 'exam' },
    { category: 'host', value: 'tom' },
  ],
});

function expectSameAsFullSecondPass(text: string): void {
  for (const edges of EDGES) {
    const window = redactText(text, KEYS, edges);
    const full = redactText(text, KEYS, edges, 'full');
    expect({ text, edges, window }).toEqual({ text, edges, window: full });
  }
}

describe('redactText: the second pass searches the keys only near the first-pass marks', () => {
  it('gives the same result as searching the whole text for the hostile inputs', () => {
    const hostile = [
      'a'.repeat(20_000),
      'sk-'.repeat(6_000),
      'ghp_'.repeat(5_000),
      'Bearer '.repeat(3_000),
      BEGIN.repeat(600),
      '/'.repeat(20_000),
      'eyJ'.repeat(6_000),
      HIGH.repeat(20_000),
      '😀'.repeat(10_000),
      '/Users/'.repeat(3_000),
      'C:\\Users\\a '.repeat(2_000),
      'example-project'.repeat(1_500),
      'example-user@'.repeat(1_500),
      'abab'.repeat(5_000),
      `${'x'.repeat(5_000)} /work/example-proj`,
      `ample-project/src ${'x'.repeat(5_000)} owner example-us`,
      `${'q'.repeat(3_000)}example-project${SK} ${'q'.repeat(3_000)} ${TOKEN}`,
    ];
    for (const text of hostile) expectSameAsFullSecondPass(text);
  });

  it('gives the same result as searching the whole text for 400 seeded mixed inputs', () => {
    let state = 0x2b9d;
    const next = (): number => {
      state = (state * 1_664_525 + 1_013_904_223) >>> 0;
      return state;
    };
    const pieces = [
      'example-project', 'EXAMPLE-PROJECT', 'Example-User', 'abababab', 'ABABabab', 'ababab', 'feature-example', 'exam', 'EXAM',
      'tom', '/work/example-project', '/WORK/Example-Project', '/work/example-project2', '/work/abab-abab', '/work/abab-ababab',
      '/work/%E6%BC%A2%E5%AD%97%E3%81%8C/x', '/work/漢字が/x', '/work/漢字か\u3099/x', '\\work\\example-project', 'example-proj',
      'ample-project', TOKEN, SK, 'sk-', BEARER, JWT, 'eyJ' + 'a'.repeat(9), 'jdoe@example.com', 'jdoe@exa', '/Users/jdoe/x',
      `${BEGIN}\n${'z'.repeat(40)}`, 'ordinary text 😀', '\n', ' ', '-', '_', '>', '<',
    ];
    const filler = (): string => 'lorem ipsum dolor '.repeat(next() % 30).slice(0, next() % 400);
    for (let iteration = 0; iteration < 400; iteration += 1) {
      let text = '';
      const count = 2 + (next() % 10);
      for (let index = 0; index < count; index += 1) {
        // 名前どうしを貼り付ける (印に替わって新しい一致が生まれる場面) か、離して置く (窓が分かれる場面) か。
        text += (next() % 2 === 0 ? '' : filler()) + (pieces[next() % pieces.length] ?? '');
      }
      expectSameAsFullSecondPass(text);
    }
  });

  it('gives the same result when the only first-pass mark is a fragment at the field edge', () => {
    // 1 回目の一致が端の断片だけのときが、窓に絞る主な場面 (bdboard-uudb の 2 つ目の課題)。
    for (const tail of ['/work/example-proj', 'owner example-us', 'abababa', `key ${SK.slice(0, 12)}`, 'jdoe@exam']) {
      const text = `${'lorem ipsum '.repeat(500)}example-project${'x'.repeat(30)}\n${tail}`;
      expectSameAsFullSecondPass(text);
      expectSameAsFullSecondPass(`${tail.split('').reverse().join('')} ${text}`);
    }
  });

  it('does not take a root that only looks complete because the window cuts the character after it', () => {
    // 窓の右端 (印の終わり + 2 × keyReach) でちょうど終わる根の直後に数字を置く。全体では直後の文字の条件で一致しないが、窓の中だけを
    // 見ると末尾に見えて一致してしまう。その偽の一致は芯の外から始まるので捨てる。
    const root = '/srv/qq/docs';
    const marker = '<redacted-token>';
    const gap = '.'.repeat(marker.length + 2 * KEYS.keyReach - marker.length - root.length);
    const text = `${TOKEN}${gap}${root}2 tail`;
    expect(redactText(text, KEYS).text).toBe(`${marker}${gap}${root}2 tail`);
    expectSameAsFullSecondPass(text);
  });
});
