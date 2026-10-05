import { describe, expect, it } from 'vitest';
import { cutKeepingHead, cutKeepingTail } from './issue-draft-cut.js';
import { buildPublicIssueBody } from './issue-public-build.js';
import {
  MAX_FRAGMENT_KEY_CODE_POINTS,
  MIN_FRAGMENT_CODE_POINTS,
  NO_EDGES,
  findEdgeFragmentSpans,
  fragmentKeyCollector,
  toFragmentKey,
} from './issue-public-fragments.js';
import { prepareKeys } from './issue-public-keys.js';
import { TOKEN_PREFIX_AT_END, TOKEN_SHAPES } from './issue-public-secrets.js';
import type { LocalOnlyKeys, PublicBuildInput, PublicBuildResult } from './issue-public-types.js';

// bdboard-4y8q.13: 保存の上限や末尾だけを取る送り手の切れ目が欄の端に残す断片。値はすべて偽の形で、トークンは実行時に組み立てる。
const ROOT = '/work/example-project';
const KEYS: LocalOnlyKeys = {
  projectRoots: [ROOT],
  properNouns: [
    { category: 'project', value: 'example-project' },
    { category: 'user', value: 'example-user' },
  ],
};
const BASE: PublicBuildInput = {
  kind: 'C',
  // 名前・版は断片と同じ文字列を含まない値にする (本文に断片が残ったかを文字列の包含で調べるため)。
  source: 'probe-hook',
  versions: { bdboardVersion: '1.2.3', os: 'Test OS', nodeVersion: 'v22' },
  occurrenceCount: 1,
  firstOccurredAt: '2026-10-04T00:00:00Z',
  lastOccurredAt: '2026-10-04T00:00:00Z',
};
const STACK = `${Array.from({ length: 50 }, (_, index) => `    at fn${index} (${ROOT}/src/a${index}.ts:1:1)`).join('\n')}\n`;
const FRAGMENT = '<redacted-fragment>';
const EMOJI = String.fromCodePoint(0x1f600);

type BlockField = 'symptom' | 'cause' | 'prevention' | 'errorText' | 'agentNote';
const BLOCK_FIELDS: readonly BlockField[] = ['symptom', 'cause', 'prevention', 'errorText', 'agentNote'];

function build(field: BlockField, text: string, keys: LocalOnlyKeys = KEYS): PublicBuildResult {
  return buildPublicIssueBody({ ...BASE, [field]: text }, keys);
}

function isWellFormed(value: string): boolean {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);
}

/** 本文から印 (<project> など) を除いたもの。断片 "project" が印の文字列に一致しないように。 */
function unmarkedBody(result: PublicBuildResult): string {
  let out = '';
  let from = 0;
  for (const mark of result.redactions.filter((candidate) => candidate.field === 'body')) {
    out += `${result.body.slice(from, mark.start)}\u0000`;
    from = mark.end;
  }
  return out + result.body.slice(from);
}

/** 断片が公開本文に置き換えも報告もされずに残ったか (SILENT)。 */
function isSilent(result: PublicBuildResult, piece: string): boolean {
  return unmarkedBody(result).includes(piece) && result.suspectedLeaks.length === 0;
}

