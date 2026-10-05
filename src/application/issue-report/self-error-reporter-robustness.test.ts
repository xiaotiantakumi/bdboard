/**
 * bdboard-4y8q.6.3 (review): the reporter never throws back into the refresh loop and never logs anything but a safe code.
 * Covers the cases the first version left untested: a receive that throws synchronously, envInfo / listProjects / throttle
 * that throw, and error codes that are not safe to log.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSelfErrorReporter, type SelfErrorReporterDeps } from './self-error-reporter.js';
import { createSelfErrorThrottle } from '../../domain/self-error-throttle.js';
import type { RefreshErrorProject } from '../../domain/refresh-error-tracker.js';

const project: RefreshErrorProject = {
  id: 'p',
  name: 'example-project',
  rootPath: '/private/example-project',
  aliasPaths: [],
  prefixes: ['ex'],
};
const failure = (detail = 'failed at /private/example-project') => ({
  refreshed: [],
  removed: [],
  errors: [{ kind: 'unknown', projectId: 'p', detail }],
});

function setup(overrides: Partial<SelfErrorReporterDeps> = {}) {
  const log = vi.fn<(message: string) => void>();
  const reporter = createSelfErrorReporter({
    service: { receive: vi.fn().mockResolvedValue({ ok: true }) },
    throttle: createSelfErrorThrottle(),
    listProjects: () => [project],
    envInfo: () => ({ bdboardVersion: '1.2.3', os: 'darwin', nodeVersion: 'v22' }),
    log,
    now: () => new Date(0),
    ...overrides,
  });
  return { reporter, log };
}

function expectSafe(lines: readonly string[]): void {
  for (const line of lines) {
    expect(line).not.toContain('/private');
    expect(line).not.toContain('example-project');
    expect(line).not.toContain('secret');
  }
}

describe('createSelfErrorReporter robustness', () => {
  it('contains a receive that throws synchronously (observeRefresh and report)', async () => {
    const receive = vi.fn(() => {
      throw Object.assign(new Error('/private/example-project secret'), { code: 'EPERM' });
    });
    const { reporter, log } = setup({ service: { receive } });
    await expect(reporter.observeRefresh(failure(), [project])).resolves.toBeUndefined();
    await expect(reporter.report({ source: 'manual', errorText: 'x' })).resolves.toBeUndefined();
    expect(receive).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      'self error draft failed (EPERM)',
      'self error draft failed (EPERM)',
    ]);
  });

  it('contains envInfo, listProjects and throttle failures without calling receive with partial data', async () => {
    const boom = () => {
      throw Object.assign(new Error('/private/example-project secret'), { code: 'EBOOM' });
    };
    const receive = vi.fn().mockResolvedValue({ ok: true });

    const env = setup({ service: { receive }, envInfo: boom });
    await expect(env.reporter.observeRefresh(failure(), [project])).resolves.toBeUndefined();
    await expect(env.reporter.report({ source: 'manual', errorText: 'x' })).resolves.toBeUndefined();

    const list = setup({ service: { receive }, listProjects: boom });
    await expect(list.reporter.report({ source: 'manual', errorText: 'x' })).resolves.toBeUndefined();

    const throttle = createSelfErrorThrottle();
    vi.spyOn(throttle, 'shouldReport').mockImplementation(boom);
    const thr = setup({ service: { receive }, throttle });
    await expect(thr.reporter.observeRefresh(failure(), [project])).resolves.toBeUndefined();
    await expect(thr.reporter.report({ source: 'manual', errorText: 'x' })).resolves.toBeUndefined();

    expect(receive).not.toHaveBeenCalled();
    const lines = [env, list, thr].flatMap(({ log }) => log.mock.calls.map(([line]) => line));
    expect(lines).toEqual(Array.from({ length: 5 }, () => 'self error draft failed (EBOOM)'));
    expectSafe(lines);
  });

  it.each([
    ['a path', '/private/example-project'],
    ['a number', 13],
    ['spaces', 'E IO'],
    ['too long', 'E'.repeat(41)],
    ['a message-like code', 'secret: example-project'],
    ['undefined', undefined],
  ])('logs "unknown" for an unsafe code (%s)', async (_label, code) => {
    const error = code === undefined ? new Error('/private/example-project secret') : Object.assign(new Error('x'), { code });
    const { reporter, log } = setup({ service: { receive: vi.fn().mockRejectedValue(error) } });
    await reporter.observeRefresh(failure(), [project]);
    expect(log.mock.calls.map(([line]) => line)).toEqual(['self error draft failed (unknown)']);
  });

  it('contains non-Error rejections (null, string)', async () => {
    for (const reason of [null, '/private/example-project secret']) {
      const { reporter, log } = setup({ service: { receive: vi.fn().mockRejectedValue(reason) } });
      await expect(reporter.observeRefresh(failure(), [project])).resolves.toBeUndefined();
      expect(log.mock.calls.map(([line]) => line)).toEqual(['self error draft failed (unknown)']);
    }
  });
});
