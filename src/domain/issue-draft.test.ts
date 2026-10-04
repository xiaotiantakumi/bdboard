import { describe, expect, it } from 'vitest';
import {
  ISSUE_DRAFT_ERROR_TEXT_EDGE_CHARS,
  ISSUE_DRAFT_ERROR_TEXT_RAW_MAX_CHARS,
  ISSUE_DRAFT_MAX_JSON_BYTES,
  canonicalizeIdentifier,
  capErrorTextRaw,
  computeDraftFingerprint,
  hourBucketOf,
  isDraftId,
  isMassOccurrenceFingerprint,
  isSingleLineText,
  massOccurrenceFingerprint,
  normalizeErrorText,
  summarizeErrorText,
  type IssueDraft,
} from './issue-draft.js';
import { draftJsonBytes, fitDraftToByteLimit, serializeDraft } from './issue-draft-size.js';

function makeDraft(
  overrides: Partial<IssueDraft['localOnly']> = {},
  topLevel: Partial<IssueDraft> = {},
): IssueDraft {
  return {
    id: '1758812345678-a1b2c3d4e5f6a7b8',
    kind: 'B',
    fingerprint: 'B:example-hook:0123456789abcdef',
    title: 'title',
    body: 'body',
    titleEditedByUser: false,
    bodyEditedByUser: false,
    localOnly: {
      symptomRaw: 'symptom',
      causeRaw: 'cause',
      preventionRaw: 'prevention',
      errorTextTruncated: false,
      envInfo: { bdboardVersion: '0.0.0', os: 'darwin', nodeVersion: 'v22.14.0' },
      ...overrides,
    },
    occurredProjects: [],
    occurrenceCount: 1,
    firstOccurredAt: '2026-10-04T12:00:00.000Z',
    lastOccurredAt: '2026-10-04T12:00:00.000Z',
    status: 'pending',
    draftSchemaVersion: 1,
    ...topLevel,
  };
}

describe('isDraftId', () => {
  it('accepts the <epochMs>-<16 hex> shape the attachment storage also uses', () => {
    expect(isDraftId('1758812345678-a1b2c3d4e5f6a7b8')).toBe(true);
  });

  it('rejects path traversal and other shapes', () => {
    for (const value of ['', '..', '../x', 'a/b', '1758812345678-A1B2C3D4E5F6A7B8', '1758812345678-abc', 'abc-a1b2c3d4e5f6a7b8']) {
      expect(isDraftId(value)).toBe(false);
    }
  });
});

describe('hour bucket and the mass-occurrence fingerprint', () => {
  it('buckets by UTC calendar hour', () => {
    expect(hourBucketOf(new Date('2026-10-04T12:59:59.999Z'))).toBe('2026-10-04T12');
    expect(hourBucketOf(new Date('2026-10-04T13:00:00.000Z'))).toBe('2026-10-04T13');
  });

  it('builds mass-occurrence:<kind>:<bucket> and recognises it', () => {
    const fingerprint = massOccurrenceFingerprint('C', new Date('2026-10-04T12:30:00.000Z'));
    expect(fingerprint).toBe('mass-occurrence:C:2026-10-04T12');
    expect(isMassOccurrenceFingerprint(fingerprint)).toBe(true);
    expect(isMassOccurrenceFingerprint('C:server:0123456789abcdef')).toBe(false);
  });
});