describe('the examples in the ticket are replaced (bdboard-4y8q.13)', () => {
  const endCuts = [
    ['a root path', `${STACK}    at fnX (/work/example-proj`, '/work/example-proj', `(${FRAGMENT}`],
    ['a user name', `${STACK}owner example-us`, 'example-us', `owner ${FRAGMENT}`],
    ['a GitHub token (ghp_ + 15)', `${STACK}token ghp_${'x'.repeat(15)}`, 'ghp_x', `token ${FRAGMENT}`],
    ['an sk- key (sk-proj- + 10)', `${STACK}key sk-proj-${'x'.repeat(10)}`, 'sk-proj-x', `key ${FRAGMENT}`],
  ] as const;

  for (const field of BLOCK_FIELDS) {
    it.each(endCuts)(`replaces a ${field} cut at its end inside %s`, (_name, text, piece, expected) => {
      const result = build(field, text);
      expect(result.body).not.toContain(piece);
      expect(result.body).toContain(expected);
      expect(result.redactions.some((mark) => mark.kind === 'fragment')).toBe(true);
      expect(result.suspectedLeaks).toEqual([]);
    });
  }

  it('replaces an error text whose head was cut inside a root (tail-capture)', () => {
    const result = build('errorText', `ample-project/src/a.ts:1:1)\n${STACK}`);
    expect(result.body).not.toContain('ample-project');
    expect(result.body).toContain(`${FRAGMENT}/src/a.ts:1:1)`);
    expect(result.suspectedLeaks).toEqual([]);
  });

  it('is case-insensitive like the full-name replacement', () => {
    expect(build('symptom', 'owner EXAMPLE-US').body).toContain(`owner ${FRAGMENT}`);
    expect(build('errorText', 'AMPLE-PROJECT/src').body).toContain(`${FRAGMENT}/src`);
  });

  it('maps code points with surrogate pairs back to the right UTF-16 range at both edges', () => {
    const keys: LocalOnlyKeys = { projectRoots: [], properNouns: [{ category: 'user', value: `ex${EMOJI}ample-user` }] };
    const end = build('errorText', `owner ex${EMOJI}ampl`, keys);
    expect(end.body).toContain(`owner ${FRAGMENT}\n`);
    expect(end.body).not.toContain(`ex${EMOJI}ampl`);
    const start = build('errorText', `${EMOJI}ample-user is here`, keys);
    expect(start.body).toContain(`${FRAGMENT} is here`);
    expect(isWellFormed(start.body) && isWellFormed(end.body)).toBe(true);
  });
});

describe('what the edge check leaves alone', () => {
  it(`keeps a prefix shorter than ${MIN_FRAGMENT_CODE_POINTS} code points`, () => {
    expect(build('symptom', 'owner exa').body).toContain('owner exa');
    expect(build('symptom', 'owner exam').body).toContain(`owner ${FRAGMENT}`);
  });

  it('gives a whole name at the end its own placeholder', () => {
    const result = build('symptom', 'owner example-user');
    expect(result.body).toContain('owner <user>');
    expect(result.body).not.toContain(FRAGMENT);
  });

  it('gives a whole email at the end its own placeholder', () => {
    expect(build('symptom', 'mail jdoe@example.com').body).toContain('mail <email>');
  });

  it('looks only at the edges: a cut-looking word in the middle of a field stays', () => {
    expect(build('symptom', 'owner example-us\nsecond line').body).toContain('owner example-us\nsecond line');
  });

  it('does not look at the start of free text (only an error text can be tail-captured)', () => {
    expect(build('symptom', 'user clicked save').body).toContain('user clicked save');
    // エラー文の先頭は探す: 名前 example-user の後置部分 "user" と区別できず、消しすぎる側に倒れる (5節)。
    expect(build('errorText', 'user clicked save').body).toContain(`${FRAGMENT} clicked save`);
  });

  it('returns a whole key at the end edge (nothing follows it there) but not at the start edge (the normal replacement owns the follower rule)', () => {
    const keys = [toFragmentKey(ROOT)];
    // 末尾の全体の一致も返す: 本文の一致と重なれば、統合で強い種別の印 1 つになる (普通の入力の出力は変わらない)。
    expect(findEdgeFragmentSpans(ROOT, keys, { start: false, end: true })).toEqual([{ kind: 'fragment', start: 0, end: ROOT.length }]);
    expect(findEdgeFragmentSpans(ROOT, keys, { start: true, end: false })).toEqual([]);
    expect(findEdgeFragmentSpans('/work/example-projec', keys, { start: false, end: true })).toEqual([
      { kind: 'fragment', start: 0, end: 20 },
    ]);
    expect(findEdgeFragmentSpans('xample-project/src', keys, { start: true, end: false })).toEqual([
      { kind: 'fragment', start: 0, end: 14 },
    ]);
    expect(findEdgeFragmentSpans('xample-project/src', keys, { start: false, end: true })).toEqual([]);
  });

  it('keeps prose whose last word only resembles the start of a token or an email', () => {
    for (const text of ['it is risk-free', 'send the bearer', 'pinned react@18', 'see task-force', 'progress 50%']) {
      expect(build('symptom', text).body).toContain(text);
    }
  });

  it('looks for a token prefix only at the very end: a short token-like word inside a field stays', () => {
    for (const text of ['run sk-lint first\nthen deploy', 'npm_config was unset\nthen it ran', 'key AKIA1234 is a placeholder\nok']) {
      expect(build('symptom', text).body).toContain(text);
    }
  });

  it('does not look at the edges of one-line values (the storage does not cut them)', () => {
    const result = buildPublicIssueBody({ ...BASE, versions: { ...BASE.versions, os: 'Test OS exam' } }, KEYS);
    expect(result.body).toContain('Test OS exam');
    expect(findEdgeFragmentSpans('/work/example-projec', [toFragmentKey(ROOT)], NO_EDGES)).toEqual([]);
  });
});

