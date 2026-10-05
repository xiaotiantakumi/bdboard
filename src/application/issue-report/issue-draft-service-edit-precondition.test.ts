import { describe, expect, it } from 'vitest';
import { createIssueDraftService, type ReceiveDraftInput } from './issue-draft-service.js';
import { createInMemoryIssueDraftStorage } from './issue-draft-test-support.js';

/** bdboard-mqoa: IssueDraftService.edit の precondition (排他の中で今の下書きに確かめてから書く)。 */

const NOW = new Date('2026-10-04T12:00:00.000Z');
const REPORT: ReceiveDraftInput = {
  kind: 'A',
  catalogSlug: 'slug-a',
  envInfo: { bdboardVersion: '0.1.2', os: 'darwin', nodeVersion: 'v22.14.0' },
};

async function setup() {
  const storage = createInMemoryIssueDraftStorage();
  const service = createIssueDraftService({
    storage,
    now: () => NOW,
    newId: () => '1758812345001-0000000000000001',
    retention: { warn: () => undefined },
  });
  const received = await service.receive(REPORT);
  if (!received.ok) throw new Error('receive failed');
  return { service, storage, id: received.draft.id };
}

describe('IssueDraftService.edit precondition', () => {
  it('writes when the precondition holds, and hands it the draft as stored right now', async () => {
    const { service, storage, id } = await setup();
    const startTitle = storage.drafts.get(id)?.title;
    const seen: string[] = [];
    const result = await service.edit(id, { title: 'Edited' }, {
      precondition: async (current) => {
        seen.push(current.title);
        return true;
      },
    });
    expect(result.ok).toBe(true);
    expect(seen).toEqual([startTitle]);
    expect(startTitle).not.toBe('Edited');
    expect(storage.drafts.get(id)).toMatchObject({ title: 'Edited', titleEditedByUser: true });
  });

  it('writes nothing and says precondition-failed when it does not hold', async () => {
    const { service, storage, id } = await setup();
    const before = structuredClone(storage.drafts.get(id));
    expect(await service.edit(id, { title: 'Edited' }, { precondition: async () => false })).toEqual({
      ok: false,
      reason: 'precondition-failed',
    });
    expect(storage.drafts.get(id)).toEqual(before);
  });

  it('judges it after not-found and not-pending (it is never asked for a draft that cannot be edited)', async () => {
    const { service, id } = await setup();
    let asked = 0;
    const precondition = async () => {
      asked += 1;
      return false;
    };
    expect(await service.edit('1758812349999-ffffffffffffffff', { title: 'x' }, { precondition })).toEqual({ ok: false, reason: 'not-found' });
    expect((await service.dismiss(id, 'not a bug')).ok).toBe(true);
    expect(await service.edit(id, { title: 'x' }, { precondition })).toEqual({ ok: false, reason: 'not-pending', status: 'dismissed' });
    expect(asked).toBe(0);
  });

  it('asks it inside the write lock: of two edits judged against the same title, only the first is written', async () => {
    const { service, storage, id } = await setup();
    const startTitle = storage.drafts.get(id)?.title;
    const sameAsRead = async (current: { readonly title: string }) => current.title === startTitle;
    const [first, second] = await Promise.all([
      service.edit(id, { title: 'First' }, { precondition: sameAsRead }),
      service.edit(id, { title: 'Second' }, { precondition: sameAsRead }),
    ]);
    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, reason: 'precondition-failed' });
    expect(storage.drafts.get(id)?.title).toBe('First');
  });

  it('is optional: an edit without it behaves as before', async () => {
    const { service, storage, id } = await setup();
    expect((await service.edit(id, { title: 'No options' })).ok).toBe(true);
    expect((await service.edit(id, { title: 'Empty options' }, {})).ok).toBe(true);
    expect(storage.drafts.get(id)?.title).toBe('Empty options');
  });
});
