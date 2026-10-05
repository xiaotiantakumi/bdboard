import { describe, expect, it } from 'vitest';
import type { IssueDraft } from './issue-draft.js';
import { buildPublicIssueBody } from './issue-public-build.js';
import { TOKEN_SHAPES, findEmailSpans, findTokenSpans } from './issue-public-secrets.js';
import type { LocalOnlyKeys, PublicBuildInput, PublicBuildResult, RedactionKind } from './issue-public-types.js';

// 孤立サロゲート・行区切りは実行時に組み立てる。トークンも実行時に組み立てる (シークレットスキャナに反応させない)。
const HIGH = String.fromCharCode(0xd83d);
const LOW = String.fromCharCode(0xde00);
const LS = String.fromCodePoint(0x2028);
const PS = String.fromCodePoint(0x2029);
const ZWSP = String.fromCodePoint(0x200b);
const TOKEN = 'ghp_' + 'x'.repeat(36);
const AWS = 'AKIA' + 'X'.repeat(16);
const SK = 'sk-proj-' + 'ab_-'.repeat(12);
const BEARER_VALUE = 'y'.repeat(30);
const BEARER = 'Bearer ' + BEARER_VALUE;
const JWT = 'eyJ' + 'a'.repeat(20) + '.eyJ' + 'b'.repeat(20) + '.' + 'c'.repeat(20);
const STRIPE = 'sk_live_' + 'x'.repeat(24);
const GOOGLE_OAUTH = 'ya29.' + 'x'.repeat(30);
const SLACK_APP = 'xapp-1-' + 'A'.repeat(30);
const BEGIN = '-----' + 'BEGIN PRIVATE KEY' + '-----';
const END = '-----' + 'END PRIVATE KEY' + '-----';

const KEYS: LocalOnlyKeys = {
  projectRoots: ['/work/example-project'],
  properNouns: [
    { category: 'project', value: 'example-project' },
    { category: 'user', value: 'example-user' },
    { category: 'host', value: 'example-host' },
    { category: 'branch', value: 'feature-example' },
  ],
};
const LONG_NOUNS = ['example-project', 'example-user', 'example-host', 'feature-example'];

const BASE: PublicBuildInput = {
  kind: 'B',
  source: 'example-hook',
  symptom: 'command failed',
  versions: { bdboardVersion: '1.2.3', harnessVersion: '2.0.0', os: 'Example OS', nodeVersion: 'v22' },
  occurrenceCount: 2,
  firstOccurredAt: '2026-10-04T00:00:00Z',
  lastOccurredAt: '2026-10-04T01:00:00Z',
};

const PLACEHOLDERS: Readonly<Record<RedactionKind, string>> = {
  'project-path': '<project>',
  'home-path': '~/',
  project: '<project>',
  user: '<user>',
  host: '<host>',
  branch: '<branch>',
  'key-block': '<redacted-key-block>',
  token: '<redacted-token>',
  email: '<email>',
  fragment: '<redacted-fragment>',
};

function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

/** 各印の位置の切り出しが、種別の印の文字列と一致する (位置は最終の title / body の UTF-16 オフセット)。 */
function expectMarksExact(result: PublicBuildResult): void {
  for (const field of ['title', 'body'] as const) {
    let previousEnd = 0;
    for (const mark of result.redactions.filter((candidate) => candidate.field === field)) {
      expect(mark.start).toBeGreaterThanOrEqual(previousEnd);
      expect(result[field].slice(mark.start, mark.end)).toBe(PLACEHOLDERS[mark.kind]);
      previousEnd = mark.end;
    }
  }
}

/** コードスパンを [SPAN]、フェンス付きコードブロックを [BLOCK] に置き換える (CommonMark の規則どおり)。 */
function stripSpans(line: string): string {
  let out = '';
  let index = 0;
  while (index < line.length) {
    if (line[index] !== '`') {
      out += line[index];
      index += 1;
      continue;
    }
    let runEnd = index;
    while (line[runEnd] === '`') runEnd += 1;
    const length = runEnd - index;
    let search = runEnd;
    let close = -1;
    while (search < line.length) {
      if (line[search] !== '`') {
        search += 1;
        continue;
      }
      let end = search;
      while (line[end] === '`') end += 1;
      if (end - search === length) {
        close = end;
        break;
      }
      search = end;
    }
    if (close < 0) {
      out += line.slice(index, runEnd);
      index = runEnd;
    } else {
      out += '[SPAN]';
      index = close;
    }
  }
  return out;
}

function stripCode(markdown: string): string {
  const lines = markdown.split('\n');
  const out: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const opening = /^(`{3,})text$/.exec(lines[index] ?? '');
    if (opening === null) {
      out.push(stripSpans(lines[index] ?? ''));
      continue;
    }
    const closing = new RegExp(`^ {0,3}\`{${String((opening[1] ?? '').length)},}[ \\t]*$`);
    let end = index + 1;
    while (end < lines.length && !closing.test(lines[end] ?? '')) end += 1;
    out.push(end < lines.length ? '[BLOCK]' : '[UNCLOSED BLOCK]');
    index = end;
  }
  return out.join('\n');
}

const FULL_SKELETON = [
  '## 概要',
  '- 種類: hook・配布スクリプト',
  '- 対象: [SPAN]',
  '- 発生回数: 3',
  '- 最初に起きた時刻: [SPAN]',
  '- 最後に起きた時刻: [SPAN]',
  '',
  '## 症状',
  '[BLOCK]',
  '',
  '## 原因',
  '[BLOCK]',
  '',
  '## 再発防止',
  '[BLOCK]',
  '',
  '## エラー文',
  '[BLOCK]',
  '',
  '## 説明',
  '[BLOCK]',
  '',
  '## 版',
  '- bdboard: [SPAN]',
  '- ハーネス: [SPAN]',
  '- OS: [SPAN]',
  '- Node: [SPAN]',
  '- bd: [SPAN]',
  '- gh: [SPAN]',
  '',
].join('\n');

function allFields(value: string): PublicBuildInput {
  return {
    kind: 'B',
    source: value,
    symptom: value,
    cause: value,
    prevention: value,
    errorText: value,
    agentNote: value,
    versions: { bdboardVersion: value, harnessVersion: value, os: value, nodeVersion: value, bdVersion: value, ghVersion: value },
    occurrenceCount: 3,
    firstOccurredAt: value,
    lastOccurredAt: value,
  };
}