describe('root variants and the size of the keys', () => {
  const WINDOWS_ROOT = String.raw`D:\work\acme-corp\example-project`;
  it.each([
    ['JSON-escaped backslashes', String.raw`D:\\work\\acme-co`],
    ['forward slashes', 'D:/work/acme-co'],
    ['percent-encoded', 'D%3A%5Cwork%5Cacme-co'],
  ])('replaces a cut root written with %s', (_name, piece) => {
    const result = build('symptom', `at ${piece}`, { projectRoots: [WINDOWS_ROOT], properNouns: [] });
    expect(result.body).toContain(`at ${FRAGMENT}`);
    expect(result.body).not.toContain('acme-co');
  });

  it('checks duplicates before the cap: a variant that folds to an existing key never counts as over the cap', () => {
    const collector = fragmentKeyCollector(12);
    expect(collector.add('example-user')).toBe(true);
    expect(collector.add('EXAMPLE-USER')).toBe(true);
    expect(collector.keys).toHaveLength(1);
    expect(collector.add('abcd')).toBe(false);
    expect(collector.keys).toHaveLength(1);
  });

  it('keeps one fragment key for variants that fold to the same text', () => {
    const one = prepareKeys({ projectRoots: [ROOT], properNouns: [] }).fragmentKeys.length;
    expect(prepareKeys({ projectRoots: [ROOT, ROOT.toUpperCase()], properNouns: [] }).fragmentKeys.length).toBe(one);
  });

  it(
    'caps the total code points of the fragment keys (200 non-ASCII roots of 1024 code points)',
    () => {
      const pool = ['が', 'ぎ', 'ぐ', '仕', '事', 'ば', 'ぶ', 'プ'];
      // 根の長さの上限 (1024 コードポイント) ちょうどにする (超えた根は鍵にならない)。
      const root = (index: number): string =>
        Array.from(
          Array.from({ length: 1024 }, (_, at) => (at === 0 ? `/作業${index}` : at % 8 === 0 ? '/' : pool[at % pool.length])).join(''),
        )
          .slice(0, 1024)
          .join('');
      const prepared = prepareKeys({ projectRoots: Array.from({ length: 200 }, (_, index) => root(index)), properNouns: [] });
      const total = prepared.fragmentKeys.reduce((sum, key) => sum + key.forward.length, 0);
      expect(total).toBeLessThanOrEqual(MAX_FRAGMENT_KEY_CODE_POINTS);
      expect(total).toBeGreaterThan(MAX_FRAGMENT_KEY_CODE_POINTS / 2);
      expect(prepared.truncated).toBe(true);
    },
    30_000,
  );
});

describe('the longest overlap with a name that repeats its own start', () => {
  // 名前の先頭が名前の中で繰り返す (exex…) と、素朴に照合をやり直すと最長の重なりを見落とす (KMP の失敗関数で戻る)。
  it('finds the longest prefix at the end', () => {
    const keys = [toFragmentKey('exexample-user')];
    expect(findEdgeFragmentSpans('owner exexexample-us', keys, { start: false, end: true })).toEqual([
      { kind: 'fragment', start: 8, end: 20 },
    ]);
  });

  it('falls back through the failure function to the longest overlap', () => {
    // 鍵ごとに欄の端から鍵の長さぶんだけを読む。失敗関数を作るときの後戻りを外すと、前者は 1 (4 文字が漏れる)、
    // 後者は 4 (断片でないものを消す) になる (総当たりで見つけた最短の反例)。
    expect(findEdgeFragmentSpans('x abaababaa', [toFragmentKey('abaababab')], { start: false, end: true })).toEqual([
      { kind: 'fragment', start: 7, end: 11 },
    ]);
    expect(findEdgeFragmentSpans('x aaaaba', [toFragmentKey('aaaabb')], { start: false, end: true })).toEqual([]);
  });

  it('finds the longest suffix at the start', () => {
    const keys = [toFragmentKey('project-axax')];
    expect(findEdgeFragmentSpans('ject-axaxax and more', keys, { start: true, end: false })).toEqual([
      { kind: 'fragment', start: 0, end: 9 },
    ]);
  });
});