describe('normalizeErrorText', () => {
  it('collapses paths, ids, locations, timestamps and numbers so one symptom normalises alike', () => {
    const first = normalizeErrorText(
      'Error at /Users/example-user/proj/a.ts:12:34 id deadbeef0123 at 2026-10-04T12:34:56.789Z port 8787',
    );
    const second = normalizeErrorText(
      'ERROR at /home/other-user/work/a.ts:99:1 id 0123456789ab at 2027-01-02T03:04:05.000Z port 9000',
    );
    expect(first).toBe(second);
    expect(first).not.toContain('example-user');
    expect(first).not.toMatch(/\d/);
  });

  it('keeps genuinely different messages distinct', () => {
    expect(normalizeErrorText('connection refused')).not.toBe(normalizeErrorText('permission denied'));
  });

  it('collapses an ISO time with and without fractional seconds to one value', () => {
    // 時刻の置換を先に行う理由。後に回すと小数秒のあるほうだけ ":34:56" が行:列に食われて別の文字列になる。
    expect(normalizeErrorText('failed at 2026-10-04T12:34:56.789Z')).toBe(
      normalizeErrorText('failed at 2027-01-02T03:04:05Z'),
    );
  });

  it('collapses UUIDs, including the 4-hex groups that the long-hex rule alone would leave behind', () => {
    const first = normalizeErrorText('job 3f2b8c1e-9a4d-4e7b-8c21-5d6f0a1b2c3d not found');
    const second = normalizeErrorText('job 0b9e7d52-1c3a-4f68-9e04-a7c8d9e0f1b2 not found');
    expect(first).toBe(second);
    expect(first).not.toMatch(/[0-9a-f]{4}-/);
  });

  it('collapses 7-character git short SHAs that contain a digit, but not plain words', () => {
    expect(normalizeErrorText('merge a1b2c3d failed')).toBe(normalizeErrorText('merge 9f8e7d6 failed'));
    expect(normalizeErrorText('merge 1234567 failed')).toBe(normalizeErrorText('merge fedcba9 failed'));
    // 英字だけで 16 進に見える 7 文字の単語 ("defaced" "acceded") は消さない。
    expect(normalizeErrorText('site defaced')).toBe('site defaced');
    expect(normalizeErrorText('acceded to request')).toBe('acceded to request');
  });

  it('collapses per-run temp directories (macOS /private/var/folders, /var/folders, /var/tmp, /tmp)', () => {
    const variants = [
      'cannot open /private/var/folders/zz/abc123def/T/tmp.AbCdEf/out.log',
      'cannot open /var/folders/q1/xyz789/T/tmp.123456/out.log',
      'cannot open /var/tmp/run-998877/out.log',
      'cannot open /tmp/build-4f9a2c/out.log',
    ].map(normalizeErrorText);
    expect(new Set(variants).size).toBe(1);
    expect(variants[0]).toBe('cannot open <path>');
  });

  it('does not eat "/tmp/" in the middle of another path segment', () => {
    expect(normalizeErrorText('see /srv/app/tmp/cache.txt')).toContain('/srv/app/tmp/cache.txt');
  });

  it('collapses Windows user paths in either slash style and in JSON-escaped form', () => {
    const variants = [
      'ENOENT C:\\Users\\example-user\\proj\\a.ts',
      'ENOENT D:/Users/someone-else/work/a.ts',
      'ENOENT c:\\users\\third-user\\x\\a.ts',
      'ENOENT C:\\\\Users\\\\fourth-user\\\\a.ts',
    ].map(normalizeErrorText);
    expect(new Set(variants).size).toBe(1);
    expect(variants[0]).toBe('enoent <path>');
  });
});

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

  it('rejects zero-width, bidirectional-control and BOM characters (they reorder or hide text on screen)', () => {
    const invisible = [
      '\u200b', '\u200c', '\u200d', '\u200e', '\u200f', // ゼロ幅・左右の印
      '\u202a', '\u202b', '\u202c', '\u202d', '\u202e', // 双方向の埋め込み・上書き
      '\u2066', '\u2067', '\u2068', '\u2069', // 双方向の孤立
      '\ufeff', // BOM / ゼロ幅の非改行スペース
    ];
    for (const char of invisible) {
      expect(isSingleLineText(`a${char}b`)).toBe(false);
      expect(isSingleLineText(char)).toBe(false);
    }
  });

  it('accepts the characters just outside those ranges and ordinary non-ASCII', () => {
    for (const value of ['a\u200ab', 'a\u2010b', 'a\u2030b', 'a\u2065b', 'a\u206ab', 'a\ufefeb', 'a\uff00b', 'a b', 'ａｂｃ', '😀 ok']) {
      expect(isSingleLineText(value)).toBe(true);
    }
  });
});

