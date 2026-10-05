/** bdboard-4y8q.6.3: self-error reporter の伏せ・間引き・失敗封じ込め。 */
import { describe, expect, it, vi } from 'vitest';
import { createSelfErrorReporter } from './self-error-reporter.js';
import { createSelfErrorThrottle } from '../../domain/self-error-throttle.js';
import type { RefreshErrorProject } from '../../domain/refresh-error-tracker.js';

const project: RefreshErrorProject = { id: 'p', name: 'example-project', rootPath: '/private/example-project', aliasPaths: [], prefixes: ['ex'] };
const result = (kind: string, detail: string, projectId = 'p') => ({ refreshed: [], removed: [], errors: [{ kind, detail, projectId }] });
const envInfo = { bdboardVersion: '1.2.3', os: 'darwin', nodeVersion: 'v22' };

function setup(receive = vi.fn().mockResolvedValue({ ok: true })) {
  let time = 0;
  const log = vi.fn();
  const reporter = createSelfErrorReporter({
    service: { receive }, throttle: createSelfErrorThrottle(), listProjects: () => [project], envInfo: () => envInfo,
    log, now: () => new Date(time),
  });
  return { reporter, receive, log, setTime: (value: number) => { time = value; } };
}

describe('createSelfErrorReporter', () => {
  it('sends tracker reports directly without a second throttle check', async () => {
    const base = createSelfErrorThrottle();
    const shouldReport = vi.spyOn(base, 'shouldReport');
    const receive = vi.fn().mockResolvedValue({ ok: true });
    const reporter = createSelfErrorReporter({ service: { receive }, throttle: base, listProjects: () => [project], envInfo: () => envInfo, log: vi.fn() });
    await reporter.observeRefresh(result('unknown', 'database "example-project" at /private/example-project'), [project]);
    expect(receive).toHaveBeenCalledTimes(1);
    expect(shouldReport).toHaveBeenCalledTimes(1);
    expect(receive.mock.calls[0]?.[0]).toMatchObject({ kind: 'C', source: 'bd-refresh:unknown', errorText: 'database "<project>" at <project-root>', project: { name: project.name, path: project.rootPath }, envInfo });
  });

  it('throttles repeats, waits for three transient sightings and ignores unknown projects', async () => {
    const { reporter, receive, setTime } = setup();
    for (let minute = 0; minute < 30; minute += 1) { setTime(minute * 60_000); await reporter.observeRefresh(result('unknown', 'failure'), [project]); }
    expect(receive).toHaveBeenCalledTimes(1);
    setTime(60 * 60_000); await reporter.observeRefresh(result('unknown', 'failure'), [project]);
    expect(receive).toHaveBeenCalledTimes(2);
    const lock = setup();
    await lock.reporter.observeRefresh(result('lock-contention', 'locked'), [project]);
    await lock.reporter.observeRefresh(result('lock-contention', 'locked'), [project]);
    expect(lock.receive).not.toHaveBeenCalled();
    await lock.reporter.observeRefresh(result('lock-contention', 'locked'), [project]);
    expect(lock.receive).toHaveBeenCalledTimes(1);
    await lock.reporter.observeRefresh(result('unknown', 'failure', 'missing'), [project]);
    expect(lock.receive).toHaveBeenCalledTimes(1);
  });

  it('masks report text and notes, and keeps source and normalized text in the key', async () => {
    const { reporter, receive } = setup();
    await reporter.report({ source: 'one', errorText: 'ex-abc1 failed at /private/example-project:3307', agentNote: 'example-project /private/example-project', project: { name: project.name, path: project.rootPath } });
    await reporter.report({ source: 'one', errorText: 'ex-def2 failed at /private/example-project:3308' });
    await reporter.report({ source: 'two', errorText: 'ex-xyz3 failed at /private/example-project:3309' });
    expect(receive).toHaveBeenCalledTimes(2);
    expect(receive.mock.calls[0]?.[0]).toMatchObject({ errorText: '<ticket-id> failed at <project-root>:3307', agentNote: '<project> <project-root>', project: { name: project.name, path: project.rootPath } });
  });

  it('logs fixed safe messages for failed, rejected and unsaved receives', async () => {
    const rejected = vi.fn().mockRejectedValue(Object.assign(new Error('/private/body secret'), { code: 'EACCES' }));
    const failed = setup(rejected);
    await expect(failed.reporter.report({ source: 'manual', errorText: 'failure' })).resolves.toBeUndefined();
    expect(failed.log).toHaveBeenCalledWith('self error draft failed (EACCES)');
    const unsaved = setup(vi.fn().mockResolvedValue({ ok: false, reason: 'storage-full' }));
    await unsaved.reporter.report({ source: 'manual', errorText: 'failure' });
    expect(unsaved.log).toHaveBeenCalledWith('self error draft not saved (storage-full)');
  });

  it('keeps later refreshes moving while a receive is pending', async () => {
    let release: ((value: { ok: true }) => void) | undefined;
    const receive = vi.fn().mockImplementation(() => new Promise<{ ok: true }>((resolve) => { release = resolve; }));
    const { reporter } = setup(receive);
    void reporter.observeRefresh(result('unknown', 'first'), [project]);
    void reporter.observeRefresh(result('schema-mismatch', 'second'), [project]);
    expect(receive).toHaveBeenCalledTimes(2);
    release?.({ ok: true });
  });
});
