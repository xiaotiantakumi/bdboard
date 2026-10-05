/**
 * bdboard-4y8q.6.10: 保存 (receive) に失敗した報告は throttle に残さない。
 *
 * 以前は、throttle に記録してから receive を呼んでいた。receive が失敗しても同じキーは 1 時間 `throttled` を返し、下書きは 1 件もできず、
 * X-Bdboard-Error-Draft の `throttled` (= 報告済み) を画面が信じてしまう。ここでは次を固定する:
 * (1) 失敗した報告のキーは、次の report() / observeRefresh で再び receive に届く。
 * (2) 同じキーが保存の終わらないうちにもう一度来たら、二重の下書きにせず、1 回目の結果を待つ (成功なら throttled、失敗なら skipped)。
 */
import { describe, expect, it, vi } from 'vitest';
import { createSelfErrorReporter } from './self-error-reporter.js';
import type { SelfErrorReporterDeps } from './self-error-reporter.js';
import { createSelfErrorThrottle } from '../../domain/self-error-throttle.js';
import type { RefreshErrorProject } from '../../domain/refresh-error-tracker.js';

const project: RefreshErrorProject = { id: 'p', name: 'example-project', rootPath: '/private/example-project', aliasPaths: [], prefixes: ['ex'] };
const envInfo = { bdboardVersion: '1.2.3', os: 'darwin', nodeVersion: 'v22' };
const input = { source: 'api:GET /api/board', errorText: 'bd failed' } as const;
const refresh = (kind: string, detail: string) => ({ refreshed: [], removed: [], errors: [{ kind, projectId: 'p', detail }] });
const unsaved = { ok: false, reason: 'storage-full' } as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** マイクロタスクを一通り流す (待ちのループではなく、「まだ終わっていない」ことを確かめるための 1 回)。 */
function flush(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve); });
}

function setup(receive = vi.fn().mockResolvedValue({ ok: true }), overrides: Partial<SelfErrorReporterDeps> = {}) {
  const log = vi.fn<(message: string) => void>();
  const throttle = createSelfErrorThrottle();
  let time = 0;
  const reporter = createSelfErrorReporter({
    service: { receive }, throttle, listProjects: () => [project], envInfo: () => envInfo, log, now: () => new Date(time),
    ...overrides,
  });
  return { reporter, receive, log, throttle, setTime: (value: number) => { time = value; } };
}