describe('template', () => {
  it('builds the fixed Japanese template and omits empty optional sections', () => {
    const result = buildPublicIssueBody(BASE, KEYS);
    expect(result.title).toBe('[hook・配布スクリプト] `example-hook`');
    expect(result.body).toBe(
      [
        '## 概要\n- 種類: hook・配布スクリプト\n- 対象: `example-hook`\n- 発生回数: 2\n',
        '- 最初に起きた時刻: `2026-10-04T00:00:00Z`\n- 最後に起きた時刻: `2026-10-04T01:00:00Z`\n',
        '\n## 症状\n```text\ncommand failed\n```\n',
        '\n## 版\n- bdboard: `1.2.3`\n- ハーネス: `2.0.0`\n- OS: `Example OS`\n- Node: `v22`\n',
      ].join(''),
    );
    expect(result.redactions).toEqual([]);
    expect(result.suspectedLeaks).toEqual([]);
  });

  it('writes every section in order and the optional versions only when present', () => {
    const input = allFields('value');
    const body = buildPublicIssueBody(input, KEYS).body;
    const order = ['## 概要', '## 症状', '## 原因', '## 再発防止', '## エラー文', '## 説明', '## 版', '- bd: ', '- gh: '];
    const positions = order.map((heading) => body.indexOf(heading));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    const minimal = buildPublicIssueBody({ ...BASE, symptom: undefined }, KEYS).body;
    expect(minimal).not.toMatch(/## (症状|原因|再発防止|エラー文|説明)|- (bd|gh): /);
  });

  it.each([
    ['A', { catalogSlug: 'slug-a', source: 'ignored-source' }, '[作業の進め方] `slug-a`', 'slug-a'],
    ['B', { source: 'hook-b', catalogSlug: 'ignored-slug' }, '[hook・配布スクリプト] `hook-b`', 'hook-b'],
    ['C', { source: 'script-c' }, '[bdboard 本体] `script-c`', 'script-c'],
  ] as const)('uses the kind label and the right name for kind %s', (kind, names, title, name) => {
    const result = buildPublicIssueBody({ ...BASE, kind, ...names }, KEYS);
    expect(result.title).toBe(title);
    expect(result.body).toContain(`- 対象: \`${name}\``);
    expect(result.body).not.toContain('ignored-');
  });

  it.each([
    ['missing', { source: undefined }],
    ['blank', { source: '  \n\t ' }],
    ['invisible only', { source: ZWSP + HIGH }],
    ['kind A with only a source', { kind: 'A' as const, source: 'only-source' }],
  ])('writes the no-name title and omits the target line when the name is %s', (_name, patch) => {
    const result = buildPublicIssueBody({ ...BASE, ...patch }, KEYS);
    expect(result.title).toMatch(/\] \(名称なし\)$/);
    expect(result.body).not.toContain('- 対象:');
  });

  it.each([
    [0, '0'],
    [7, '7'],
    [-3, '-3'],
    [Number.NaN, '?'],
    [Number.POSITIVE_INFINITY, '?'],
    [1.5, '?'],
    [2 ** 53, '?'],
  ])('formats the occurrence count %s as %s', (count, expected) => {
    expect(buildPublicIssueBody({ ...BASE, occurrenceCount: count }, KEYS).body).toContain(`- 発生回数: ${expected}\n`);
  });
});

describe('code contexts: the only text outside code is the static template', () => {
  const payloads = [
    '[x](http://example.com) @example-user #123 example-owner/example-repo#1 <img src=x onerror=1> <!-- c -->',
    '# heading\n## injected heading\r\n- [ ] item\n> quote\n---',
    '```\n~~~\n    indented\n  ```\n````',
    ...[1, 2, 3, 4, 5, 6].map((length) => `a${'`'.repeat(length)}b ${'`'.repeat(length)}`),
    '`starts with a tick',
    'ends with a tick`',
    'a`b``c```d````e`````f``````g',
    `line one${LS}## after separator${PS}# after paragraph`,
    '|a|b|\n|-|-|\n:smile: :+1: @all',
    `https://example.com/${'a'.repeat(300)} www.example.com`,
  ];

  it.each(payloads.map((payload, index) => [index, payload] as const))(
    'puts payload %i only inside code spans and blocks (title, body, every field)',
    (_index, payload) => {
      const result = buildPublicIssueBody(allFields(payload), KEYS);
      expect(stripCode(result.body)).toBe(FULL_SKELETON);
      expect(stripCode(result.title)).toBe('[hook・配布スクリプト] [SPAN]');
      expect(result.title).not.toContain('\n');
    },
  );

  it('collapses a multi-line source into one line (no heading or list can be injected through it)', () => {
    const result = buildPublicIssueBody({ ...BASE, source: 'a\n## injected\r\n- item\u0009tab' }, KEYS);
    expect(result.title).toBe('[hook・配布スクリプト] `a ## injected - item tab`');
    expect(result.body).toContain('- 対象: `a ## injected - item tab`\n');
  });

  it('keeps fence-like and heading-like lines of free text inside the block', () => {
    const symptom = '```\n~~~\n# heading\n<!-- x -->\n[l](http://example.com)\n@example-user';
    const body = buildPublicIssueBody({ ...BASE, symptom }, KEYS).body;
    expect(body).toContain('## 症状\n````text\n```\n~~~\n# heading\n<!-- x -->\n[l](http://example.com)\n@<user>\n````\n');
    expect(stripCode(body)).toContain('## 症状\n[BLOCK]\n');
  });
});

describe('redaction of every dynamic field', () => {
  const secretText = [
    '/work/example-project/src/a.ts',
    '/Users/example-user/x',
    'example-user@example.com',
    TOKEN,
    AWS,
    'Example-Host',
    'feature-example',
    JWT,
    STRIPE,
    GOOGLE_OAUTH,
    SLACK_APP,
    SK,
    BEARER,
    '/home/jdoe/x',
  ].join(' ');
  const fields: readonly (readonly [string, (value: string) => PublicBuildInput])[] = [
    ['source', (value) => ({ ...BASE, source: value })],
    ['catalogSlug', (value) => ({ ...BASE, kind: 'A', catalogSlug: value })],
    ['symptom', (value) => ({ ...BASE, symptom: value })],
    ['cause', (value) => ({ ...BASE, cause: value })],
    ['prevention', (value) => ({ ...BASE, prevention: value })],
    ['errorText', (value) => ({ ...BASE, errorText: value })],
    ['agentNote', (value) => ({ ...BASE, agentNote: value })],
    ['bdboardVersion', (value) => ({ ...BASE, versions: { ...BASE.versions, bdboardVersion: value } })],
    ['harnessVersion', (value) => ({ ...BASE, versions: { ...BASE.versions, harnessVersion: value } })],
    ['os', (value) => ({ ...BASE, versions: { ...BASE.versions, os: value } })],
    ['nodeVersion', (value) => ({ ...BASE, versions: { ...BASE.versions, nodeVersion: value } })],
    ['bdVersion', (value) => ({ ...BASE, versions: { ...BASE.versions, bdVersion: value } })],
    ['ghVersion', (value) => ({ ...BASE, versions: { ...BASE.versions, ghVersion: value } })],
    ['firstOccurredAt', (value) => ({ ...BASE, firstOccurredAt: value })],
    ['lastOccurredAt', (value) => ({ ...BASE, lastOccurredAt: value })],
  ];

  it.each(fields)('removes paths, nouns, tokens and e-mail from %s', (_name, make) => {
    const result = buildPublicIssueBody(make(secretText), KEYS);
    const output = (result.title + result.body).toLowerCase();
    const secrets = [TOKEN, AWS, 'example-user', 'example-project', 'example-host', 'feature-example', '@example.com'];
    for (const secret of [...secrets, JWT, STRIPE, GOOGLE_OAUTH, SLACK_APP, SK, BEARER_VALUE, 'jdoe']) {
      expect(output).not.toContain(secret.toLowerCase());
    }
    expect(result.redactions.length).toBeGreaterThan(0);
    expect(result.suspectedLeaks).toEqual([]);
    expectMarksExact(result);
  });

  it('gives agent-written text exactly the same treatment as the other free text', () => {
    const text = `${secretText}\n${BEGIN}\n${'x'.repeat(64)}\n${END}`;
    const fromSymptom = buildPublicIssueBody({ ...BASE, symptom: text }, KEYS);
    const fromNote = buildPublicIssueBody({ ...BASE, symptom: undefined, agentNote: text }, KEYS);
    const kinds = (result: PublicBuildResult): RedactionKind[] => result.redactions.map((mark) => mark.kind);
    expect(kinds(fromNote)).toEqual(kinds(fromSymptom));
    expect(fromNote.body.replace('## 説明', '## 症状')).toBe(fromSymptom.body);
    expect(fromNote.body).toContain('<redacted-key-block>');
  });

  it('writes the exact output position of every placeholder in title and body', () => {
    const result = buildPublicIssueBody({ ...BASE, source: 'example-user-hook', symptom: 'x example-host y' }, KEYS);
    const titleAt = result.title.indexOf('<user>');
    expect(result.redactions).toContainEqual({ field: 'title', kind: 'user', start: titleAt, end: titleAt + 6 });
    const hostAt = result.body.indexOf('<host>');
    expect(result.redactions).toContainEqual({ field: 'body', kind: 'host', start: hostAt, end: hostAt + 6 });
    expect(result.redactions.filter((mark) => mark.field === 'body' && mark.kind === 'user')).toHaveLength(1);
    expectMarksExact(result);
  });

  it('keeps marks exact when the same text passes through every section (multi-section offsets)', () => {
    const result = buildPublicIssueBody(allFields(secretText), KEYS);
    expectMarksExact(result);
    expect(result.suspectedLeaks).toEqual([]);
  });
});

