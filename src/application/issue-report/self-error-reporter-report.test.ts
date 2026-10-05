/**
 * bdboard-4y8q.6.4: report() (リフレッシュ以外の呼び出し。API の 5xx など) を初めて使うための手当て。
 * (1) source を閉じた語彙で検査する / (2) 伏せるときの一覧に discovery の一覧を足す / (3) 間引きの共有で何が抑えられ、何が残るか。
 */
import { describe, expect, it, vi } from 'vitest';
import { createSelfErrorReporter } from './self-error-reporter.js';
import type { SelfErrorReporterDeps, SelfErrorReportInput } from './self-error-reporter.js';
import { createSelfErrorThrottle } from '../../domain/self-error-throttle.js';
import type { RefreshErrorProject } from '../../domain/refresh-error-tracker.js';

const cached: RefreshErrorProject = { id: 'cached', name: 'cached-project', rootPath: '/private/cached-project', aliasPaths: [], prefixes: ['cp'] };
/** discovery には居るが、一度もキャッシュに載らない (bd を開けず失敗し続ける) プロジェクト。discovery の Project は prefixes が常に []。 */
const uncached: RefreshErrorProject = { id: 'uncached', name: 'uncached-project', rootPath: '/private/uncached-project', aliasPaths: [], prefixes: [] };
const envInfo = { bdboardVersion: '1.2.3', os: 'darwin', nodeVersion: 'v22' };
const refresh = (projectId: string, detail = 'failed') => ({ refreshed: [], removed: [], errors: [{ kind: 'unknown', projectId, detail }] });

function setup(overrides: Partial<SelfErrorReporterDeps> = {}) {
  const receive = vi.fn().mockResolvedValue({ ok: true });
  const log = vi.fn<(message: string) => void>();
  const throttle = createSelfErrorThrottle();
  let time = 0;
  const reporter = createSelfErrorReporter({
    service: { receive }, throttle, listProjects: () => [cached], envInfo: () => envInfo, log, now: () => new Date(time),
    ...overrides,
  });
  return { reporter, receive, log, throttle, setTime: (value: number) => { time = value; } };
}

describe('report(): source is a closed vocabulary', () => {
  it('sends an api source and answers recorded', async () => {
    const { reporter, receive } = setup();
    await expect(reporter.report({ source: 'api:GET /api/tickets/:id', errorText: 'failed' })).resolves.toBe('recorded');
    expect(receive).toHaveBeenCalledTimes(1);
    expect(receive.mock.calls[0]?.[0]).toMatchObject({ kind: 'C', source: 'api:GET /api/tickets/:id', errorText: 'failed', envInfo });
  });

  it.each([
    'manual',
    '',
    'api:GET /api/tickets/bdboard-xyz9 secret',
    'api:GET /private/cached-project\nHTTP 500',
    'bd-refresh:unknown',
    `api:GET /${'a'.repeat(300)}`,
  ])('drops source %j before masking, throttling or receiving (fixed log line, the source is not logged)', async (source) => {
    const { reporter, receive, log, throttle } = setup();
    const shouldReport = vi.spyOn(throttle, 'shouldReport');
    // 型は api:… に絞ってあるが、実行時には動的な文字列が来うる。
    await expect(reporter.report({ source, errorText: 'failed' } as unknown as SelfErrorReportInput)).resolves.toBe('skipped');
    expect(receive).not.toHaveBeenCalled();
    expect(shouldReport).not.toHaveBeenCalled();
    expect(log.mock.calls).toEqual([['self error draft rejected (invalid source)']]);
  });

  it('answers throttled for a repeat inside the hour and recorded again after it', async () => {
    const { reporter, receive, setTime } = setup();
    const input = { source: 'api:GET /api/board', errorText: 'failed' } as const;
    await expect(reporter.report(input)).resolves.toBe('recorded');
    setTime(59 * 60_000);
    await expect(reporter.report(input)).resolves.toBe('throttled');
    setTime(60 * 60_000);
    await expect(reporter.report(input)).resolves.toBe('recorded');
    expect(receive).toHaveBeenCalledTimes(2);
  });

  it('answers skipped when the draft could not be saved', async () => {
    const { reporter } = setup({ service: { receive: vi.fn().mockResolvedValue({ ok: false, reason: 'storage-full' }) } });
    await expect(reporter.report({ source: 'api:GET /api/board', errorText: 'failed' })).resolves.toBe('skipped');
  });
});

