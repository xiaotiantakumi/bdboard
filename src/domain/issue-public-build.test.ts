import { describe, expect, it } from 'vitest';
import type { IssueDraft } from './issue-draft.js';
import { buildPublicIssueBody } from './issue-public-build.js';
import { findEmailSpans, findTokenSpans } from './issue-public-secrets.js';
import type { LocalOnlyKeys, PublicBuildInput, PublicBuildResult, RedactionKind } from './issue-public-types.js';

// 孤立サロゲート・行区切りは実行時に組み立てる。トークンも実行時に組み立てる (シークレットスキャナに反応させない)。
const HIGH = String.fromCharCode(0xd83d);
const LOW = String.fromCharCode(0xde00);
const LS = String.fromCodePoint(0x2028);
const PS = String.fromCodePoint(0x2029);
const ZWSP = String.fromCodePoint(0x200b);
const TOKEN = 'ghp_' + 'x'.repeat(36);
const AWS = 'AKIA' + 'X'.repeat(16);
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
    for (const secret of [TOKEN, AWS, 'example-user', 'example-project', 'example-host', 'feature-example', '@example.com']) {
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
    const calls = [
      () =>
        // @ts-expect-error an IssueDraft (with localOnly / occurredProjects) cannot enter the public builder
        buildPublicIssueBody(draft, KEYS),
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

  it('catches a token that only becomes visible after a neighbouring noun was replaced', () => {
    // "sk-" の直前が英数字なので、置換の前の文字列ではトークンの形に一致しない。隣の固有名詞が <project> になると一致する。
    const token = 'sk-proj-' + 'ab_-'.repeat(12);
    const result = buildPublicIssueBody({ ...BASE, symptom: `example-project${token}` }, KEYS);
    const at = result.body.indexOf(token);
    expect(at).toBeGreaterThan(0);
    expect(result.body).toContain(`<project>${token}`);
    expect(result.suspectedLeaks).toEqual([{ field: 'body', kind: 'token', start: at, end: at + token.length, matched: token }]);
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
});