/** 1 つの自由記述に入れて組み立てる (title / body に残る文字列と、最後の網の報告を見る)。 */
function fromSymptom(text: string, keys: LocalOnlyKeys = KEYS): PublicBuildResult {
  return buildPublicIssueBody({ ...BASE, symptom: text }, keys);
}

describe('secrets after escapes and in other positions (they were silent in the first review)', () => {
  const BS = '\\';
  it.each([
    ['sk- after a JSON \\n', `{"out":"line1${BS}n${SK}"}`, SK],
    ['sk- after a JSON \\t', `"a${BS}t${SK}"`, SK],
    ['sk- after a JSON \\r', `"a${BS}r${SK}"`, SK],
    ['sk- after a %3D', `GET /x?key%3D${SK}`, SK],
    ['sk- after a %20', `q=%20${SK}`, SK],
    ['Bearer after a JSON \\n', `"x${BS}n${BEARER}"`, BEARER_VALUE],
    ['Bearer after a %0A', `x%0A${BEARER}`, BEARER_VALUE],
    ['Bearer with a %20 separator', `Authorization: Bearer%20${BEARER_VALUE}`, BEARER_VALUE],
    ['a Stripe key', `key ${STRIPE}`, STRIPE],
    ['a JWT in a cookie', `token=${JWT}`, JWT.slice(0, 30)],
    ['a Google OAuth token', `access_token=${GOOGLE_OAUTH}`, GOOGLE_OAUTH],
    ['a Slack app-level token', `SLACK=${SLACK_APP}`, SLACK_APP],
    ['an sk- key glued to a noun', `example-project${SK}`, SK],
    ['a Bearer credential glued to a noun', `example-project${BEARER}`, BEARER_VALUE],
  ])('removes %s', (_name, text, secret) => {
    const result = fromSymptom(text);
    expect(result.body).not.toContain(secret);
    expect(result.body).toContain('<redacted-token>');
    expect(result.suspectedLeaks).toEqual([]);
    expectMarksExact(result);
  });

  it.each([
    ['CJK corner brackets', '「/Users/jdoe/work/x.ts」を開けない'],
    ['a full-width colon', 'パス：/Users/jdoe/work/x.ts'],
    ['CJK letters directly before', 'パス/home/jdoe/xで失敗'],
    ['a JSON \\n', `{"o":"a${BS}n/Users/jdoe/x"}`],
    ['a JSON \\r\\n', `{"o":"a${BS}r${BS}n/Users/jdoe/x"}`],
    ['Vite /@fs/', 'at http://localhost:5173/@fs/Users/jdoe/lib/x.js'],
    ['vscode://file', 'open vscode://file/Users/jdoe/x.ts:1'],
    ['an upper-case FILE:///', 'FILE:///Users/jdoe/x.ts'],
    ['a star', 'glob */Users/jdoe/x'],
    ['an exclamation mark', 'x!/home/jdoe/x'],
    ['a percent-encoded path', 'p=%2FUsers%2Fjdoe%2Fx'],
    ['a Windows path after CJK', `パスC:${BS}Users${BS}jdoe${BS}x`],
    ['a Windows path with slashes', 'C:/Users/jdoe/x'],
    ['a JSON-escaped Windows path', `C:${BS}${BS}Users${BS}${BS}jdoe${BS}${BS}x`],
  ])('removes the user name of a home path after %s', (_name, text) => {
    const result = fromSymptom(text, { projectRoots: [], properNouns: [] });
    expect(result.body).not.toContain('jdoe');
    expect(result.body).toContain('~/');
    expect(result.suspectedLeaks).toEqual([]);
    expectMarksExact(result);
  });

  it.each([
    ['a lower-case marker', `-----${'begin rsa private key'}-----\n${'Q'.repeat(64)}\n-----${'end rsa private key'}-----`],
    ['the SSH2 form', `---- ${'BEGIN SSH2 ENCRYPTED PRIVATE KEY'} ----\n${'Q'.repeat(64)}\n---- ${'END SSH2 ENCRYPTED PRIVATE KEY'} ----`],
    ['a PuTTY key file', `PuTTY-User-Key-File-3: ssh-ed25519\nPrivate-Lines: 1\n${'Q'.repeat(64)}`],
    ['a JSON-escaped block', `{"k":"${BEGIN}${BS}n${'Q'.repeat(64)}${BS}n${END}${BS}n"}`],
    ['a block cut off at the top (END without BEGIN)', `MIIEowIBAAKCAQEA${'Q'.repeat(64)}\n${END}\nafter`],
    ['a block cut off at the bottom (BEGIN without END)', `before\n${BEGIN}\n${'Q'.repeat(64)}`],
  ])('removes a private key written as %s', (_name, text) => {
    for (const result of [fromSymptom(text), buildPublicIssueBody({ ...BASE, errorText: text }, KEYS)]) {
      expect(result.body).toContain('<redacted-key-block>');
      expect(result.body).not.toMatch(/QQQQ|MIIEow|BEGIN|END PRIVATE|PuTTY-User|Private-Lines/);
      expect(result.suspectedLeaks).toEqual([]);
      expectMarksExact(result);
    }
  });

  it('keeps what follows a terminated block and a block cut off at the top', () => {
    const result = fromSymptom(`MIIEowIBAAKCAQEA${'Q'.repeat(64)}\n${END}\nafter`);
    expect(result.body).toContain('<redacted-key-block>\nafter\n```');
  });

  it('redacts a name that contains an invisible mark (Default_Ignorable) the way an unmarked name is', () => {
    for (const mark of ['\u034F', '\uFE0F', '\u200D', '\u00AD', '\u2060', '\u180B', '\u{E0100}']) {
      const result = fromSymptom(`exam${mark}ple${mark}-project failed`);
      expect(result.body).toContain('<project> failed');
      expect(result.body).not.toContain('-project');
      expect(result.suspectedLeaks).toEqual([]);
    }
  });

  it('redacts a root that contains a ZWJ emoji, with and without the joiner in the log', () => {
    const keys: LocalOnlyKeys = { projectRoots: ['/work/\u{1F468}\u200D\u{1F4BB}-proj'], properNouns: [] };
    for (const text of ['at /work/\u{1F468}\u200D\u{1F4BB}-proj/x', 'at /work/\u{1F468}\u{1F4BB}-proj/x']) {
      const result = fromSymptom(text, keys);
      expect(result.body).toContain('at <project>/x');
      expect(result.suspectedLeaks).toEqual([]);
    }
  });

  it('redacts percent-encoded names and roots (file:/// stack traces)', () => {
    const keys: LocalOnlyKeys = {
      projectRoots: ['/work/my proj'],
      properNouns: [
        { category: 'project', value: 'my example app' },
        { category: 'project', value: '仕事のアプリ' },
      ],
    };
    const text = [
      'at file:///work/my%20example%20app/x.mjs:1:1',
      `at file:///work/${encodeURIComponent('仕事のアプリ')}/x.mjs:1:1`,
      `at file:///work/${encodeURIComponent('仕事のアプリ').toLowerCase()}/y.mjs`,
      'at file:///work/my%20proj/z.mjs',
    ].join('\n');
    const result = fromSymptom(text, keys);
    expect(result.body).not.toMatch(/my%20|%E4|%e4|my example|仕事/);
    expect(result.body.match(/<project>/g)?.length).toBeGreaterThanOrEqual(4);
    expect(result.suspectedLeaks).toEqual([]);
  });

  it("redacts the project's folder name even when the log shows the root through another view", () => {
    const keys: LocalOnlyKeys = { projectRoots: ['C:\\Users\\jdoe\\work\\example-project'], properNouns: [] };
    for (const text of [
      'at /mnt/c/Users/jdoe/work/example-project/x',
      'at C:\\Users\\jdoe\\work/example-project/x',
      'at {"p":"\\/work\\/example-project\\/x"}',
    ]) {
      const result = fromSymptom(text, keys);
      expect(result.body).not.toMatch(/example-project|jdoe/);
      expect(result.suspectedLeaks).toEqual([]);
    }
  });

  it.each(['%40', String.fromCodePoint(0xff20)])('redacts an e-mail written with %s instead of an at sign', (at) => {
    const result = fromSymptom(`GET /u?email=someone${at}example.com&x=1`, { projectRoots: [], properNouns: [] });
    expect(result.body).toContain('email=<email>&x=1');
    expect(result.suspectedLeaks).toEqual([]);
  });

  it('labels a token that swallowed a path as a token, so a reviewer sees that a credential was there', () => {
    const result = fromSymptom('Authorization: Bearer /Users/jdoe/' + 'x'.repeat(20));
    expect(result.body).toContain('Authorization: <redacted-token>');
    expect(result.redactions.map((mark) => mark.kind)).toEqual(['token']);
  });

  it('is not changed by other code that used a RegExp built from an exported token shape', () => {
    const shape = TOKEN_SHAPES.find(({ name }) => name === 'github');
    const regex = new RegExp(shape?.source ?? '', shape?.flags);
    regex.test('z'.repeat(120) + TOKEN);
    expect(regex.lastIndex).toBeGreaterThan(100);
    const result = buildPublicIssueBody({ ...BASE, source: 'hook ' + TOKEN }, KEYS);
    expect(result.title).toBe('[hook・配布スクリプト] `hook <redacted-token>`');
    expect(result.suspectedLeaks).toEqual([]);
  });

  it('reports what a third glued link would still hide (the second pass is the last pass)', () => {
    // トークンの最後の文字が英数字 ('-' や '_' だと 2 回目でパスの直前の条件を満たす) なので、パスは 3 回目でないと見えない。
    const result = fromSymptom('example-project' + 'example-user' + 'sk-proj-' + 'x'.repeat(40) + '/Users/jdoe/x');
    expect(result.body).toContain('<project><user><redacted-token>/Users/jdoe/x');
    expect(result.suspectedLeaks.map(({ kind, matched }) => [kind, matched])).toEqual([['home-path', '/Users/jdoe/']]);
  });
});

