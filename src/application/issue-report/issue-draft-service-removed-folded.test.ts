import { describe, expect, it, vi } from 'vitest';
import { ISSUE_DRAFT_NEW_PER_HOUR } from '../../domain/issue-draft.js';
import { createIssueDraftService, type ReceiveDraftInput } from './issue-draft-service.js';
import { createInMemoryIssueDraftStorage } from './issue-draft-test-support.js';

/**
 * bdboard-ov0t (#892 の再レビュー N3 の任意): 手で消された下書きと同じ報告が、作り直しではなく畳み込み (folded) に回る経路でも、
 * 受け取りは消えた id を保存先から読み直さない。この経路では指紋を誰も上書きしないので、索引に指紋の行が残っていれば次の同じ報告が
 * 消えた id を storage.get する。索引から指紋を落とすのは forgetDrafts (状態だけを落とす実装では落ちる)。
 */

const START = new Date('2026-10-04T12:00:00.000Z');

function report(slug: string): ReceiveDraftInput {
  return { kind: 'A', catalogSlug: slug, symptom: 'symptom', envInfo: { bdboardVersion: '0.1.2', os: 'darwin', nodeVersion: 'v22.14.0' } };
}

describe('a draft removed by hand while its report is folded by the hourly limit', () => {
  it('does not read the removed id again on the next receive of the same report', async () => {
    let seq = 0;
    const storage = createInMemoryIssueDraftStorage(() => new Date(START));
    const service = createIssueDraftService({
      storage,
      now: () => new Date(START),
      newId: () => {
        seq += 1;
        return `${1758812345000 + seq}-${seq.toString(16).padStart(16, '0')}`;
      },
      retention: { warn: () => undefined },
    });
    const target = await service.receive(report('target'));
    if (!target.ok) throw new Error('receive failed');
    // 1 時間に作れる個別の下書きの数の上限まで作る (次の新しい報告は畳み込みに回る)。
    for (let i = 1; i < ISSUE_DRAFT_NEW_PER_HOUR; i += 1) {
      expect(await service.receive(report(`n${i}`))).toMatchObject({ ok: true, outcome: 'created' });
    }
    storage.drafts.delete(target.draft.id); // サーバーを通さずに手で消す
    expect(await service.receive(report('target'))).toMatchObject({ ok: true, outcome: 'folded' });

    const get = vi.spyOn(storage, 'get');
    expect(await service.receive(report('target'))).toMatchObject({ ok: true, outcome: 'folded' });
    expect(get).not.toHaveBeenCalledWith(target.draft.id);
  });
});