describe('tokens and emails cut at the end of a field', () => {
  it('has a prefix shape for every token shape', () => {
    expect(Object.keys(TOKEN_PREFIX_AT_END).sort()).toEqual(TOKEN_SHAPES.map((shape) => shape.name).sort());
  });

  it.each([
    ['github', `gho_${'x'.repeat(5)}`],
    ['github-fine-grained', `github_pat_${'x'.repeat(10)}`],
    ['sk-family', `sk-ant-${'x'.repeat(5)}`],
    ['stripe', `sk_live_${'x'.repeat(8)}`],
    ['aws-access-key-id', `AKIA${'X'.repeat(8)}`],
    ['slack', `xoxb-${'1'.repeat(5)}`],
    ['slack app', `xapp-1-${'A'.repeat(3)}`],
    ['google-api-key', `AIza${'x'.repeat(10)}`],
    ['google-oauth', `ya29.${'x'.repeat(10)}`],
    ['npm', `npm_${'x'.repeat(10)}`],
    ['jwt (two parts)', `eyJ${'a'.repeat(20)}.eyJ${'b'.repeat(5)}`],
    ['jwt (short signature)', `eyJ${'a'.repeat(20)}.eyJ${'b'.repeat(20)}.${'c'.repeat(3)}`],
    ['bearer', `Bearer ${'y'.repeat(10)}`],
    ['an email cut in the domain', 'jdoe@exam'],
    ['an email cut after the at sign', 'jdoe@'],
    ['an email cut inside %40', 'jdoe%4'],
    ['an email cut after the % of %40', 'jdoe%'],
  ])('replaces %s', (_name, piece) => {
    const result = build('symptom', `value ${piece}`);
    expect(result.body).toContain(`value ${FRAGMENT}`);
    expect(result.body).not.toContain(piece);
  });

  it('still reports, not replaces, a whole glued token at the end (a fragment inside a reported token is left to the report)', () => {
    const jwt = `eyJ${'a'.repeat(20)}.eyJ${'b'.repeat(20)}.${'c'.repeat(20)}`;
    const glued = build('symptom', `id1${jwt}`);
    expect(glued.body).not.toContain(FRAGMENT);
    expect(glued.suspectedLeaks.map((leak) => leak.kind)).toEqual(['token']);
    // 途中の "-sk-" から断片を始めると、報告されるはずの "sk-…" が短く削られる。
    const sk = build('symptom', `id1sk-proj-${'a'.repeat(20)}-sk-abc`);
    expect(sk.body).not.toContain(FRAGMENT);
    expect(sk.suspectedLeaks.map((leak) => leak.kind)).toEqual(['token']);
  });

  it.each([
    ['sk- after a dot', 'cfg.sk-proj-abcdefgh'],
    ['sk- after an underscore', 'MY_KEY_sk-proj-abcdefgh'],
    ['sk- after a hyphen', 'x-sk-proj-abcdefgh'],
    ['Stripe after an underscore', 'k_sk_live_abcdef'],
    ['a JWT after a dot', 'session.eyJhbGciOiJIUzI1'],
  ])('replaces a cut token where the whole token would be replaced: %s', (_name, glued) => {
    const result = build('errorText', `line\nat ${glued}`);
    expect(result.body).toContain(FRAGMENT);
    expect(result.body).not.toMatch(/sk-proj|sk_live|eyJhbG/);
  });

  it('replaces what sticks out past a replaced fixed-length token (the overlap only drops candidates inside a reported match)', () => {
    // npm_ の 36 文字ちょうどが AIza の候補の頭に食い込む。候補を捨てると、はみ出した yyyyyyyyyy が素通りする。
    const result = build('errorText', `line\nat k npm_${'n'.repeat(30)}AIzaXY${'y'.repeat(10)}`);
    expect(result.body).toContain('k <redacted-token>');
    expect(result.body).not.toContain('y'.repeat(10));
  });

  it('leaves a cut token glued to a letter or digit (the whole token is only reported, and the cut one is too short)', () => {
    // 5節「それでも拾えないもの」の 2 つ目。完全な形でも置き換わらない位置なので、断片も置き換えない ("risk-free" を守る条件と同じ)。
    expect(build('symptom', 'id1sk-proj-abcdefgh').body).toContain('id1sk-proj-abcdefgh');
  });

  it.each([
    ['github', 'ghp_', 'x', 20],
    ['github-fine-grained', 'github_pat_', 'x', 20],
    ['sk-family', 'sk-', 'x', 20],
    ['stripe', 'sk_live_', 'x', 16],
    ['aws-access-key-id', 'AKIA', 'X', 16],
    ['slack', 'xoxb-', 'x', 10],
    ['google-api-key', 'AIza', 'x', 35],
    ['google-oauth', 'ya29.', 'x', 20],
    ['npm', 'npm_', 'x', 36],
    ['bearer', 'Bearer ', 'y', 16],
  ])('treats %s one character short of the full shape as a fragment, and the full shape as a token', (_name, prefix, unit, min) => {
    expect(build('symptom', `value ${prefix}${unit.repeat(min - 1)}`).body).toContain(`value ${FRAGMENT}`);
    expect(build('symptom', `value ${prefix}${unit.repeat(min)}`).body).toContain('value <redacted-token>');
  });

  it('replaces a cut token that becomes visible only after a glued name was replaced (the second pass looks at the edges too)', () => {
    // 1 回目は "sk-" の直前が英数字 (t) なので断片の開始の条件を満たさない。名前が <project> になった 2 回目で満たす。
    const piece = `sk-proj-${'x'.repeat(5)}`;
    const result = build('symptom', `example-project${piece}`);
    expect(result.body).toContain(`<project>${FRAGMENT}`);
    expect(result.body).not.toContain(piece);
  });
});