describe('canonicalizeIdentifier', () => {
  it.each([
    ['/Users/example-user/proj/.claude/hooks/stop.sh', '~/proj/.claude/hooks/stop.sh'],
    ['/home/example-user/.claude/hooks/stop.sh', '~/.claude/hooks/stop.sh'],
    ['C:\\Users\\example-user\\proj\\stop.sh', '~/proj\\stop.sh'],
    ['D:/Users/example-user/proj/stop.sh', '~/proj/stop.sh'],
    ['c:\\users\\example-user\\stop.sh', '~/stop.sh'],
    ['C:\\Users\\John Smith\\stop.sh', '~/stop.sh'],
    ['/Users/example-user', '~/'],
    ['bash /home/example-user/x.sh --flag', 'bash ~/x.sh --flag'],
    ['--script=/Users/example-user/x.sh', '--script=~/x.sh'],
    ['"/Users/example-user/x.sh"', '"~/x.sh"'],
    ['file:///Users/example-user/x.sh', 'file://~/x.sh'],
    ['  stop.sh  ', 'stop.sh'],
  ])('%s -> %s', (input, expected) => {
    expect(canonicalizeIdentifier(input)).toBe(expected);
    expect(canonicalizeIdentifier(expected)).toBe(expected);
  });

  it.each([
    'stop-ticket-gate.sh',
    'GET /api/runs/:id',
    'GET /api/home/x/y',
    'POST /api/Users/42/profile',
    '~/proj/stop.sh',
    './hooks/stop.sh',
    'jq-missing',
  ])('leaves %s alone', (value) => {
    expect(canonicalizeIdentifier(value)).toBe(value);
  });

  it('gives two users running the same script the same fingerprint', () => {
    const fingerprintFor = (source: string) =>
      computeDraftFingerprint({ kind: 'B', source: canonicalizeIdentifier(source), errorText: 'boom' });
    expect(fingerprintFor('/Users/example-user/proj/stop.sh')).toBe(
      fingerprintFor('/home/example-other/proj/stop.sh'),
    );
  });
});

describe('computeDraftFingerprint', () => {
  it('kind A uses the failure-catalog slug as-is', () => {
    expect(computeDraftFingerprint({ kind: 'A', catalogSlug: 'diff-against-moving-main' })).toBe(
      'A:diff-against-moving-main',
    );
  });

  it('kind A without a slug cannot be fingerprinted', () => {
    expect(computeDraftFingerprint({ kind: 'A' })).toBeUndefined();
    expect(computeDraftFingerprint({ kind: 'A', catalogSlug: '  ' })).toBeUndefined();
  });

  it('kind B/C combine the source with a hash of the normalised error text', () => {
    const one = computeDraftFingerprint({
      kind: 'B',
      source: 'stop-ticket-gate.sh',
      errorText: 'failed at /Users/example-user/a.sh:10:2 pid 4242',
    });
    const same = computeDraftFingerprint({
      kind: 'B',
      source: 'stop-ticket-gate.sh',
      errorText: 'FAILED at /Users/someone-else/a.sh:77:9 pid 9999',
    });
    const otherSource = computeDraftFingerprint({
      kind: 'B',
      source: 'worktree-freshness.sh',
      errorText: 'failed at /Users/example-user/a.sh:10:2 pid 4242',
    });
    expect(one).toMatch(/^B:stop-ticket-gate\.sh:[0-9a-f]{16}$/);
    expect(same).toBe(one);
    expect(otherSource).not.toBe(one);
    expect(computeDraftFingerprint({ kind: 'C', source: 'GET /api/x', errorText: 'boom' })).toMatch(
      /^C:GET \/api\/x:[0-9a-f]{16}$/,
    );
  });

  it('kind B/C without a source cannot be fingerprinted; the symptom stands in for a missing error text', () => {
    expect(computeDraftFingerprint({ kind: 'C', errorText: 'boom' })).toBeUndefined();
    expect(computeDraftFingerprint({ kind: 'C', source: 's', symptom: 'x' })).toBe(
      computeDraftFingerprint({ kind: 'C', source: 's', errorText: 'x' }),
    );
  });
});

