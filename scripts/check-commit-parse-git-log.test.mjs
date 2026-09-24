import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(() => 'mocked git output'),
}));

import { git } from './check-commit-parse/git-log.mjs';

afterEach(() => {
  vi.clearAllMocks();
});

describe('git', () => {
  it('allows git log output larger than the default child-process buffer', () => {
    git(['log', '--format=%H%x1f%B%x1e', 'v0.1.2..HEAD'], '/repo');

    const [, , options] = vi.mocked(execFileSync).mock.calls[0];
    expect(options.maxBuffer).toBeGreaterThan(1024 * 1024);
  });
});