// ---- 切れ目をでたらめな位置に置く (性質のテスト) ----

/** 決まった種から作る疑似乱数 (mulberry32)。 */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

interface Item {
  readonly value: string;
  /** 末尾が切れて残った前置部分を断片として数える最小の長さ (UTF-16)。トークンは接頭辞の長さ + 1。 */
  readonly minHeadPiece: number;
  /**
   * 先頭が切れて残った後置部分を断片として数えるか。先頭を失ったトークンは形が無いので数えない (5節「カバーしないもの」)。
   * メールはローカル部が少しでも残るものだけ ("@" から後ろはドメインだけで、鍵ではない)。
   */
  readonly checkTailPiece: (piece: string) => boolean;
}

const GHP = `ghp_${'q'.repeat(36)}`;
const SK = `sk-proj-${'r'.repeat(30)}`;
const AWS = `AKIA${'Q'.repeat(16)}`;
const JWT = `eyJ${'h'.repeat(20)}.eyJ${'p'.repeat(20)}.${'s'.repeat(20)}`;
const SLACK = `xoxb-${'7'.repeat(20)}`;
const ITEMS: readonly Item[] = [
  { value: ROOT, minHeadPiece: MIN_FRAGMENT_CODE_POINTS, checkTailPiece: () => true },
  { value: 'example-user', minHeadPiece: MIN_FRAGMENT_CODE_POINTS, checkTailPiece: () => true },
  { value: 'example-project', minHeadPiece: MIN_FRAGMENT_CODE_POINTS, checkTailPiece: () => true },
  { value: '/Users/example-user', minHeadPiece: '/Users/'.length + 1, checkTailPiece: () => true },
  { value: 'example-user@example.com', minHeadPiece: 'example-user@'.length, checkTailPiece: (piece) => piece.indexOf('@') > 0 },
  { value: GHP, minHeadPiece: 'ghp_'.length + 1, checkTailPiece: () => false },
  { value: SK, minHeadPiece: 'sk-'.length + 1, checkTailPiece: () => false },
  { value: AWS, minHeadPiece: 'AKIA'.length + 1, checkTailPiece: () => false },
  { value: JWT, minHeadPiece: 'eyJ'.length + 1, checkTailPiece: () => false },
  { value: SLACK, minHeadPiece: 'xoxb-'.length + 1, checkTailPiece: () => false },
];

const TRACE = [
  'Error: probe failure',
  ...Array.from({ length: 30 }, (_, index) => {
    const frame = `    at fn${index} (${ROOT}/src/m${index}.ts:${index}:7)`;
    switch (index % 6) {
      case 0:
        return `${frame}\nowner example-user token ${GHP}`;
      case 1:
        return `${frame}\nkey ${SK} aws ${AWS}`;
      case 2:
        return `${frame}\nmail example-user@example.com ${EMOJI} cwd /Users/example-user/tmp`;
      case 3:
        return `${frame}\nauth ${JWT} slack ${SLACK}`;
      default:
        return frame;
    }
  }),
].join('\n');

