import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import {
  buildHarnessBulkSummaryMessage,
  describeHarnessBulkFailure,
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

describe('describeHarnessBulkFailure', () => {
  it('appends the server detail to the error message', () => {
    expect(
      describeHarnessBulkFailure(
        new ApiError(500, 'injection failed', {
          errorMessage: 'injection failed',
          detail: 'disk full',
        }),
      ),
    ).toBe('injection failed: disk full');
  });

  it('uses the plain message when there is no detail', () => {
    expect(describeHarnessBulkFailure(new Error('boom'))).toBe('boom');
  });
});

describe('buildHarnessBulkSummaryMessage', () => {
  it('shows success and failure counts', () => {
    expect(
      buildHarnessBulkSummaryMessage({ results: [], successCount: 2, failureCount: 1 }),
    ).toBe('まとめて更新: 成功 2 件・失敗 1 件');
  });
});
