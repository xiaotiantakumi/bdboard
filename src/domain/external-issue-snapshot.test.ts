import { describe, expect, it } from 'vitest';
import { truncateExternalIssue } from './external-issue-checks.js';
import { compareWithSnapshot, type ExternalIssueSnapshot } from './external-issue-snapshot.js';

const UPDATED_AT = '2026-10-05T12:00:00Z';

/** 生の題名・本文を切り詰めて、写し (または読み直した現在の値) の形にする。 */
function snapshotOf(title: string, body: string, updatedAt: string = UPDATED_AT): ExternalIssueSnapshot {
  return { ...truncateExternalIssue({ title, body }), updatedAt };
}

describe('compareWithSnapshot', () => {
  const snapshot = snapshotOf('crash on start', 'steps: run it');

  it('reports no change, and no rejudge, when nothing differs', () => {
    expect(compareWithSnapshot(snapshot, snapshotOf('crash on start', 'steps: run it'))).toEqual({
      titleChanged: false,
      bodyChanged: false,
      updatedAtChanged: false,
      needsRejudge: false,
    });
  });

  it('does not ask for a rejudge when only updatedAt differs (a comment or a label moves it)', () => {
    const result = compareWithSnapshot(snapshot, snapshotOf('crash on start', 'steps: run it', '2026-10-06T08:30:00Z'));
    expect(result).toEqual({ titleChanged: false, bodyChanged: false, updatedAtChanged: true, needsRejudge: false });
  });

  it('asks for a rejudge when the body changed', () => {
    const result = compareWithSnapshot(snapshot, snapshotOf('crash on start', 'steps: run it, then <!-- hidden -->'));
    expect(result).toEqual({ titleChanged: false, bodyChanged: true, updatedAtChanged: false, needsRejudge: true });
  });

  it('asks for a rejudge when the title changed', () => {
    const result = compareWithSnapshot(snapshot, snapshotOf('crash on start (updated)', 'steps: run it'));
    expect(result).toEqual({ titleChanged: true, bodyChanged: false, updatedAtChanged: false, needsRejudge: true });
  });

  it('reports every change when title, body and updatedAt all differ', () => {
    const result = compareWithSnapshot(snapshot, snapshotOf('another', 'another body', '2026-10-07T00:00:00Z'));
    expect(result).toEqual({ titleChanged: true, bodyChanged: true, updatedAtChanged: true, needsRejudge: true });
  });

  it('treats a change of one character (case, a zero width character) as a change', () => {
    expect(compareWithSnapshot(snapshot, snapshotOf('Crash on start', 'steps: run it')).titleChanged).toBe(true);
    expect(compareWithSnapshot(snapshot, snapshotOf('crash on start', `steps: run it${String.fromCodePoint(0x200b)}`)).bodyChanged).toBe(true);
  });

  it('is symmetric in what it reports about title and body', () => {
    const changed = snapshotOf('crash on start', 'other');
    expect(compareWithSnapshot(snapshot, changed).bodyChanged).toBe(true);
    expect(compareWithSnapshot(changed, snapshot).bodyChanged).toBe(true);
  });

  describe('a body longer than the limit (compared by the truncated body and the full length)', () => {
    const head = 'a'.repeat(20_000);
    const long = snapshotOf('t', `${head}${'b'.repeat(500)}`);

    it('is unchanged when the same long body is read again', () => {
      expect(compareWithSnapshot(long, snapshotOf('t', `${head}${'b'.repeat(500)}`)).bodyChanged).toBe(false);
    });

    it('catches an edit inside the kept part', () => {
      const edited = snapshotOf('t', `x${head.slice(1)}${'b'.repeat(500)}`);
      expect(compareWithSnapshot(long, edited)).toMatchObject({ bodyChanged: true, needsRejudge: true });
    });

    it('catches text added or removed after the cut, by the full length, though the truncated body is the same', () => {
      const longer = snapshotOf('t', `${head}${'b'.repeat(501)}`);
      expect(longer.body).toBe(long.body);
      expect(compareWithSnapshot(long, longer)).toMatchObject({ bodyChanged: true, needsRejudge: true });
      const shorter = snapshotOf('t', `${head}b`);
      expect(shorter.body).toBe(long.body);
      expect(compareWithSnapshot(long, shorter).bodyChanged).toBe(true);
    });

    it('does not catch a same-length rewrite after the cut (that part was never given to the judgement)', () => {
      const rewritten = snapshotOf('t', `${head}${'c'.repeat(500)}`);
      expect(compareWithSnapshot(long, rewritten)).toMatchObject({ bodyChanged: false, needsRejudge: false });
    });

    it('catches a body that was short at the time of the snapshot and is long now', () => {
      expect(compareWithSnapshot(snapshotOf('t', head), long).bodyChanged).toBe(true);
    });
  });

  it('catches a tail edit of a body that was cut upstream, by the full length that came with it', () => {
    const cutUpstream = (fullLength: number): ExternalIssueSnapshot => ({
      ...truncateExternalIssue({ title: 't', body: 'a'.repeat(20_001), bodyLength: fullLength }),
      updatedAt: UPDATED_AT,
    });
    expect(compareWithSnapshot(cutUpstream(25_000), cutUpstream(25_001))).toMatchObject({ bodyChanged: true, needsRejudge: true });
    expect(compareWithSnapshot(cutUpstream(25_000), cutUpstream(25_000)).bodyChanged).toBe(false);
  });

  it('catches a title edit after the title limit by the full length, as it does for the body', () => {
    const base = snapshotOf('t'.repeat(300), 'b');
    const longer = snapshotOf(`${'t'.repeat(300)}u`, 'b');
    expect(longer.title).toBe(base.title);
    expect(compareWithSnapshot(base, longer)).toMatchObject({ titleChanged: true, needsRejudge: true });
  });
});
