import { describe, expect, it, vi } from 'vitest';
import {
  applyDraftPayloadStoreCarryPlan,
  applyTransformToAllDraftPayloadStores,
  defineDraftPayloadStoreCarryPlan,
  isEmptyList,
  isEmptyText,
  isNeverEmpty,
  migrateKeyInRecord,
  purgeKeysInRecord,
  referenceDraftPayloadStoreCarryPlan,
} from './conversationKeyspace';

describe('migrateKeyInRecord', () => {
  it('returns the same reference when from is absent', () => {
    const record = { 'new:proj-a:0': 'hello' };
    expect(migrateKeyInRecord(record, 'new:proj-a:1', 'new:proj-a:2', isEmptyText)).toBe(record);
  });

  it('drops from when the source is empty text without creating to', () => {
    const record = { 'new::0': '', 'new:proj-a:0': 'keep' };
    const next = migrateKeyInRecord(record, 'new::0', 'new:proj-a:1', isEmptyText);
    expect(next).toEqual({ 'new:proj-a:0': 'keep' });
    expect(next).not.toBe(record);
    expect(record).toEqual({ 'new::0': '', 'new:proj-a:0': 'keep' });
  });

  it('drops from without overwriting when to already has content', () => {
    const record = { 'new::0': 'draft', 'new:proj-a:1': 'existing' };
    const next = migrateKeyInRecord(record, 'new::0', 'new:proj-a:1', isEmptyText);
    expect(next).toEqual({ 'new:proj-a:1': 'existing' });
  });

  it('overwrites to when to is empty text', () => {
    const record = { 'new::0': 'draft', 'new:proj-a:1': '' };
    const next = migrateKeyInRecord(record, 'new::0', 'new:proj-a:1', isEmptyText);
    expect(next).toEqual({ 'new:proj-a:1': 'draft' });
  });

  it('migrates when to is undefined', () => {
    const record = { 'new::0': 'draft' };
    const next = migrateKeyInRecord(record, 'new::0', 'new:proj-a:1', isEmptyText);
    expect(next).toEqual({ 'new:proj-a:1': 'draft' });
  });

  it('migrates empty text when isNeverEmpty is used', () => {
    const record = { 'new::0': '' };
    const next = migrateKeyInRecord(record, 'new::0', 'new:proj-a:1', isNeverEmpty);
    expect(next).toEqual({ 'new:proj-a:1': '' });
    expect(migrateKeyInRecord(record, 'new::0', 'new:proj-a:1', isEmptyText)).toEqual({});
  });

  it('drops empty lists and migrates non-empty lists', () => {
    const emptyRecord = { 'new::0': [] as string[] };
    expect(migrateKeyInRecord(emptyRecord, 'new::0', 'new:proj-a:1', isEmptyList)).toEqual({});

    const filledRecord = { 'new::0': ['a'] };
    expect(migrateKeyInRecord(filledRecord, 'new::0', 'new:proj-a:1', isEmptyList)).toEqual({
      'new:proj-a:1': ['a'],
    });
  });

  it('does not mutate the original record', () => {
    const record = { 'new::0': 'draft', 'new:proj-a:1': 'existing' };
    const snapshot = { ...record, 'new::0': 'draft' };
    migrateKeyInRecord(record, 'new::0', 'new:proj-a:1', isEmptyText);
    expect(record).toEqual(snapshot);
  });
});

describe('purgeKeysInRecord', () => {
  it('returns the same reference when nothing matches', () => {
    const record = { 'new:proj-a:0': 'hello' };
    expect(purgeKeysInRecord(record, (key) => key.startsWith('new::'))).toBe(record);
  });

  it('removes all matching keys', () => {
    const record = {
      'new::0': 'a',
      'new::1': 'b',
      'new:proj-a:0': 'keep',
    };
    const next = purgeKeysInRecord(record, (key) => /^new::/.test(key));
    expect(next).toEqual({ 'new:proj-a:0': 'keep' });
  });

  it('does not mutate the original record', () => {
    const record = { 'new::0': 'a', 'new:proj-a:0': 'keep' };
    const snapshot = { ...record };
    purgeKeysInRecord(record, (key) => key.startsWith('new::'));
    expect(record).toEqual(snapshot);
  });
});