describe('report(): a save that failed leaves no throttle record', () => {
  const failures: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
    ['resolves { ok: false }', () => Promise.resolve(unsaved)],
    ['rejects', () => Promise.reject(Object.assign(new Error('disk'), { code: 'EIO' }))],
    ['throws synchronously', () => { throw Object.assign(new Error('disk'), { code: 'EIO' }); }],
  ];

  it.each(failures)('reaches receive again on the next report() when receive %s (same instant, no wait for the hour)', async (_label, fail) => {
    const receive = vi.fn().mockImplementationOnce(fail).mockResolvedValue({ ok: true });
    const { reporter, throttle } = setup(receive);
    await expect(reporter.report(input)).resolves.toBe('skipped');
    expect(throttle.size()).toBe(0);
    await expect(reporter.report(input)).resolves.toBe('recorded');
    expect(receive).toHaveBeenCalledTimes(2);
    // 保存できたあとは今までどおり間引く。
    expect(throttle.size()).toBe(1);
    await expect(reporter.report(input)).resolves.toBe('throttled');
    expect(receive).toHaveBeenCalledTimes(2);
  });

  it('retries on every report() while the save keeps failing, logging one fixed line per attempt, and settles on the first success', async () => {
    const receive = vi.fn().mockResolvedValueOnce(unsaved).mockResolvedValueOnce(unsaved).mockResolvedValueOnce(unsaved).mockResolvedValue({ ok: true });
    const { reporter, log } = setup(receive);
    for (let attempt = 0; attempt < 3; attempt += 1) await expect(reporter.report(input)).resolves.toBe('skipped');
    expect(log.mock.calls.map(([line]) => line)).toEqual(Array.from({ length: 3 }, () => 'self error draft not saved (storage-full)'));
    await expect(reporter.report(input)).resolves.toBe('recorded');
    await expect(reporter.report(input)).resolves.toBe('throttled');
    expect(receive).toHaveBeenCalledTimes(4);
  });

  it('sends the same masked text again on the retry', async () => {
    const receive = vi.fn().mockResolvedValueOnce(unsaved).mockResolvedValue({ ok: true });
    const { reporter } = setup(receive);
    const failing = { source: 'api:GET /api/board', errorText: 'cannot open /private/example-project' } as const;
    await reporter.report(failing);
    await reporter.report(failing);
    expect(receive.mock.calls.map(([call]) => (call as { readonly errorText: string }).errorText)).toEqual(['cannot open <project-root>', 'cannot open <project-root>']);
  });

  it('forgets only the key that failed: another key already recorded stays throttled', async () => {
    const receive = vi.fn().mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce(unsaved).mockResolvedValue({ ok: true });
    const { reporter } = setup(receive);
    const other = { source: 'api:GET /api/other', errorText: 'other failed' } as const;
    await expect(reporter.report(other)).resolves.toBe('recorded');
    await expect(reporter.report(input)).resolves.toBe('skipped');
    await expect(reporter.report(other)).resolves.toBe('throttled');
    expect(receive).toHaveBeenCalledTimes(2);
  });

  it('a failed retry does not shorten the hour of a key that was recorded before: it is reported again an hour after its last success', async () => {
    const receive = vi.fn().mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce(unsaved).mockResolvedValue({ ok: true });
    const { reporter, setTime } = setup(receive);
    await expect(reporter.report(input)).resolves.toBe('recorded');
    setTime(60 * 60_000);
    await expect(reporter.report(input)).resolves.toBe('skipped');
    await expect(reporter.report(input)).resolves.toBe('recorded');
    setTime(60 * 60_000 + 59 * 60_000);
    await expect(reporter.report(input)).resolves.toBe('throttled');
    expect(receive).toHaveBeenCalledTimes(3);
  });
});