describe('error text limits', () => {
  it('keeps a short error text whole', () => {
    expect(summarizeErrorText('short')).toEqual({ head: 'short', tail: '', truncated: false, omittedChars: 0 });
    const edge = 'x'.repeat(ISSUE_DRAFT_ERROR_TEXT_EDGE_CHARS * 2);
    expect(summarizeErrorText(edge).truncated).toBe(false);
  });

  it('keeps only the head and the tail of a long error text', () => {
    const text = `HEAD${'m'.repeat(5000)}TAIL`;
    const summary = summarizeErrorText(text);
    expect(summary.truncated).toBe(true);
    expect(summary.head).toHaveLength(ISSUE_DRAFT_ERROR_TEXT_EDGE_CHARS);
    expect(summary.tail).toHaveLength(ISSUE_DRAFT_ERROR_TEXT_EDGE_CHARS);
    expect(summary.head.startsWith('HEAD')).toBe(true);
    expect(summary.tail.endsWith('TAIL')).toBe(true);
    expect(summary.omittedChars).toBe(text.length - ISSUE_DRAFT_ERROR_TEXT_EDGE_CHARS * 2);
  });

  it('cuts the raw error text from the end past the cap', () => {
    const text = `START${'z'.repeat(ISSUE_DRAFT_ERROR_TEXT_RAW_MAX_CHARS)}`;
    const capped = capErrorTextRaw(text);
    expect(capped).toHaveLength(ISSUE_DRAFT_ERROR_TEXT_RAW_MAX_CHARS);
    expect(capped.startsWith('START')).toBe(true);
    expect(capErrorTextRaw('abc')).toBe('abc');
  });
});

describe('serializeDraft', () => {
  it('is one compact line plus a newline, and draftJsonBytes is exactly its UTF-8 length', () => {
    const draft = makeDraft({ symptomRaw: 'line one\nline two あ' });
    const text = serializeDraft(draft);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.slice(0, -1)).not.toContain('\n');
    expect(JSON.parse(text)).toEqual(draft);
    expect(draftJsonBytes(draft)).toBe(Buffer.byteLength(text, 'utf8'));
  });
});