describe('defineDraftPayloadStoreCarryPlan (bdboard-ru4d)', () => {
  it('requires all draft payload store names in the carry plan', () => {
    const plan = defineDraftPayloadStoreCarryPlan({
      conversationInputs: { carry: true },
      conversationAttachments: { carry: false, reason: 'test' },
      attachmentErrors: { carry: false, reason: 'test' },
      threadModelIds: { carry: false, reason: 'test' },
      draftSeedText: { carry: false, reason: 'test' },
    });
    expect(plan.conversationInputs.carry).toBe(true);
    expect(plan.threadModelIds.carry).toBe(false);
  });

  it('applyDraftPayloadStoreCarryPlan runs only carry:true stores', () => {
    const plan = defineDraftPayloadStoreCarryPlan({
      conversationInputs: { carry: true },
      conversationAttachments: { carry: true },
      attachmentErrors: { carry: false, reason: 'skip' },
      threadModelIds: { carry: false, reason: 'skip' },
      draftSeedText: { carry: false, reason: 'skip' },
    });
    const conversationInputs = vi.fn();
    const conversationAttachments = vi.fn();
    applyDraftPayloadStoreCarryPlan(plan, {
      conversationInputs,
      conversationAttachments,
    });
    expect(conversationInputs).toHaveBeenCalledOnce();
    expect(conversationAttachments).toHaveBeenCalledOnce();
  });

  it('referenceDraftPayloadStoreCarryPlan preserves all-false plans', () => {
    const plan = defineDraftPayloadStoreCarryPlan({
      conversationInputs: { carry: false, reason: 'cleared on send' },
      conversationAttachments: { carry: false, reason: 'cleared on send' },
      attachmentErrors: { carry: false, reason: 'cleared on send' },
      threadModelIds: { carry: false, reason: 'cleared on send' },
      draftSeedText: { carry: false, reason: 'cleared on send' },
    });
    expect(referenceDraftPayloadStoreCarryPlan(plan)).toBe(plan);
  });

  it('applyTransformToAllDraftPayloadStores visits every store applicator', () => {
    const calls: string[] = [];
    applyTransformToAllDraftPayloadStores(
      {
        conversationInputs: () => {
          calls.push('conversationInputs');
        },
        conversationAttachments: () => {
          calls.push('conversationAttachments');
        },
        attachmentErrors: () => {
          calls.push('attachmentErrors');
        },
        threadModelIds: () => {
          calls.push('threadModelIds');
        },
        draftSeedText: () => {
          calls.push('draftSeedText');
        },
      },
      (record) => record,
    );
    expect(calls).toEqual([
      'conversationInputs',
      'conversationAttachments',
      'attachmentErrors',
      'threadModelIds',
      'draftSeedText',
    ]);
  });
});

/** compile-time checks: missing/extra apply fns must be tsc errors (bdboard-ru4d). */
function typecheckDraftPayloadStoreCarryPlanApplyFns() {
  const planMissingApply = defineDraftPayloadStoreCarryPlan({
    conversationInputs: { carry: true },
    conversationAttachments: { carry: true },
    attachmentErrors: { carry: false, reason: 'x' },
    threadModelIds: { carry: false, reason: 'x' },
    draftSeedText: { carry: false, reason: 'x' },
  });
  // @ts-expect-error conversationAttachments is carry:true but apply fn is missing
  applyDraftPayloadStoreCarryPlan(planMissingApply, { conversationInputs: () => {} });

  const planAllFalse = defineDraftPayloadStoreCarryPlan({
    conversationInputs: { carry: false, reason: 'x' },
    conversationAttachments: { carry: false, reason: 'x' },
    attachmentErrors: { carry: false, reason: 'x' },
    threadModelIds: { carry: false, reason: 'x' },
    draftSeedText: { carry: false, reason: 'x' },
  });
  // @ts-expect-error carry:false stores must not receive apply fns
  applyDraftPayloadStoreCarryPlan(planAllFalse, { conversationInputs: () => {} });
}
void typecheckDraftPayloadStoreCarryPlanApplyFns;