describe('report(): the mask list is the cache list plus the discovery list seen by observeRefresh', () => {
  const text = 'cannot open /private/uncached-project: uncached-project is locked, cached-project too';

  it('masks the name and path of a project that never reached the cache, once a refresh has reported the discovery list', async () => {
    const { reporter, receive } = setup();
    await reporter.observeRefresh(refresh('uncached'), [cached, uncached]);
    await reporter.report({ source: 'api:GET /api/board', errorText: text, agentNote: 'uncached-project' });
    expect(receive.mock.calls.at(-1)?.[0]).toMatchObject({
      errorText: 'cannot open <project-root>: <project> is locked, <project> too',
      agentNote: '<project>',
    });
  });

  it('cannot mask a project it has never been told about (the reason the discovery list is added)', async () => {
    const { reporter, receive } = setup();
    await reporter.report({ source: 'api:GET /api/board', errorText: text });
    expect(receive.mock.calls[0]?.[0].errorText).toBe('cannot open /private/uncached-project: uncached-project is locked, <project> too');
  });

  it('keeps the cached prefix of a discovery project (discovery prefixes are empty, the cache has them)', async () => {
    const withPrefix: RefreshErrorProject = { ...cached, prefixes: ['cp'] };
    const { reporter, receive } = setup({ listProjects: () => [withPrefix] });
    // refresh with no errors: the observer passes discovery projects with prefixes [] in that case.
    await reporter.observeRefresh({ refreshed: [], removed: [], errors: [] }, [{ ...withPrefix, prefixes: [] }]);
    await reporter.report({ source: 'api:GET /api/board', errorText: 'ticket cp-abc1 failed' });
    expect(receive.mock.calls[0]?.[0].errorText).toBe('ticket <ticket-id> failed');
  });

  it('follows the latest discovery list: a project removed from discovery and the cache is no longer masked', async () => {
    const { reporter, receive } = setup({ listProjects: () => [] });
    await reporter.observeRefresh(refresh('uncached'), [uncached]);
    await reporter.observeRefresh(refresh('uncached'), []);
    await reporter.report({ source: 'api:GET /api/board', errorText: 'uncached-project failed' });
    expect(receive.mock.calls.at(-1)?.[0].errorText).toBe('uncached-project failed');
  });
});

describe('report() shares the throttle with the refresh tracker (6.4 review point 3)', () => {
  it('records both kinds of key in the one throttle, and one noisy key does not use the other one up', async () => {
    const { reporter, receive, throttle } = setup();
    // 1 回で報告される種類 (schema-mismatch) を使う。ほかの種類は連続 3 回で報告する (bdboard-f2ob)。
    const shapeError = { refreshed: [], removed: [], errors: [{ kind: 'schema-mismatch', projectId: 'cached', detail: 'bd failed' }] };
    await reporter.observeRefresh(shapeError, [cached]);
    await reporter.report({ source: 'api:GET /api/board', errorText: 'bd failed' });
    expect(throttle.size()).toBe(2);
    for (let round = 0; round < 50; round += 1) await reporter.report({ source: 'api:GET /api/board', errorText: 'bd failed' });
    expect(receive).toHaveBeenCalledTimes(2);
  });

  it('does not collapse different texts: unmasked database names of projects the list does not know stay separate keys (known limitation)', async () => {
    const { reporter, receive } = setup();
    // 一度もキャッシュに載らないプロジェクトの Dolt のデータベース名 (接頭辞から作られる) は伏せられない。名前が違えば別のキーで、共有の throttle は束ねない。
    for (const database of ['epic_alpha_001', 'epic_beta_002', 'epic_gamma_003']) {
      await reporter.report({ source: 'api:GET /api/board', errorText: `database "${database}" not found on dolt server` });
    }
    expect(receive.mock.calls.map(([input]) => input.errorText)).toEqual([
      'database "epic_alpha_001" not found on dolt server',
      'database "epic_beta_002" not found on dolt server',
      'database "epic_gamma_003" not found on dolt server',
    ]);
  });
});