describe('empty values render a fixed word, not an empty code span', () => {
  it.each([
    ['an empty version', { versions: { ...BASE.versions, os: '' } }, '- OS: (なし)\n'],
    ['an invisible-only version', { versions: { ...BASE.versions, nodeVersion: ZWSP + '\u034F' } }, '- Node: (なし)\n'],
    ['an empty start time', { firstOccurredAt: '' }, '- 最初に起きた時刻: (なし)\n'],
    ['a blank end time', { lastOccurredAt: ' \n ' }, '- 最後に起きた時刻: (なし)\n'],
  ])('writes (なし) for %s', (_name, patch, expected) => {
    const result = buildPublicIssueBody({ ...BASE, ...patch }, KEYS);
    expect(result.body).toContain(expected);
    expect(result.body).not.toMatch(/: `+ ?`*\n/);
    expect(result.suspectedLeaks).toEqual([]);
  });

  it('still omits a version that is absent, and keeps a real value in a code span', () => {
    const result = buildPublicIssueBody({ ...BASE, versions: { ...BASE.versions, bdVersion: undefined } }, KEYS);
    expect(result.body).not.toContain('- bd: ');
    expect(result.body).toContain('- OS: `Example OS`\n');
  });
});

describe('terminal colours, glued paths and encoded names (the second review of the same builder)', () => {
  const BS = '\\';
  const ESC = String.fromCharCode(0x1b);
  const NONE: LocalOnlyKeys = { projectRoots: [], properNouns: [] };
  const STRIPE_LONG = 'sk_live_' + 'x'.repeat(30);

  it.each([
    ['a raw ESC colour before /Users', `FAIL ${ESC}[36m/Users/jdoe/proj/x.test.ts${ESC}[39m`],
    ['a raw ESC dim before /home', `${ESC}[2m/home/jdoe/x${ESC}[22m`],
    ['a raw ESC colour before C:\\Users', `${ESC}[36mC:${BS}Users${BS}jdoe${BS}x.ts${ESC}[39m`],
    ['a raw ESC erase-line before /Users', `${ESC}[K/Users/jdoe/x`],
    ['a JSON \\u001b colour', `{"msg":"${BS}u001b[36m/Users/jdoe/x.ts${BS}u001b[39m"}`],
    ['a log \\x1b colour', `${BS}x1b[36m/home/jdoe/x`],
    ['a shell \\033 colour', `${BS}033[1;36m/Users/jdoe/x`],
    ['a shell \\e colour', `${BS}e[36mC:/Users/jdoe/x`],
  ])('removes the user name behind %s, in the free text and in the error text', (_name, text) => {
    for (const result of [fromSymptom(text, NONE), buildPublicIssueBody({ ...BASE, errorText: text }, NONE)]) {
      expect(result.body).not.toContain('jdoe');
      expect(result.body).not.toMatch(/\[3[69]m|\[2m|\[22m|\[K|\[1;36m/);
      expect(result.body).toContain('~/');
      expect(result.suspectedLeaks).toEqual([]);
      expectMarksExact(result);
    }
  });

  it.each([
    ['a JWT', JWT],
    ['a Stripe key', STRIPE_LONG],
    ['a GitHub token', TOKEN],
    ['an sk- key', SK],
    ['a Bearer credential', BEARER],
    ['an e-mail address', 'jdoe@example.com'],
  ])('removes %s that follows a colour code', (_name, secret) => {
    const result = fromSymptom(`${ESC}[2m${secret}${ESC}[22m`, NONE);
    expect(result.body).not.toMatch(/eyJaaaa|xxxxxx|y{8}|jdoe|sk-proj/);
    expect(result.body).toMatch(/<redacted-token>|<email>/);
    expect(result.suspectedLeaks).toEqual([]);
  });

  it.each([
    ['a truncated CSI before /Users', `x ${ESC}[/Users/jdoe/x`],
    ['a truncated CSI before /home', `x ${ESC}[/home/jdoe/x`],
    ['a truncated CSI, a space, then /Users', `x ${ESC}[ /Users/jdoe/x`],
    ['an 8-bit CSI with no body before /Users', `x ${String.fromCharCode(0x9b)}/Users/jdoe/x`],
    ['a truncated shell-form CSI before /Users', `echo ${BS}e[ /Users/jdoe/x`],
    ['a truncated CSI before a drive letter', `x ${ESC}[C:${BS}Users${BS}jdoe${BS}x`],
    ['tput sgr0 and a reset before /Users', `Error:${ESC}(B${ESC}[m/Users/jdoe/x`],
    ['a save-cursor escape before /Users', `${ESC}7/Users/jdoe/x`],
  ])('keeps the whole path after %s, so the user name is removed', (_name, text) => {
    for (const result of [fromSymptom(text, NONE), buildPublicIssueBody({ ...BASE, errorText: text }, NONE)]) {
      expect(result.body).not.toContain('jdoe');
      expect(result.body).toContain('~/');
      expect(result.suspectedLeaks).toEqual([]);
      expectMarksExact(result);
    }
  });

  it('removes the user name behind a one-letter compiler flag', () => {
    const text = 'c++ -I/Users/jdoe/Library/Caches/node-gyp/22.0.0/include/node -L/home/jdoe/lib -c x.cc';
    const result = fromSymptom(text, NONE);
    expect(result.body).not.toContain('jdoe');
    expect(result.body).toContain('-I~/Library/Caches/node-gyp');
    expect(result.suspectedLeaks).toEqual([]);
  });

  it.each([
    ['a digit before a home path', '12:00:00/Users/jdoe/x', 'home-path', '/Users/jdoe'],
    ['a letter before a Windows home path', `abcC:${BS}Users${BS}jdoe${BS}x`, 'home-path', `C:${BS}Users${BS}jdoe`],
    ['a Stripe key glued to an identifier', `key1${STRIPE_LONG}`, 'token', STRIPE_LONG],
    ['a JWT glued to an identifier', `id1${JWT}`, 'token', JWT.slice(JWT.indexOf('.'))],
  ])('does not replace but reports %s', (_name, text, kind, matched) => {
    const result = fromSymptom(text, NONE);
    expect(result.suspectedLeaks.map((leak) => [leak.field, leak.kind, leak.matched])).toEqual([['body', kind, matched]]);
  });

  it.each([
    ['an encoded Japanese name', `file=%2FUsers%2F${encodeURIComponent('小田')}%2Fwork%2Fx.ts`],
    ['an encoded space in the name', 'file=%2FUsers%2FJohn%20Smith%2Fx'],
    ['an encoded Windows path with %5C', 'GET /open?path=C%3A%5CUsers%5Cjdoe%5Cx.ts'],
    ['a lower-case encoded users', 'p=%2Fusers%2Fjdoe%2Fx'],
  ])('removes the whole user name of %s', (_name, text) => {
    const result = fromSymptom(text, NONE);
    expect(result.body).not.toMatch(/jdoe|Smith|%E5|John/);
    expect(result.body).toContain('~/');
    expect(result.suspectedLeaks).toEqual([]);
  });

  it('keeps package versions that look like an address, and still removes a real address and an ssh target', () => {
    const result = fromSymptom('npm ERR! peer react@18.2.0 from react-dom@19.0.0-rc.1; vitest@4.1.11; deploy@10.0.0.5 and jdoe@example.com', NONE);
    expect(result.body).toContain('react@18.2.0 from react-dom@19.0.0-rc.1; vitest@4.1.11; <email> and <email>');
    expect(result.suspectedLeaks).toEqual([]);
  });

  it('redacts an address that is followed by digit-only labels, and keeps the package versions of the same line', () => {
    const result = fromSymptom('to jdoe@example.com.1 and jdoe@example.com.2024 and jdoe@example.com.0.1; react@18.2.0 typescript@5.6.3 react@19.0.0-rc.1 vitest@4.1.11', NONE);
    expect(result.body).toContain('to <email> and <email> and <email>; react@18.2.0 typescript@5.6.3 react@19.0.0-rc.1 vitest@4.1.11');
    expect(result.suspectedLeaks).toEqual([]);
  });

  it('does not let a generic project folder name eat words of the report', () => {
    const keys: LocalOnlyKeys = { projectRoots: ['/work/test'], properNouns: [] };
    const result = fromSymptom('installed vitest@4.1.11 in /work/test/src and ran the test server', keys);
    expect(result.body).toContain('installed vitest@4.1.11 in <project>/src and ran the test server');
    expect(result.suspectedLeaks).toEqual([]);
  });

  it('does not leave a fragment of a glued token at the head cut of the error text (the cut moves out of the match)', () => {
    for (const pad of [960, 970, 975, 980, 985]) {
      const errorText = `${'h'.repeat(pad)} id1${SK}x\n${'m'.repeat(5_000)}`;
      const result = buildPublicIssueBody({ ...BASE, errorText }, NONE);
      expect(result.body).not.toMatch(/sk-/);
      expect(isWellFormed(result.body)).toBe(true);
    }
  });

  it('does not leave a fragment of a glued token at the tail cut of the error text either', () => {
    for (const pad of [960, 970, 975, 980, 985]) {
      const errorText = `${'m'.repeat(5_000)}\nid1${SK}x ${'t'.repeat(pad)}`;
      const result = buildPublicIssueBody({ ...BASE, errorText }, NONE);
      // 末尾側の断片は "sk-" を含まない (トークンの後ろ半分だけが残る) ので、本体の文字の並びで探す。
      expect(result.body).not.toContain('ab_-ab');
      expect(result.body).not.toMatch(/sk-/);
    }
  });

  it('does not leave a fragment of a glued token at the 8000 cut of a free-text field', () => {
    for (const pad of [7_960, 7_975, 7_985]) {
      const symptom = `${'h'.repeat(pad)} id1${SK}x\n${'m'.repeat(2_000)}`;
      const result = buildPublicIssueBody({ ...BASE, symptom }, NONE);
      expect(result.body).not.toMatch(/sk-/);
      expect(result.body).not.toContain('ab_-ab');
      expect(result.suspectedLeaks).toEqual([]);
    }
  });

  it('does not leave a fragment of a glued token at the 80 cut of a version field', () => {
    for (const pad of [40, 55, 60, 65]) {
      const bdboardVersion = `${'v'.repeat(pad)}id1${SK}x${'w'.repeat(40)}`;
      const result = buildPublicIssueBody({ ...BASE, versions: { ...BASE.versions, bdboardVersion } }, NONE);
      expect(result.body).not.toMatch(/sk-/);
      expect(result.body).not.toContain('ab_-ab');
      expect(result.suspectedLeaks).toEqual([]);
    }
  });
});

describe('keys that were not fully searched are reported, not dropped silently', () => {
  const shorts = Array.from({ length: 200 }, (_, index) => ({
    category: 'branch' as const,
    value: `b${index.toString(36).padStart(2, '0')}`,
  }));

  it('sets keysTruncated and puts a position-less key-overflow leak first', () => {
    const keys: LocalOnlyKeys = { projectRoots: [], properNouns: [...shorts, { category: 'user', value: 'example-user' }] };
    const result = fromSymptom('by example-user', keys);
    expect(result.keysTruncated).toBe(true);
    expect(result.suspectedLeaks[0]).toEqual({ field: 'body', kind: 'key-overflow', start: 0, end: 0, matched: '' });
    expect(result.body).toContain('by <user>');
  });

  it('reports a 201st long name too, and a name over 512 code points', () => {
    const many = Array.from({ length: 201 }, (_, index) => ({ category: 'user' as const, value: `name-${String(index).padStart(3, '0')}` }));
    expect(fromSymptom('x', { projectRoots: [], properNouns: many }).keysTruncated).toBe(true);
    const huge = { projectRoots: [], properNouns: [{ category: 'user' as const, value: 'z'.repeat(513) }] };
    expect(fromSymptom('x', huge).suspectedLeaks.map(({ kind }) => kind)).toEqual(['key-overflow']);
  });

  it('does not report anything for keys that all fit', () => {
    const result = fromSymptom('plain text');
    expect(result.keysTruncated).toBe(false);
    expect(result.suspectedLeaks).toEqual([]);
  });
});

describe('caps are applied after redaction', () => {
  it('cuts the free text at 8000 code points with a static omitted-count label', () => {
    const body = buildPublicIssueBody({ ...BASE, symptom: 'a'.repeat(8_500) }, KEYS).body;
    expect(body).toContain(`${'a'.repeat(8_000)}…(以降 500 文字省略)\n\`\`\``);
  });

  it('redacts the free text before the 8000 cut: a token or a noun straddling the cut leaves no fragment', () => {
    for (const secret of [TOKEN, 'example-project', 'example-user@example.com', `${BEGIN}\n${'k'.repeat(40)}\n${END}`]) {
      for (const field of ['symptom', 'cause', 'prevention'] as const) {
        const text = `${'a'.repeat(7_995)} ${secret} ${'b'.repeat(500)}`;
        const result = buildPublicIssueBody({ ...BASE, [field]: text }, KEYS);
        // 切れ目 (8000) は秘密の途中に落ちる。置換が先なので、印の始まりまで戻り、断片は省略側に入る。
        expect(result.body).not.toMatch(/ghp_|xxxx|example-project|example-user|@example|BEGIN|kkkk/);
        expect(result.body).toContain(`${'a'.repeat(7_995)} …(以降 `);
        expectMarksExact(result);
        expect(result.suspectedLeaks).toEqual([]);
      }
    }
  });

  it('keeps the head and the tail 1000 code points of the error text, redacting the whole text first', () => {
    const errorText = `${'a'.repeat(990)}${TOKEN} ${'b'.repeat(1_000)}${'c'.repeat(1_000)} ${TOKEN}${'d'.repeat(10)}`;
    const result = buildPublicIssueBody({ ...BASE, errorText }, KEYS);
    expect(result.body).not.toMatch(/ghp_|xxxx/);
    // 先頭側の切れ目 (1000) は最初のトークンの印の内側に落ちるので、印の始まり (990) まで戻る。
    expect(result.body).toMatch(/a{990}…\(\d+ 文字省略\)…/);
    // 末尾側は 1000 コードポイント。2 つ目のトークン (と、続く英数字) は 1 つの印になって残る。
    expect(result.body).toContain('c <redacted-token>\n```');
    expectMarksExact(result);
    expect(result.suspectedLeaks).toEqual([]);
  });

  it('shows the omitted code point count of the error text', () => {
    const result = buildPublicIssueBody({ ...BASE, errorText: 'x'.repeat(3_000) }, KEYS);
    expect(result.body).toContain(`${'x'.repeat(1_000)}…(1000 文字省略)…${'x'.repeat(1_000)}`);
  });

  it('caps names, times and versions after redaction and never splits a token', () => {
    const name = 'n'.repeat(75) + TOKEN;
    const result = buildPublicIssueBody({ ...BASE, source: name, firstOccurredAt: 'T'.repeat(100) }, KEYS);
    // 置換後は 75 + 16 コードポイント。80 の切れ目は印の内側なので印の始まりまで戻り、印は省略側に入る (断片も残らない)。
    expect(result.title).toBe(`[hook・配布スクリプト] \`${'n'.repeat(75)}…\``);
    const shortName = buildPublicIssueBody({ ...BASE, source: 'n'.repeat(10) + TOKEN }, KEYS);
    expect(shortName.title).toBe(`[hook・配布スクリプト] \`${'n'.repeat(10)}<redacted-token>\``);
    const long = buildPublicIssueBody({ ...BASE, source: 'n'.repeat(200) }, KEYS);
    expect(long.title).toBe(`[hook・配布スクリプト] \`${'n'.repeat(80)}…\``);
    expect(long.body).toContain(`- 対象: \`${'n'.repeat(120)}…\`\n`);
    expect(result.body).toContain(`- 最初に起きた時刻: \`${'T'.repeat(40)}…\`\n`);
  });

  it('does not split a surrogate pair at a cap', () => {
    const result = buildPublicIssueBody({ ...BASE, source: '😀'.repeat(100), errorText: '😀'.repeat(3_000) }, KEYS);
    expect(isWellFormed(result.title + result.body)).toBe(true);
  });
});

describe('lone surrogates never reach the output', () => {
  it.each([
    ['head', (value: string) => HIGH + value],
    ['middle', (value: string) => value + LOW + value],
    ['tail', (value: string) => value + HIGH],
    ['adjacent invalid pairs', (value: string) => HIGH + HIGH + value + LOW + LOW],
  ])('removes a lone surrogate at the %s of every field', (_name, wrap) => {
    const result = buildPublicIssueBody(allFields(wrap('text 😀 ok')), KEYS);
    expect(isWellFormed(result.title + result.body)).toBe(true);
    expect(result.body).toContain('text 😀 ok');
  });

  it('cuts by code point: a surrogate pair at the 8000 cut or at the error-text tail cut stays whole', () => {
    const free = buildPublicIssueBody({ ...BASE, symptom: `${'a'.repeat(7_999)}😀${'b'.repeat(100)}` }, KEYS);
    expect(isWellFormed(free.body)).toBe(true);
    expect(free.body).toContain(`${'a'.repeat(7_999)}😀…(以降 100 文字省略)`);
    const error = buildPublicIssueBody({ ...BASE, errorText: `${'b'.repeat(2_000)}${'😀'.repeat(600)}z` }, KEYS);
    expect(isWellFormed(error.body)).toBe(true);
    expect(error.body).toContain(`${'b'.repeat(1_000)}…(601 文字省略)…${'b'.repeat(399)}${'😀'.repeat(600)}z`);
  });
});

describe('type split and local-only keys', () => {
  const draft: IssueDraft = {
    id: '1',
    kind: 'B',
    fingerprint: 'f',
    title: 't',
    body: 'b',
    titleEditedByUser: false,
    bodyEditedByUser: false,
    localOnly: { symptomRaw: 's', causeRaw: 'c', preventionRaw: 'p', errorTextTruncated: false, envInfo: BASE.versions },
    occurredProjects: [],
    occurrenceCount: 1,
    firstOccurredAt: 'a',
    lastOccurredAt: 'b',
    status: 'pending',
    draftSchemaVersion: 1,
  };

  it('rejects an IssueDraft, and every field that must never be public, at compile time', () => {
    // IssueDraft に versions を足した変数: PublicBuildInput の必須の欄はすべて揃っているので、型エラーの原因は余分な欄
    // (localOnly・occurredProjects・fingerprint など) だけになる (versions の欠落で誤って通らない)。
    const draftWithVersions = { ...draft, versions: BASE.versions };
    const calls = [
      () =>
        // @ts-expect-error an IssueDraft (with localOnly / occurredProjects) cannot enter the public builder
        buildPublicIssueBody(draftWithVersions, KEYS),
      () =>
        // @ts-expect-error projectName is not a public field
        buildPublicIssueBody({ ...BASE, projectName: 'x' }, KEYS),
      () =>
        // @ts-expect-error branchName is not a public field
        buildPublicIssueBody({ ...BASE, branchName: 'x' }, KEYS),
      () =>
        // @ts-expect-error ticketId is not a public field
        buildPublicIssueBody({ ...BASE, ticketId: 'x' }, KEYS),
      () =>
        // @ts-expect-error ticketBody is not a public field
        buildPublicIssueBody({ ...BASE, ticketBody: 'x' }, KEYS),
      () =>
        // @ts-expect-error envValues is not a public field
        buildPublicIssueBody({ ...BASE, envValues: { TOKEN: 'x' } }, KEYS),
    ];
    expect(calls).toHaveLength(6);
  });

  it('rejects the same extra keys on a variable that is not a fresh object literal', () => {
    const withProjectName = { ...BASE, projectName: 'x' };
    const withBranchName = { ...BASE, branchName: 'x' };
    const withLocalOnly = { ...BASE, localOnly: { errorTextRaw: 'x' } };
    const calls = [
      () =>
        // @ts-expect-error NoExtraKeys applies to variables too
        buildPublicIssueBody(withProjectName, KEYS),
      () =>
        // @ts-expect-error NoExtraKeys applies to variables too
        buildPublicIssueBody(withBranchName, KEYS),
      () =>
        // @ts-expect-error NoExtraKeys applies to variables too
        buildPublicIssueBody(withLocalOnly, KEYS),
    ];
    expect(calls).toHaveLength(3);
  });

  it('never emits properties smuggled in with a cast, nor inherited or odd keys', () => {
    const sentinel = 'do-not-publish-sentinel';
    const smuggled = {
      ...BASE,
      projectName: sentinel,
      branchName: sentinel,
      ticketId: sentinel,
      ticketBody: sentinel,
      envValues: sentinel,
      repositoryUrl: sentinel,
      localOnly: { errorTextRaw: sentinel },
      ['__proto__']: { symptom: sentinel },
    };
    const result = buildPublicIssueBody(smuggled as PublicBuildInput, { projectRoots: [], properNouns: [] });
    expect(result.title + result.body).not.toContain(sentinel);
  });

  it('survives values from outside the types without printing them or inventing text', () => {
    const odd = {
      ...BASE,
      kind: 'toString',
      occurrenceCount: '5',
      firstOccurredAt: 42,
      source: { toString: () => 'object-source' },
      symptom: ['array-symptom'],
      versions: { ...BASE.versions, bdboardVersion: 123 },
    };
    const result = buildPublicIssueBody(odd as unknown as PublicBuildInput, KEYS);
    const output = result.title + result.body;
    expect(result.title).toBe('[不明] (名称なし)');
    expect(output).not.toMatch(/object-source|array-symptom|native code|function|\[object|123|42/);
    expect(result.body).toContain('- 発生回数: ?\n');
  });

  it('never prints a local-only key unless the input contained it, and then only as a placeholder', () => {
    const keys: LocalOnlyKeys = {
      projectRoots: ['/secret/zzz-root'],
      properNouns: [
        { category: 'project', value: 'zzz-project' },
        { category: 'user', value: 'zzz-person' },
        { category: 'host', value: 'zzz-machine' },
        { category: 'branch', value: 'zzz-branch' },
      ],
    };
    const clean = buildPublicIssueBody(allFields('nothing special'), keys);
    expect(clean.redactions).toEqual([]);
    const output = clean.title + clean.body;
    for (const key of ['zzz-root', 'zzz-project', 'zzz-person', 'zzz-machine', 'zzz-branch', '/secret']) {
      expect(output).not.toContain(key);
    }
    const dirty = buildPublicIssueBody(allFields('at /secret/zzz-root/a by ZZZ-PERSON on zzz-machine in zzz-branch'), keys);
    expect(dirty.body).toContain('at <project>/a by <user> on <host> in <branch>');
    expect(dirty.title + dirty.body).not.toMatch(/zzz|secret/i);
  });
});

describe('suspected leaks', () => {
  it('flags a short noun that the replacement step deliberately skipped, with its category and position', () => {
    const keys: LocalOnlyKeys = { projectRoots: [], properNouns: [{ category: 'branch', value: 'wip' }] };
    const result = buildPublicIssueBody({ ...BASE, symptom: 'wip failed while wipe passed' }, keys);
    const at = result.body.indexOf('wip failed');
    expect(result.body).toContain('wip failed');
    expect(result.suspectedLeaks).toEqual([{ field: 'body', kind: 'branch', start: at, end: at + 3, matched: 'wip' }]);
  });

  it('flags each category of short noun in title and body', () => {
    const keys: LocalOnlyKeys = {
      projectRoots: [],
      properNouns: [
        { category: 'project', value: 'ppp' },
        { category: 'user', value: 'uuu' },
        { category: 'host', value: 'hhh' },
        { category: 'branch', value: 'bbb' },
      ],
    };
    const result = buildPublicIssueBody({ ...BASE, source: 'ppp', symptom: 'uuu hhh bbb' }, keys);
    expect(result.suspectedLeaks.map(({ field, kind, matched }) => [field, kind, matched])).toEqual([
      ['title', 'project', 'ppp'],
      ['body', 'project', 'ppp'],
      ['body', 'user', 'uuu'],
      ['body', 'host', 'hhh'],
      ['body', 'branch', 'bbb'],
    ]);
  });

  it('does not flag placeholders even when a noun is literally email, project, token or user', () => {
    const keys: LocalOnlyKeys = {
      projectRoots: ['/work/example-project'],
      properNouns: [
        { category: 'user', value: 'email' },
        { category: 'project', value: 'project' },
        { category: 'host', value: 'token' },
        { category: 'branch', value: 'redacted' },
        { category: 'host', value: 'user' },
      ],
    };
    const input = `${TOKEN} example@example.com /work/example-project/a ${BEGIN}\nx\n${END}`;
    const result = buildPublicIssueBody({ ...BASE, symptom: input }, keys);
    expect(result.body).toContain('<redacted-token>');
    expect(result.body).toContain('<project>/a');
    expect(result.suspectedLeaks).toEqual([]);
  });

  it('redacts a token that only becomes visible after a neighbouring noun was replaced (second pass)', () => {
    // "sk-" の直前が英数字なので、1 回目の文字列ではトークンの形に一致しない。隣の固有名詞が <project> になると一致する。
    // 2 回目の置き換えがそれを取り除くので、最後の網は何も報告しない。
    const token = 'sk-proj-' + 'ab_-'.repeat(12);
    const result = buildPublicIssueBody({ ...BASE, symptom: `example-project${token}` }, KEYS);
    expect(result.body).toContain('<project><redacted-token>');
    expect(result.body).not.toContain('sk-proj');
    expect(result.suspectedLeaks).toEqual([]);
    expectMarksExact(result);
    const at = result.body.indexOf('<project><redacted-token>');
    const marks = result.redactions.filter((mark) => mark.start >= at && mark.end <= at + 25);
    expect(marks).toEqual([
      { field: 'body', kind: 'project', start: at, end: at + 9 },
      { field: 'body', kind: 'token', start: at + 9, end: at + 25 },
    ]);
  });

  it.each([
    ['Bearer', 'Bearer ' + 'y'.repeat(30), '<project><redacted-token>'],
    ['sk-', 'sk-' + 'x'.repeat(40), '<project><redacted-token>'],
    ['a home path', '/Users/jdoe/x', '<project>~/x'],
  ])('redacts %s glued to a noun in the second pass', (_name, glued, expected) => {
    const result = buildPublicIssueBody({ ...BASE, symptom: `example-project${glued}` }, KEYS);
    expect(result.body).toContain(expected);
    expect(result.suspectedLeaks).toEqual([]);
    expectMarksExact(result);
  });

  it('runs the last net over the final text: static template words that equal a noun are reported', () => {
    const keys: LocalOnlyKeys = { projectRoots: [], properNouns: [{ category: 'user', value: 'hook' }] };
    const result = buildPublicIssueBody({ ...BASE, source: 'x' }, keys);
    const at = result.title.indexOf('hook');
    expect(result.suspectedLeaks[0]).toEqual({ field: 'title', kind: 'user', start: at, end: at + 4, matched: 'hook' });
    expect(result.suspectedLeaks.some((leak) => leak.field === 'body' && leak.matched === 'hook')).toBe(true);
  });
});

describe('determinism and shared state', () => {
  it('returns equal results for equal input, also when other builds run in between', () => {
    const first = buildPublicIssueBody(allFields(`${TOKEN} example-user@example.com`), KEYS);
    buildPublicIssueBody(allFields('other input ghp_ example-host'), KEYS);
    const second = buildPublicIssueBody(allFields(`${TOKEN} example-user@example.com`), KEYS);
    expect(second).toEqual(first);
  });

  it('does not change the input or the keys', () => {
    const input = allFields(`${TOKEN} example-user`);
    const snapshot = JSON.stringify([input, KEYS]);
    buildPublicIssueBody(input, KEYS);
    expect(JSON.stringify([input, KEYS])).toBe(snapshot);
  });
});

describe('linear time on hostile 100k inputs', () => {
  it('builds in well under three seconds for every hostile shape and field', () => {
    const hostile = [
      'a'.repeat(100_000),
      'a@'.repeat(50_000),
      'sk-'.repeat(33_000),
      'ghp_'.repeat(25_000),
      'Bearer '.repeat(14_000),
      BEGIN.repeat(3_000),
      '/'.repeat(100_000),
      'eyJ'.repeat(30_000),
      'a.'.repeat(50_000),
      HIGH.repeat(100_000),
      '😀'.repeat(50_000),
      ' '.repeat(100_000) + 'x',
      '\n'.repeat(100_000) + 'x',
      '\t'.repeat(100_000) + 'x',
      '`'.repeat(100_000),
      '/Users/'.repeat(14_000),
      'C:\\Users\\a '.repeat(8_000),
      'example-project'.repeat(6_000),
      'example-user@'.repeat(7_000),
    ];
    const started = performance.now();
    for (const value of hostile) {
      for (const result of [
        buildPublicIssueBody({ ...BASE, errorText: value }, KEYS),
        buildPublicIssueBody({ ...BASE, symptom: value, source: value }, KEYS),
        buildPublicIssueBody({ ...BASE, agentNote: value, versions: { ...BASE.versions, os: value } }, KEYS),
      ]) {
        expect(isWellFormed(result.title + result.body)).toBe(true);
      }
    }
    expect(performance.now() - started).toBeLessThan(3000);
  });
});

describe('seeded mixed-input safety properties', () => {
  it('holds for 200 pseudo-random inputs', () => {
    let state = 0x4bd2;
    const next = (): number => {
      state = (state * 1_664_525 + 1_013_904_223) >>> 0;
      return state;
    };
    const fragments = [
      'EXAMPLE-PROJECT',
      'Example-Host',
      'feature-EXAMPLE',
      '/work/example-project/src',
      '/Users/example-user/x',
      'C:\\Users\\example-user\\y',
      TOKEN,
      AWS,
      'sk-proj-' + 'ab_-'.repeat(12),
      'example-user@example.com',
      '[x](http://example.com) @all #123 <img src=x>',
      ZWSP + 'hidden' + HIGH,
      LOW + 'low',
      '```\n# heading\n<!-- x -->',
      `${BEGIN}\n${'x'.repeat(40)}\n${END}`,
      'ordinary text 😀',
      '`',
    ];
    // 断片どうしを隣り合わせにしない: 隣の固有名詞の置換で "sk-" の直前の英数字が消えると、置換の前には後読みで見送られた
    // トークンが新しく現れる。その場面は下の専用のテストで最後の網が拾うことを確かめている。
    const separators = ['\n', ' ', '\r\n', LS];
    for (let iteration = 0; iteration < 200; iteration += 1) {
      const pick = (): string => fragments[next() % fragments.length] ?? '';
      const text = Array.from({ length: 6 }, () => pick() + (separators[next() % separators.length] ?? '')).join('');
      // 長い text は自由記述 (切れ目は 8000 / 1000 コードポイントで来ない) にだけ入れる。名前・版・時刻は 1 つの断片で、
      // 上限 (80 / 40) で切れて "/Users/…" のような印の無い断片 + 省略の印が残る場面を、この性質の検査から外す。
      const result = buildPublicIssueBody({ ...allFields(pick()), symptom: text, agentNote: text, errorText: text }, KEYS);
      const output = result.title + result.body;
      expect(result.suspectedLeaks).toEqual([]);
      for (const noun of LONG_NOUNS) expect(output.toLowerCase()).not.toContain(noun);
      expect(output).not.toContain('/work/');
      expect(findTokenSpans(output)).toEqual([]);
      expect(findEmailSpans(output)).toEqual([]);
      expect(isWellFormed(output)).toBe(true);
      expectMarksExact(result);
    }
  });

  // 隣り合わせ・エスケープ・パーセント表記を混ぜる。ここでの性質は「秘密は、取り除かれているか、疑いとして報告されているかのどちらか」
  // (黙って残らない)。判定には finder を使わず、秘密の文字列そのものが出力に残っているかで調べる。
  it('removes every secret (and has nothing to report) when fragments are glued with escapes and encodings', () => {
    let state = 0x7a31;
    const next = (): number => {
      state = (state * 1_664_525 + 1_013_904_223) >>> 0;
      return state;
    };
    // 置換すると必ず "<…>" の印になる断片で、終わりが「名前」「メール」「鍵ブロックの END」のもの: 直後に何を貼り付けても境界が
    // はっきりしている (印の直前は英数字ではないので、貼り付けたトークンは 2 回目の置き換えで見える)。
    // トークンは含めない: トークンの直後に別の文字を貼り付けると、"ya29.xxxx" + "Bearer" のように前のトークンが後ろの
    // キーワードを飲み込んで、どこまでが秘密か決められない入力になる (その入力は仕様の外)。トークンは空白・エスケープで区切る。
    const replaced = [
      'EXAMPLE-PROJECT',
      'Example-Host',
      'feature-EXAMPLE',
      'someone%40example.org',
      `${BEGIN}\n${'x'.repeat(40)}\n${END}`,
    ];
    const tokens = [TOKEN, AWS, SK, BEARER, JWT, STRIPE, GOOGLE_OAUTH, SLACK_APP];
    // 置換しても英数字や記号が後ろに残る断片 (パス)。そのうしろには、エスケープ・パーセント表記・空白だけを置く。
    const kept = [
      '/work/example-project/src',
      '/Users/example-user/x',
      'C:\\Users\\example-user\\y',
      '/home/jdoe/x',
      'ordinary text 😀',
      ZWSP + 'hidden' + HIGH,
      '`',
    ];
    const afterKept = ['\n', ' ', '\r\n', LS, '\\n', '\\t', '\\r', '%0A', '%20', '%3D'];
    const afterReplaced = [...afterKept, '', '', ''];
    const cores = [TOKEN, AWS, SK, BEARER_VALUE, JWT, STRIPE, GOOGLE_OAUTH, SLACK_APP, 'jdoe', 'someone%40', 'PRIVATE KEY', '/work/', ...LONG_NOUNS];
    for (let iteration = 0; iteration < 400; iteration += 1) {
      let text = '';
      for (let index = 0; index < 8; index += 1) {
        const choice = next() % 3;
        const pool = choice === 0 ? replaced : choice === 1 ? tokens : kept;
        const after = choice === 0 ? afterReplaced : afterKept;
        text += (pool[next() % pool.length] ?? '') + (after[next() % after.length] ?? '');
      }
      const result = buildPublicIssueBody({ ...allFields('x'), symptom: text, errorText: text }, KEYS);
      const output = (result.title + result.body).toLowerCase();
      const survivors = cores.filter((core) => output.includes(core.toLowerCase()));
      // 弱い性質 (取り除かれているか、報告されているか) は、強い性質 (取り除かれていて、報告も要らない) に含まれる。
      // これらの断片は第 2 の置き換えまでで必ず取り除けるので、強いほうを検査する: 第 2 の置き換えを外すと、貼り付いた
      // "sk-"・"Bearer" は最後の網の報告に回り、ここで落ちる。
      const leaks = result.suspectedLeaks.map((leak) => [leak.kind, leak.matched]);
      expect({ text, survivors, leaks }).toEqual({ text, survivors: [], leaks: [] });
      expect(isWellFormed(result.title + result.body)).toBe(true);
      expectMarksExact(result);
    }
  });
});
