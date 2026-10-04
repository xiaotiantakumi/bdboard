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

  it('builds the body from a fixed set of lines: no symptom, error text, path or project name can be passed in', () => {
    const text = buildProvisionalDraftText({
      kind: 'B',
      source: 'stop-ticket-gate.sh',
      versions: VERSIONS,
      occurrenceCount: 1,
      firstOccurredAt: '2026-10-04T12:00:00.000Z',
      lastOccurredAt: '2026-10-04T12:00:00.000Z',
    });
    expect(text.title).toBe('[hook・配布スクリプト] stop-ticket-gate.sh');
    expect(text.body.split('\n')).toEqual([
      '種類: hook・配布スクリプト',
      '対象: stop-ticket-gate.sh',
      '発生回数: 1',
      '最初に起きた時刻: 2026-10-04T12:00:00.000Z',
      '最後に起きた時刻: 2026-10-04T12:00:00.000Z',
      '',
      '版:',
      '- bdboard: 0.1.2',
      '- ハーネス: 0.56.0',
      '- OS: darwin',
      '- Node: v22.14.0',
      '',
      '(症状・原因・エラー文は、公開本文の組み立てが入るまでこの本文に含めていません。手元の情報にあります。)',
    ]);
  });

  // 名前 (source・catalogSlug) と版は、渡された 1 行の文字列がそのまま入る。このビルダーは中身を
  // 検査しない。改行や制御文字を含む値を 400 で止めるのは HTTP の入口 (issue-report-routes.test.ts の
  // "fields that reach the public title and body") と isSingleLineText (issue-draft.test.ts)。
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
