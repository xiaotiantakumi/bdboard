import { describe, expect, it } from 'vitest';
import { checkHygiene } from './hygiene.js';
import { NOW } from './hygiene-test-support.js';
import { makeTicket } from './test-support.js';

describe('checkHygiene in_flight_file_overlap', () => {
  const projectId = '/projects/bdboard';

  function overlap(
    ticketIds: readonly [string, string],
    files: readonly string[],
  ) {
    return { projectId, ticketIds, files } as const;
  }

  it('emits one info issue on each side of the pair', () => {
    const tickets = [
      makeTicket({ id: 'bdboard-a', projectId, status: 'in_progress' }),
      makeTicket({ id: 'bdboard-b', projectId, status: 'in_progress' }),
    ];

    const issues = checkHygiene(tickets, {
      now: NOW,
      inFlightOverlaps: [overlap(['bdboard-a', 'bdboard-b'], ['src/domain/hygiene.ts'])],
    }).filter((issue) => issue.kind === 'in_flight_file_overlap');

    expect(issues).toHaveLength(2);
    expect(issues.map((issue) => issue.ticketId)).toEqual([
      'bdboard-a',
      'bdboard-b',
    ]);
    for (const issue of issues) {
      expect(issue.severity).toBe('info');
      expect(issue.projectId).toBe(projectId);
    }
    expect(issues[0]!.message).toBe(
      '着手中の 1 件と同じファイルを編集中: bdboard-b: src/domain/hygiene.ts',
    );
    expect(issues[0]!.overlaps).toEqual([
      { otherTicketId: 'bdboard-b', files: ['src/domain/hygiene.ts'] },
    ]);
    expect(issues[1]!.overlaps).toEqual([
      { otherTicketId: 'bdboard-a', files: ['src/domain/hygiene.ts'] },
    ]);
  });

  it('lists at most five files and counts the rest', () => {
    const tickets = [
      makeTicket({ id: 'bdboard-a', projectId, status: 'in_progress' }),
      makeTicket({ id: 'bdboard-b', projectId, status: 'in_progress' }),
    ];
    const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts'];

    const issues = checkHygiene(tickets, {
      now: NOW,
      inFlightOverlaps: [overlap(['bdboard-a', 'bdboard-b'], files)],
    }).filter((issue) => issue.kind === 'in_flight_file_overlap');

    expect(issues[0]!.message).toBe(
      '着手中の 1 件と同じファイルを編集中: bdboard-b: a.ts, b.ts, c.ts, d.ts, e.ts (+2)',
    );
    // メッセージは丸めるが、構造化データ側は全件残す (詳細パネルが使う)
    expect(issues[0]!.overlaps?.[0]?.files).toEqual(files);
  });

  it('skips a side whose ticket is unknown or belongs to another project', () => {
    const tickets = [
      makeTicket({ id: 'bdboard-a', projectId, status: 'in_progress' }),
      makeTicket({ id: 'bdboard-c', projectId: '/projects/other', status: 'in_progress' }),
    ];

    const issues = checkHygiene(tickets, {
      now: NOW,
      inFlightOverlaps: [
        overlap(['bdboard-a', 'bdboard-missing'], ['src/a.ts']),
        overlap(['bdboard-a', 'bdboard-c'], ['src/b.ts']),
      ],
    }).filter((issue) => issue.kind === 'in_flight_file_overlap');

    // bdboard-a は 2 件と重なるが行は 1 本。相手が居ない/別プロジェクトの側は出ない
    expect(
      issues.map((issue) => [
        issue.ticketId,
        issue.overlaps?.map((peer) => peer.otherTicketId),
      ]),
    ).toEqual([['bdboard-a', ['bdboard-c', 'bdboard-missing']]]);
  });

  it('folds several peers of one ticket into a single row', () => {
    const tickets = [
      makeTicket({ id: 'bdboard-a', projectId, status: 'in_progress' }),
      makeTicket({ id: 'bdboard-b', projectId, status: 'in_progress' }),
      makeTicket({ id: 'bdboard-c', projectId, status: 'in_progress' }),
    ];

    const issues = checkHygiene(tickets, {
      now: NOW,
      inFlightOverlaps: [
        overlap(['bdboard-a', 'bdboard-b'], ['src/a.ts', 'src/b.ts']),
        overlap(['bdboard-a', 'bdboard-c'], ['src/a.ts']),
      ],
    }).filter((issue) => issue.kind === 'in_flight_file_overlap');

    // 3 チケットで 2 ペア -> 行は 3 本 (a が 1 本にまとまる)。
    // 行キーが kind + ticketId で一意であることの担保でもある。
    expect(issues.map((issue) => issue.ticketId)).toEqual([
      'bdboard-a',
      'bdboard-b',
      'bdboard-c',
    ]);
    expect(issues[0]!.message).toBe(
      '着手中の 2 件と同じファイルを編集中: bdboard-b: src/a.ts, src/b.ts; bdboard-c: src/a.ts',
    );
    expect(issues[0]!.overlaps).toEqual([
      { otherTicketId: 'bdboard-b', files: ['src/a.ts', 'src/b.ts'] },
      { otherTicketId: 'bdboard-c', files: ['src/a.ts'] },
    ]);
  });

  it('emits nothing when inFlightOverlaps is omitted', () => {
    const tickets = [
      makeTicket({ id: 'bdboard-a', projectId, status: 'in_progress' }),
      makeTicket({ id: 'bdboard-b', projectId, status: 'in_progress' }),
    ];

    expect(
      checkHygiene(tickets, { now: NOW }).filter(
        (issue) => issue.kind === 'in_flight_file_overlap',
      ),
    ).toEqual([]);
  });

  it('sorts after every other kind', () => {
    const tickets = [
      makeTicket({ id: 'bdboard-a', projectId, status: 'in_progress' }),
      makeTicket({
        id: 'bdboard-b',
        projectId,
        status: 'in_progress',
      }),
    ];

    const kinds = checkHygiene(tickets, {
      now: NOW,
      inFlightOverlaps: [overlap(['bdboard-a', 'bdboard-b'], ['src/a.ts'])],
    }).map((issue) => issue.kind);

    expect(kinds.indexOf('in_flight_file_overlap')).toBeGreaterThan(
      kinds.indexOf('stale_in_progress'),
    );
  });
});