describe('report(): the same key arriving while its save is still pending', () => {
  it('waits for the first save: no second draft, and throttled once the first one is recorded', async () => {
    const gate = deferred<{ ok: true }>();
    const { reporter, receive } = setup(vi.fn().mockReturnValue(gate.promise));
    const first = reporter.report(input);
    const second = reporter.report(input);
    let secondSettled = false;
    void second.then(() => { secondSettled = true; });
    await flush();
    expect(receive).toHaveBeenCalledTimes(1);
    // 1 回目の結果が出るまで、2 回目は何も答えない (保存に失敗したかもしれないので、throttled とはまだ言えない)。
    expect(secondSettled).toBe(false);
    gate.resolve({ ok: true });
    await expect(first).resolves.toBe('recorded');
    await expect(second).resolves.toBe('throttled');
    expect(receive).toHaveBeenCalledTimes(1);
  });

  it('answers skipped to the second call when the first save failed, without a second receive, and the next report() reaches receive again', async () => {
    const gate = deferred<typeof unsaved>();
    const receive = vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValue({ ok: true });
    const { reporter, log } = setup(receive);
    const first = reporter.report(input);
    const second = reporter.report(input);
    const third = reporter.report(input);
    gate.resolve(unsaved);
    await expect(first).resolves.toBe('skipped');
    await expect(second).resolves.toBe('skipped');
    await expect(third).resolves.toBe('skipped');
    // 同時に来た 3 回分で保存を試みるのは 1 回だけ (失敗のたびに全員が再試行して押しつぶさない)。ログも 1 行。
    expect(receive).toHaveBeenCalledTimes(1);
    expect(log.mock.calls).toEqual([['self error draft not saved (storage-full)']]);
    await expect(reporter.report(input)).resolves.toBe('recorded');
    expect(receive).toHaveBeenCalledTimes(2);
  });

  it('answers skipped to the second call when the first receive rejects', async () => {
    const gate = deferred<never>();
    const receive = vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValue({ ok: true });
    const { reporter } = setup(receive);
    const first = reporter.report(input);
    const second = reporter.report(input);
    gate.reject(Object.assign(new Error('disk'), { code: 'EIO' }));
    await expect(first).resolves.toBe('skipped');
    await expect(second).resolves.toBe('skipped');
    await expect(reporter.report(input)).resolves.toBe('recorded');
    expect(receive).toHaveBeenCalledTimes(2);
  });

  it('folds three concurrent calls into one receive and throttles the ones after the save as well', async () => {
    const gate = deferred<{ ok: true }>();
    const { reporter, receive } = setup(vi.fn().mockReturnValue(gate.promise));
    const calls = [reporter.report(input), reporter.report(input), reporter.report(input)];
    gate.resolve({ ok: true });
    await expect(Promise.all(calls)).resolves.toEqual(['recorded', 'throttled', 'throttled']);
    await expect(reporter.report(input)).resolves.toBe('throttled');
    expect(receive).toHaveBeenCalledTimes(1);
  });

  it('treats texts that normalize to the same key as the same key (numbers such as a port differ)', async () => {
    const gate = deferred<{ ok: true }>();
    const { reporter, receive } = setup(vi.fn().mockReturnValue(gate.promise));
    const first = reporter.report({ source: 'api:GET /api/board', errorText: 'dolt server unreachable at 127.0.0.1:60995' });
    const second = reporter.report({ source: 'api:GET /api/board', errorText: 'dolt server unreachable at 127.0.0.1:61292' });
    gate.resolve({ ok: true });
    await expect(Promise.all([first, second])).resolves.toEqual(['recorded', 'throttled']);
    expect(receive).toHaveBeenCalledTimes(1);
  });

  it('does not make different keys wait for each other', async () => {
    const gates = [deferred<{ ok: true }>(), deferred<{ ok: true }>()];
    const receive = vi.fn().mockReturnValueOnce(gates[0]?.promise).mockReturnValueOnce(gates[1]?.promise);
    const { reporter } = setup(receive);
    const a = reporter.report({ source: 'api:GET /api/a', errorText: 'failed' });
    const b = reporter.report({ source: 'api:GET /api/b', errorText: 'failed' });
    expect(receive).toHaveBeenCalledTimes(2);
    gates[1]?.resolve({ ok: true });
    await expect(b).resolves.toBe('recorded');
    gates[0]?.resolve({ ok: true });
    await expect(a).resolves.toBe('recorded');
  });

  it('a failure of the first key does not touch a different key that is still pending or already recorded', async () => {
    const gate = deferred<typeof unsaved>();
    const receive = vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValue({ ok: true });
    const { reporter } = setup(receive);
    const failing = reporter.report({ source: 'api:GET /api/a', errorText: 'failed' });
    await expect(reporter.report({ source: 'api:GET /api/b', errorText: 'failed' })).resolves.toBe('recorded');
    gate.resolve(unsaved);
    await expect(failing).resolves.toBe('skipped');
    await expect(reporter.report({ source: 'api:GET /api/b', errorText: 'failed' })).resolves.toBe('throttled');
  });
});

