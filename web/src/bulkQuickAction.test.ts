import { describe, expect, it, vi } from 'vitest';
import {
  type BulkQuickActionTarget,
  runBulkQuickAction,
} from './bulkQuickAction';

describe('runBulkQuickAction', () => {
  it('collects succeeded and failed outcomes separately', async () => {
    const execute = vi.fn(async (id: string) => {
      if (id === 'fail-1') {
        throw new Error('boom');
      }
    });

    const targets: BulkQuickActionTarget[] = [
      { id: 'ok-1', request: { action: 'close' } },
      { id: 'fail-1', request: { action: 'close' } },
      { id: 'ok-2', request: { action: 'close' } },
    ];

    const outcome = await runBulkQuickAction(targets, execute);

    expect(outcome.succeeded.map((t) => t.id)).toEqual(['ok-1', 'ok-2']);
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]?.id).toBe('fail-1');
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('continues executing after a failure', async () => {
    const order: string[] = [];
    const execute = vi.fn(async (id: string) => {
      order.push(id);
      if (id === 'fail-first') {
        throw new Error('first failed');
      }
    });

    const targets: BulkQuickActionTarget[] = [
      { id: 'fail-first', request: { action: 'close' } },
      { id: 'after-fail', request: { action: 'close' } },
    ];

    await runBulkQuickAction(targets, execute);

    expect(order).toEqual(['fail-first', 'after-fail']);
  });
});
