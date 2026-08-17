import { describe, expect, it } from 'vitest';
import type { AgentRunner, RunOutcome, RunRequest } from '../ports/agent-runner.js';
import { createAgentRunnerRegistry } from './runner-registry.js';

function makeRequest(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    ticketId: 'bd-1',
    projectId: 'proj-1',
    cwd: '/tmp/project',
    mode: 'spawn',
    ...overrides,
  };
}

function fakeRunner(
  id: string,
  options: {
    readonly experimental?: boolean;
    readonly supports?: boolean;
  } = {},
): AgentRunner {
  const { experimental = false, supports = true } = options;
  return {
    id,
    experimental,
    supports: () => supports,
    dispatch: async (): Promise<RunOutcome> => ({
      ok: false,
      failureKind: 'failed',
      run: {
        id: `${id}-run`,
        ticketId: 'bd-1',
        runner: id,
        mode: 'spawn',
        status: 'failed',
        startedAt: new Date(0),
      },
    }),
  };
}

describe('createAgentRunnerRegistry', () => {
  it('returns empty arrays when no runners are registered', () => {
    const registry = createAgentRunnerRegistry();
    expect(registry.resolve(makeRequest())).toEqual([]);
    expect(registry.list()).toEqual([]);
  });

  it('places experimental runners after non-experimental ones', () => {
    const registry = createAgentRunnerRegistry();
    const stable = fakeRunner('stable', { experimental: false });
    const experimental = fakeRunner('experimental', { experimental: true });

    registry.register(experimental);
    registry.register(stable);

    const resolved = registry.resolve(makeRequest());
    expect(resolved.map((r) => r.id)).toEqual(['stable', 'experimental']);
    expect(registry.list().map((r) => r.id)).toEqual(['stable', 'experimental']);
  });

  it('keeps experimental runners last even when registered later', () => {
    const registry = createAgentRunnerRegistry();
    registry.register(fakeRunner('exp-a', { experimental: true }));
    registry.register(fakeRunner('stable-b', { experimental: false }));

    expect(registry.resolve(makeRequest()).map((r) => r.id)).toEqual([
      'stable-b',
      'exp-a',
    ]);
  });

  it('excludes runners that do not support the request from resolve', () => {
    const registry = createAgentRunnerRegistry();
    const supported = fakeRunner('supported', { supports: true });
    const unsupported = fakeRunner('unsupported', { supports: false });

    registry.register(supported);
    registry.register(unsupported);

    expect(registry.resolve(makeRequest()).map((r) => r.id)).toEqual([
      'supported',
    ]);
    expect(registry.list().map((r) => r.id)).toEqual(['supported', 'unsupported']);
  });

  it('sorts within the same category by id ascending', () => {
    const registry = createAgentRunnerRegistry();
    registry.register(fakeRunner('z-runner'));
    registry.register(fakeRunner('a-runner'));
    registry.register(fakeRunner('m-runner'));

    expect(registry.list().map((r) => r.id)).toEqual([
      'a-runner',
      'm-runner',
      'z-runner',
    ]);
  });

  it('replaces a runner when the same id is registered again', () => {
    const registry = createAgentRunnerRegistry();
    const first = fakeRunner('same-id');
    const second = fakeRunner('same-id');

    registry.register(first);
    registry.register(second);

    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0]).toBe(second);
    expect(registry.resolve(makeRequest())[0]).toBe(second);
  });

  it('returns a new array on each call', () => {
    const registry = createAgentRunnerRegistry();
    registry.register(fakeRunner('a'));

    const first = registry.list();
    const second = registry.list();
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });
});