describe('fitDraftToByteLimit', () => {
  const byteLength = (draft: IssueDraft): number => draftJsonBytes(draft);

  it('leaves a draft under the cap untouched', () => {
    const draft = makeDraft({ errorTextRaw: 'small' });
    expect(fitDraftToByteLimit(draft)).toBe(draft);
  });

  it('cuts the raw error text from the end until draft.json fits the 200KB cap', () => {
    const raw = 'あ'.repeat(ISSUE_DRAFT_ERROR_TEXT_RAW_MAX_CHARS); // 3 bytes per char -> ~192KB
    const draft = makeDraft({
      errorTextRaw: raw,
      agentNoteRaw: 'い'.repeat(8000),
      symptomRaw: 'う'.repeat(8000),
    });
    expect(byteLength(draft)).toBeGreaterThan(ISSUE_DRAFT_MAX_JSON_BYTES);

    const fitted = fitDraftToByteLimit(draft);
    expect(byteLength(fitted)).toBeLessThanOrEqual(ISSUE_DRAFT_MAX_JSON_BYTES);
    const fittedRaw = fitted.localOnly.errorTextRaw ?? '';
    expect(fittedRaw.length).toBeLessThan(raw.length);
    expect(raw.startsWith(fittedRaw)).toBe(true);
    // 切り詰めの対象は errorTextRaw が先。ほかの自由記述は無事なまま。
    expect(fitted.localOnly.agentNoteRaw).toBe(draft.localOnly.agentNoteRaw);
    expect(fitted.localOnly.symptomRaw).toBe(draft.localOnly.symptomRaw);
  });

  const project = (name: string, lastSeenAt: string) => ({
    name,
    path: `/p/${name}`,
    firstSeenAt: '2026-10-04T00:00:00.000Z',
    lastSeenAt,
  });

  it('measures the way the file is written: control characters that JSON escapes to 6 bytes count in full', () => {
    // 1 文字が 6 バイトに膨らむ。文字数 (200 字 x 100 件) だけで見ると 200KB 未満に見える。
    const nasty = '\u0001'.repeat(200);
    const projects = Array.from({ length: 100 }, (_, index) =>
      project(`${nasty}${index}`, `2026-10-04T${String(index % 24).padStart(2, '0')}:00:00.000Z`),
    );
    const draft = makeDraft({}, { occurredProjects: projects });
    expect(byteLength(draft)).toBeGreaterThan(ISSUE_DRAFT_MAX_JSON_BYTES);
    expect(fitDraftToByteLimit(draft).occurredProjects.length).toBeLessThan(100);
  });

  it('drops the project with the oldest lastSeenAt first and keeps the rest in order', () => {
    const projects = [
      project('seen-long-ago', '2026-10-01T00:00:00.000Z'),
      project('seen-recently', '2026-10-04T11:00:00.000Z'),
      project('seen-last-week', '2026-09-27T00:00:00.000Z'),
      project('seen-today', '2026-10-04T12:00:00.000Z'),
    ];
    const draft = makeDraft({}, { occurredProjects: projects });
    // 1 件ぶんだけ超えている状況: 上限を現在の大きさより 1 バイト小さくする。
    const fitted = fitDraftToByteLimit(draft, byteLength(draft) - 1);
    expect(fitted.occurredProjects.map((entry) => entry.name)).toEqual([
      'seen-long-ago',
      'seen-recently',
      'seen-today',
    ]);
  });

  it('shrinks the raw error text, then project rows, then folded fingerprints, then the written fields', () => {
    const folded = Array.from({ length: 50 }, (_, index) => `C:source-${index}:0123456789abcdef`);
    const projects = Array.from({ length: 10 }, (_, index) =>
      project(`p${index}`, `2026-10-04T0${index}:00:00.000Z`),
    );
    const draft = makeDraft(
      { errorTextRaw: 'e'.repeat(2000), foldedFingerprints: folded, symptomRaw: 's'.repeat(2000) },
      { occurredProjects: projects },
    );

    const noRaw = fitDraftToByteLimit(draft, byteLength(draft) - 1500);
    expect(noRaw.localOnly.errorTextRaw?.length).toBeLessThan(2000);
    expect(noRaw.occurredProjects).toHaveLength(10);

    const noRawAndProjects = fitDraftToByteLimit(draft, byteLength(draft) - 2000 - 400);
    expect(noRawAndProjects.localOnly.errorTextRaw).toBe('');
    expect(noRawAndProjects.occurredProjects.length).toBeLessThan(10);
    expect(noRawAndProjects.localOnly.foldedFingerprints).toHaveLength(50);

    const foldedToo = fitDraftToByteLimit(draft, byteLength(draft) - 2000 - 900 - 500);
    expect(foldedToo.occurredProjects).toHaveLength(0);
    expect(foldedToo.localOnly.foldedFingerprints?.length).toBeLessThan(50);
    // 古いほう (先頭) から落とし、新しい指紋が残る。
    expect(foldedToo.localOnly.foldedFingerprints?.at(-1)).toBe(folded.at(-1));
    expect(foldedToo.localOnly.symptomRaw).toBe('s'.repeat(2000));
  });

  it('stays within the cap for a hostile mix of every growable field', () => {
    const nasty = '"\\\u0001あ'.repeat(50);
    const draft = makeDraft(
      {
        errorTextRaw: nasty.repeat(400),
        agentNoteRaw: nasty.repeat(60),
        symptomRaw: nasty.repeat(60),
        causeRaw: nasty.repeat(60),
        preventionRaw: nasty.repeat(60),
        foldedFingerprints: Array.from({ length: 200 }, (_, index) => `C:${nasty}${index}:0123456789abcdef`),
      },
      {
        occurredProjects: Array.from({ length: 100 }, (_, index) => ({
          name: `${nasty}${index}`,
          path: `/${nasty}/${index}`,
          firstSeenAt: '2026-10-04T00:00:00.000Z',
          lastSeenAt: `2026-10-04T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
        })),
      },
    );
    expect(byteLength(draft)).toBeGreaterThan(ISSUE_DRAFT_MAX_JSON_BYTES * 3);
    expect(byteLength(fitDraftToByteLimit(draft))).toBeLessThanOrEqual(ISSUE_DRAFT_MAX_JSON_BYTES);
  });

  it('stays over the cap when nothing shrinkable is left (a fixed field such as the body is huge); the storage then refuses', () => {
    const draft = { ...makeDraft(), body: 'あ'.repeat(ISSUE_DRAFT_MAX_JSON_BYTES) };
    const fitted = fitDraftToByteLimit(draft);
    // 縮められる欄は削り切っている。それでも超える分は固定の欄 (題名・本文) のせい。
    expect([fitted.localOnly.symptomRaw, fitted.localOnly.causeRaw, fitted.localOnly.preventionRaw]).toEqual(['', '', '']);
    expect(fitted.body).toBe(draft.body);
    expect(byteLength(fitted)).toBeGreaterThan(ISSUE_DRAFT_MAX_JSON_BYTES);
  });
});