describe('observeRefresh(): a save that failed leaves no throttle record either', () => {
  // 'schema-mismatch' は 1 回見えただけで報告される種類 (4y8q.6.2 / 4y8q.f2ob のどちらの規則でも)。
  const failure = refresh('schema-mismatch', 'database "example-project" at /private/example-project');

  it('reaches receive again on the next refresh when the save failed, and throttles after the first success', async () => {
    const receive = vi.fn().mockResolvedValueOnce(unsaved).mockRejectedValueOnce(Object.assign(new Error('disk'), { code: 'EIO' })).mockResolvedValue({ ok: true });
    const { reporter, throttle } = setup(receive);
    await reporter.observeRefresh(failure, [project]);
    expect(throttle.size()).toBe(0);
    await reporter.observeRefresh(failure, [project]);
    expect(throttle.size()).toBe(0);
    await reporter.observeRefresh(failure, [project]);
    expect(receive).toHaveBeenCalledTimes(3);
    expect(throttle.size()).toBe(1);
    await reporter.observeRefresh(failure, [project]);
    await reporter.observeRefresh(failure, [project]);
    expect(receive).toHaveBeenCalledTimes(3);
    // 送る文は毎回同じ (伏せたもの)。
    expect(receive.mock.calls.map(([call]) => (call as { readonly errorText: string }).errorText)).toEqual(Array.from({ length: 3 }, () => 'database "<project>" at <project-root>'));
  });

  it('keeps the record of an earlier success: a later failed save of another key does not reopen it', async () => {
    const receive = vi.fn().mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce(unsaved).mockResolvedValue({ ok: true });
    const { reporter } = setup(receive);
    await reporter.observeRefresh(refresh('schema-mismatch', 'first'), [project]);
    await reporter.observeRefresh(refresh('schema-mismatch', 'second'), [project]);
    await reporter.observeRefresh(refresh('schema-mismatch', 'first'), [project]);
    expect(receive).toHaveBeenCalledTimes(2);
  });

  it('does not report the same key again while its save is pending, and retries once it failed', async () => {
    const gate = deferred<typeof unsaved>();
    const receive = vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValue({ ok: true });
    const { reporter } = setup(receive);
    const first = reporter.observeRefresh(failure, [project]);
    const second = reporter.observeRefresh(failure, [project]);
    expect(receive).toHaveBeenCalledTimes(1);
    gate.resolve(unsaved);
    await Promise.all([first, second]);
    await reporter.observeRefresh(failure, [project]);
    expect(receive).toHaveBeenCalledTimes(2);
  });

  it('retries a transient kind on the very next sighting after its third-sighting report failed', async () => {
    const receive = vi.fn().mockResolvedValueOnce(unsaved).mockResolvedValue({ ok: true });
    const { reporter } = setup(receive);
    const locked = refresh('lock-contention', 'locked');
    await reporter.observeRefresh(locked, [project]);
    await reporter.observeRefresh(locked, [project]);
    expect(receive).not.toHaveBeenCalled();
    await reporter.observeRefresh(locked, [project]);
    expect(receive).toHaveBeenCalledTimes(1);
    await reporter.observeRefresh(locked, [project]);
    expect(receive).toHaveBeenCalledTimes(2);
    await reporter.observeRefresh(locked, [project]);
    expect(receive).toHaveBeenCalledTimes(2);
  });

  it('keeps the two key spaces apart: a failed refresh save does not reopen the same text reported from report()', async () => {
    const receive = vi.fn().mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce(unsaved).mockResolvedValue({ ok: true });
    const { reporter } = setup(receive);
    await expect(reporter.report({ source: 'api:GET /api/board', errorText: 'bd failed' })).resolves.toBe('recorded');
    await reporter.observeRefresh(refresh('schema-mismatch', 'bd failed'), [project]);
    await expect(reporter.report({ source: 'api:GET /api/board', errorText: 'bd failed' })).resolves.toBe('throttled');
    expect(receive).toHaveBeenCalledTimes(2);
  });
});

describe('a throttle that throws while forgetting does not break the never-reject contract', () => {
  it('contains it in report() and observeRefresh() and logs only the code', async () => {
    const throttle = createSelfErrorThrottle();
    vi.spyOn(throttle, 'forget').mockImplementation(() => { throw Object.assign(new Error('/private/example-project secret'), { code: 'EBOOM' }); });
    const { reporter, log } = setup(vi.fn().mockResolvedValue(unsaved), { throttle });
    await expect(reporter.report(input)).resolves.toBe('skipped');
    await expect(reporter.observeRefresh(refresh('schema-mismatch', 'failed'), [project])).resolves.toBeUndefined();
    const lines = log.mock.calls.map(([line]) => line);
    expect(lines).toContain('self error draft failed (EBOOM)');
    for (const line of lines) {
      expect(line).not.toContain('/private');
      expect(line).not.toContain('secret');
    }
  });
});
