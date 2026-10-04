import { describe, expect, it } from 'vitest';
import {
  ISSUE_DRAFT_ERROR_TEXT_EDGE_CHARS,
  ISSUE_DRAFT_ERROR_TEXT_RAW_MAX_CHARS,
  ISSUE_DRAFT_MAX_JSON_BYTES,
  capErrorTextRaw,
  computeDraftFingerprint,
  fitDraftToByteLimit,
  hourBucketOf,
  isDraftId,
  isMassOccurrenceFingerprint,
  massOccurrenceFingerprint,
  normalizeErrorText,
  summarizeErrorText,
  type IssueDraft,
} from './issue-draft.js';

function makeDraft(overrides: Partial<IssueDraft['localOnly']> = {}): IssueDraft {
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

describe('fitDraftToByteLimit', () => {
  const byteLength = (draft: IssueDraft): number => Buffer.byteLength(JSON.stringify(draft), 'utf8');

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
});
