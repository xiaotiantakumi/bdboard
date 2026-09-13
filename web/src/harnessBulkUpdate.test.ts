import { describe, expect, it, vi } from 'vitest';
import {
  runHarnessBulkUpdate,
  type HarnessBulkUpdateTarget,
} from './harnessBulkUpdate';

describe('runHarnessBulkUpdate', () => {
  it('continues after a failure and retains the failed target and reason', async () => {
    const targets: HarnessBulkUpdateTarget[] = [
      { projectId: 'one', packName: 'pack', installedVersion: '0.1.0', availableVersion: '0.2.0' },
      { projectId: 'two', packName: 'pack', installedVersion: '0.1.0', availableVersion: '0.2.0' },
      { projectId: 'three', packName: 'pack', installedVersion: '0.1.0', availableVersion: '0.2.0' },
    ];
    const failure = new Error('two failed');
    const inject = vi.fn(async (target: HarnessBulkUpdateTarget) => {
      if (target.projectId === 'two') throw failure;
    });

    const summary = await runHarnessBulkUpdate(targets, inject);

    expect(inject.mock.calls.map(([target]) => target.projectId)).toEqual(['one', 'two', 'three']);
    expect(summary.successCount).toBe(2);
    expect(summary.failureCount).toBe(1);
    expect(summary.results[1]).toEqual({ target: targets[1], status: 'failure', error: failure });
  });
});
