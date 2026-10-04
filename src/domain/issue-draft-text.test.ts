import { describe, expect, it } from 'vitest';
import { buildMassOccurrenceText, buildProvisionalDraftText } from './issue-draft-text.js';

const VERSIONS = { bdboardVersion: '0.1.2', harnessVersion: '0.56.0', os: 'darwin', nodeVersion: 'v22.14.0' };

describe('buildProvisionalDraftText', () => {
  it('names the rule or script and carries counts and versions', () => {
    const text = buildProvisionalDraftText({
      kind: 'A',
      catalogSlug: 'diff-against-moving-main',
      versions: VERSIONS,
      occurrenceCount: 3,
      firstOccurredAt: '2026-10-04T12:00:00.000Z',
      lastOccurredAt: '2026-10-04T13:00:00.000Z',
    });
    expect(text.title).toContain('diff-against-moving-main');
    expect(text.body).toContain('3');
    expect(text.body).toContain('0.1.2');
    expect(text.body).toContain('v22.14.0');
  });

  it('never carries free text: no symptom, error text, path or project name can reach the body', () => {
    // 入力型にそれらを受ける口が無いことを、出力に紛れ込めないことで確かめる。
    const text = buildProvisionalDraftText({
      kind: 'B',
      source: 'stop-ticket-gate.sh',
      versions: VERSIONS,
      occurrenceCount: 1,
      firstOccurredAt: '2026-10-04T12:00:00.000Z',
      lastOccurredAt: '2026-10-04T12:00:00.000Z',
    });
    expect(text.title).toContain('stop-ticket-gate.sh');
    expect(`${text.title}\n${text.body}`).not.toMatch(/\/Users\/|\/home\//);
  });
});

describe('buildMassOccurrenceText', () => {
  it('says only that many unrelated problems arrived in that hour', () => {
    const text = buildMassOccurrenceText({
      kind: 'C',
      bucket: '2026-10-04T12',
      foldedCount: 7,
      foldedCountCapped: false,
      occurrenceCount: 9,
      firstOccurredAt: '2026-10-04T12:01:00.000Z',
      lastOccurredAt: '2026-10-04T12:40:00.000Z',
    });
    expect(text.title).toContain('大量発生');
    expect(text.body).toContain('7');
    expect(text.body).toContain('9');
    expect(text.body).toContain('2026-10-04T12');
  });

  it('marks a folded-fingerprint count that hit the list cap as "or more"', () => {
    const text = buildMassOccurrenceText({
      kind: 'C',
      bucket: '2026-10-04T12',
      foldedCount: 200,
      foldedCountCapped: true,
      occurrenceCount: 500,
      firstOccurredAt: '2026-10-04T12:01:00.000Z',
      lastOccurredAt: '2026-10-04T12:40:00.000Z',
    });
    expect(text.body).toContain('200 件以上');
  });
});