interface Occurrence {
  readonly item: Item;
  readonly start: number;
  readonly end: number;
}

const OCCURRENCES: readonly Occurrence[] = ITEMS.flatMap((item) => {
  const found: Occurrence[] = [];
  for (let at = TRACE.indexOf(item.value); at >= 0; at = TRACE.indexOf(item.value, at + 1)) {
    found.push({ item, start: at, end: at + item.value.length });
  }
  return found;
});

/** 半分はでたらめな位置、半分はどれかの一致の内側。 */
function cutPositions(seed: number, count: number): number[] {
  const next = random(seed);
  return Array.from({ length: count }, (_, index) => {
    if (index % 2 === 0) return 1 + Math.floor(next() * (TRACE.length - 1));
    const occurrence = OCCURRENCES[Math.floor(next() * OCCURRENCES.length)];
    if (occurrence === undefined) return 1;
    return occurrence.start + 1 + Math.floor(next() * (occurrence.end - occurrence.start - 1));
  });
}

/** 先頭を残して cut で切ったとき、切れ目にかかった一致の残り (前置部分) のうち、断片として数えるもの。 */
function headPieces(cut: number): string[] {
  return OCCURRENCES.filter(({ item, start, end }) => start < cut && cut < end && cut - start >= item.minHeadPiece).map(
    ({ start }) => TRACE.slice(start, cut),
  );
}

/** 末尾を残して cut から切ったとき、切れ目にかかった一致の残り (後置部分) のうち、断片として数えるもの。 */
function tailPieces(cut: number): string[] {
  return OCCURRENCES.filter(
    ({ item, start, end }) =>
      start < cut &&
      cut < end &&
      Array.from(TRACE.slice(cut, end)).length >= MIN_FRAGMENT_CODE_POINTS &&
      item.checkTailPiece(TRACE.slice(cut, end)),
  ).map(({ end }) => TRACE.slice(cut, end));
}

describe('random cut positions over a stack trace leave no silent fragment', () => {
  it('has items in the trace', () => {
    expect(OCCURRENCES.length).toBeGreaterThan(30);
    expect(TRACE.length).toBeLessThan(8000);
  });

  it('keeps whole lines when the storage cuts the end (cutKeepingHead), for free text and the error text', () => {
    for (const cut of cutPositions(1, 60)) {
      const stored = cutKeepingHead(TRACE, cut);
      expect(isWellFormed(stored)).toBe(true);
      expect(stored === '' || TRACE[stored.length] === '\n' || stored.endsWith('\n')).toBe(true);
      for (const field of ['symptom', 'errorText'] as const) {
        const result = build(field, stored);
        for (const piece of headPieces(stored.length)) expect(isSilent(result, piece), piece).toBe(false);
      }
    }
  });

  it('keeps whole lines when a sender keeps only the tail (cutKeepingTail)', () => {
    for (const cut of cutPositions(2, 60)) {
      const stored = cutKeepingTail(TRACE, TRACE.length - cut);
      const from = TRACE.length - stored.length;
      expect(isWellFormed(stored)).toBe(true);
      expect(from === 0 || TRACE[from - 1] === '\n').toBe(true);
      const result = build('errorText', stored);
      for (const piece of tailPieces(from)) expect(isSilent(result, piece), piece).toBe(false);
    }
  });

  it('replaces the end fragment when the cut lands mid-line (a field with no newline nearby)', () => {
    for (const cut of cutPositions(3, 120)) {
      const stored = TRACE.slice(0, cut);
      for (const field of ['symptom', 'errorText'] as const) {
        const result = build(field, stored);
        for (const piece of headPieces(cut)) {
          expect(isSilent(result, piece), `${field}: ${piece} in ${JSON.stringify(stored.slice(-60))}`).toBe(false);
        }
        expect(isWellFormed(result.body)).toBe(true);
      }
    }
  });

  it('replaces the start fragment of names, roots and paths when a tail capture lands mid-line', () => {
    for (const cut of cutPositions(4, 120)) {
      const result = build('errorText', TRACE.slice(cut));
      for (const piece of tailPieces(cut)) expect(isSilent(result, piece), `${piece} in ${JSON.stringify(TRACE.slice(cut, cut + 60))}`).toBe(false);
      expect(isWellFormed(result.body)).toBe(true);
    }
  });
});
