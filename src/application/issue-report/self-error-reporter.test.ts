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
    await reporter.observeRefresh(result('schema-mismatch', 'database "example-project" at /private/example-project'), [project]);
    expect(receive).toHaveBeenCalledTimes(1);
    expect(shouldReport).toHaveBeenCalledTimes(1);
    expect(receive.mock.calls[0]?.[0]).toMatchObject({ kind: 'C', source: 'bd-refresh:schema-mismatch', errorText: 'database "<project>" at <project-root>', project: { name: project.name, path: project.rootPath }, envInfo });
  });

  it('throttles repeats, waits for three transient sightings and ignores unknown projects', async () => {
    const { reporter, receive, setTime } = setup();
    for (let minute = 0; minute < 30; minute += 1) { setTime(minute * 60_000); await reporter.observeRefresh(result('schema-mismatch', 'failure'), [project]); }
    expect(receive).toHaveBeenCalledTimes(1);
    setTime(60 * 60_000); await reporter.observeRefresh(result('schema-mismatch', 'failure'), [project]);
    expect(receive).toHaveBeenCalledTimes(2);
    const lock = setup();
    await lock.reporter.observeRefresh(result('lock-contention', 'locked'), [project]);
    await lock.reporter.observeRefresh(result('lock-contention', 'locked'), [project]);
    expect(lock.receive).not.toHaveBeenCalled();
    await lock.reporter.observeRefresh(result('lock-contention', 'locked'), [project]);
    expect(lock.receive).toHaveBeenCalledTimes(1);
    await lock.reporter.observeRefresh(result('schema-mismatch', 'failure', 'missing'), [project]);
    expect(lock.receive).toHaveBeenCalledTimes(1);
  });

  it('masks report text and notes, and keeps source and normalized text in the key', async () => {
    const { reporter, receive } = setup();
    await reporter.report({ source: 'api:GET /one', errorText: 'ex-abc1 failed at /private/example-project:3307', agentNote: 'example-project /private/example-project', project: { name: project.name, path: project.rootPath } });
    await reporter.report({ source: 'api:GET /one', errorText: 'ex-def2 failed at /private/example-project:3308' });
    await reporter.report({ source: 'api:GET /two', errorText: 'ex-xyz3 failed at /private/example-project:3309' });
    expect(receive).toHaveBeenCalledTimes(2);
    expect(receive.mock.calls[0]?.[0]).toMatchObject({ errorText: '<ticket-id> failed at <project-root>:3307', agentNote: '<project> <project-root>', project: { name: project.name, path: project.rootPath } });
  });

  it('logs fixed safe messages for failed, rejected and unsaved receives', async () => {
    const rejected = vi.fn().mockRejectedValue(Object.assign(new Error('/private/body secret'), { code: 'EACCES' }));
    const failed = setup(rejected);
    await expect(failed.reporter.report({ source: 'api:GET /manual', errorText: 'failure' })).resolves.toBe('skipped');
    expect(failed.log).toHaveBeenCalledWith('self error draft failed (EACCES)');
    const unsaved = setup(vi.fn().mockResolvedValue({ ok: false, reason: 'storage-full' }));
    await unsaved.reporter.report({ source: 'api:GET /manual', errorText: 'failure' });
    expect(unsaved.log).toHaveBeenCalledWith('self error draft not saved (storage-full)');
  });

  it('keeps later refreshes moving while a receive is pending', async () => {
    const releases: Array<(value: { ok: true }) => void> = [];
    const receive = vi.fn().mockImplementation(() => new Promise<{ ok: true }>((resolve) => { releases.push(resolve); }));
    const { reporter } = setup(receive);
    const first = reporter.observeRefresh(result('schema-mismatch', 'first'), [project]);
    const second = reporter.observeRefresh(result('schema-mismatch', 'second'), [project]);
    // 1 本目の receive が終わっていなくても、2 本目は待たずに呼ばれる。
    expect(receive).toHaveBeenCalledTimes(2);
    for (const release of releases) release({ ok: true });
    await Promise.all([first, second]);
  });
});
