/**
 * bdboard-4y8q.6.3 の受け入れ基準: 本物の下書きサービス + 一時ディレクトリの保存で、#432 と同じ文のリフレッシュの失敗を流す。
 * 30 回流しても下書きは 1 件 / 1 時間後は outcome merged で回数が増える / 題名にパスもプロジェクト名も入らない /
 * receive が reject してもプロセスが落ちない / ログにパスも本文も出ない。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RefreshResult } from '../application/board/refresh-projects.js';
import { createIssueDraftService } from '../application/issue-report/issue-draft-service.js';
import type { IssueDraftService } from '../application/issue-report/issue-draft-service.js';
import { BdError } from '../application/ports/issue-repository.js';
import type { BdErrorKind } from '../application/ports/issue-repository.js';
import type { Project } from '../domain/project.js';
import { createFsIssueDraftStorage } from '../infrastructure/fs/fs-issue-draft-storage.js';
import { wireSelfErrorReporter } from './wire-self-error-reporter.js';

const HOUR = 60 * 60_000;
const START = new Date('2026-10-06T00:00:00.000Z').getTime();
const PROJECT: Project = {
  id: 'example-id',
  name: 'example-project',
  rootPath: '/private/example-project',
  aliasPaths: [],
  prefixes: ['epic-haslett-00ae14'],
};
const SENTENCE = 'database "epic_haslett_00ae14" not found on dolt server at 127.0.0.1:3307';
const failure = (detail = SENTENCE, kind: BdErrorKind = 'unknown'): RefreshResult => ({
  refreshed: [],
  reused: [],
  removed: [],
  errors: [new BdError(kind, PROJECT.id, detail)],
});

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function realService(): Promise<IssueDraftService> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bdboard-self-error-acceptance-'));
  dirs.push(dir);
  let seq = 0;
  return createIssueDraftService({
    storage: createFsIssueDraftStorage(dir, { warn: () => undefined }),
    now: () => new Date(),
    newId: () => `${1791244800000 + seq++}-1234567890abcdef`,
  });
}

/** 有効 (env が空) で配線し、reporter と onRefreshResult を取り出す。止めている形は wire-self-error-reporter.test.ts が見る。 */
function wire(service: Pick<IssueDraftService, 'receive'>, clock: { at: number }, log: (message: string) => void) {
  const wired = wireSelfErrorReporter({
    env: {},
    service,
    cache: { listProjects: () => [], listProjectRefs: () => [PROJECT] },
    applicationVersion: { getVersion: () => '1.2.3' },
    now: () => new Date(clock.at),
    log,
  });
  if (wired.reporter === undefined || wired.onRefreshResult === undefined) throw new Error('self error reporter is disabled');
  return { reporter: wired.reporter, onRefreshResult: wired.onRefreshResult };
}

describe('self error drafts from refresh failures (acceptance, real service and temp directory)', () => {
  it('keeps one draft for 30 identical failures (made on the third), then merges one more report an hour after that', async () => {
    const real = await realService();
    const outcomes: string[] = [];
    const service = {
      receive: async (input: Parameters<IssueDraftService['receive']>[0]) => {
        const result = await real.receive(input);
        outcomes.push(result.ok ? result.outcome : result.reason);
        return result;
      },
    };
    const clock = { at: START };
    const wired = wire(service, clock, vi.fn());

    for (let round = 0; round < 30; round += 1) {
      clock.at = START + round * 60_000;
      await wired.reporter.observeRefresh(failure(), [PROJECT]);
    }
    const first = (await real.listWithPendingCount()).drafts;
    expect(first).toHaveLength(1);
    expect(first[0]?.occurrenceCount).toBe(1);
    expect(outcomes).toEqual(['created']);

    // 下書きになったのは 3 回目 (2 分後) なので、次の報告は 62 分以降 (kind unknown は 3 回続けて見えてから。bdboard-f2ob)。余裕を見て 63 分に流す。
    clock.at = START + HOUR + 3 * 60_000;
    await wired.reporter.observeRefresh(failure(), [PROJECT]);
    const second = (await real.listWithPendingCount()).drafts;
    expect(outcomes).toEqual(['created', 'merged']);
    expect(second).toHaveLength(1);
    expect(second[0]?.occurrenceCount).toBe(2);

    const draft = second[0];
    expect(draft?.title).toBe('[bdboard 本体] bd-refresh:unknown');
    for (const secret of [PROJECT.rootPath, PROJECT.name, 'epic-haslett-00ae14', 'epic_haslett_00ae14']) {
      expect(draft?.title).not.toContain(secret);
      expect(draft?.body).not.toContain(secret);
      expect(draft?.localOnly.errorTextRaw).not.toContain(secret);
    }
    expect(draft?.localOnly.errorTextRaw).toBe('database "<project>" not found on dolt server at 127.0.0.1:3307');
  });

  // bdboard-f2ob: #915 の deploy 直後、別プロジェクトの Dolt サーバーに 1 回だけ繋がらず (kind unknown)、1 回で下書きになった実例。
  it('makes no draft for a one-off connection refused, and one draft when it lasts three refreshes in a row', async () => {
    const real = await realService();
    const clock = { at: START };
    const wired = wire(real, clock, vi.fn());
    const refused = (port: number): string =>
      `error: failed to open database: dolt server unreachable at 127.0.0.1:${port}: dial tcp 127.0.0.1:${port}: connect: connection refused / the dolt server may not be running. try: bd dolt start`;
    const refresh = async (result: RefreshResult, minutes: number): Promise<void> => {
      clock.at = START + minutes * 60_000;
      await wired.reporter.observeRefresh(result, [PROJECT]);
    };
    const succeeded: RefreshResult = { refreshed: [PROJECT.id], reused: [], removed: [], errors: [] };
    const drafts = async () => (await real.listWithPendingCount()).drafts;

    // 1 回だけ繋がらず、次の更新 (5 分後の定期更新) は成功。そのあとも静か。
    await refresh(failure(refused(60995)), 0);
    await refresh(succeeded, 5);
    await refresh(succeeded, 10);
    expect(await drafts()).toEqual([]);

    // 2 回続いて成功を挟むと、数え直し: 成功のあとの 2 回では下書きにならない。
    await refresh(failure(refused(60995)), 15);
    await refresh(failure(refused(61292)), 20);
    await refresh(succeeded, 25);
    await refresh(failure(refused(61300)), 30);
    await refresh(failure(refused(61301)), 35);
    expect(await drafts()).toEqual([]);

    // 3 回続けて (ポートは更新ごとに違ってもよい) 初めて下書きになる。
    await refresh(failure(refused(61302)), 40);
    const created = await drafts();
    expect(created).toHaveLength(1);
    expect(created[0]?.title).toBe('[bdboard 本体] bd-refresh:unknown');
    expect(created[0]?.occurrenceCount).toBe(1);
  });

  it('survives a receive that rejects: no unhandled rejection, a fixed log line, and later failures still go through', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const receive = vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('/private/example-project secret-body'), { code: 'EIO' }));
      const logs: string[] = [];
      const clock = { at: START };
      const wired = wire({ receive }, clock, (message) => logs.push(message));

      // schema-mismatch は 1 回目で報告する種類 (unknown は 3 回続けて見えてから)。
      expect(wired.onRefreshResult(failure(SENTENCE, 'schema-mismatch'), [PROJECT])).toBeUndefined();
      wired.onRefreshResult(failure('other failure text', 'schema-mismatch'), [PROJECT]);
      for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setImmediate(resolve));

      expect(receive).toHaveBeenCalledTimes(2);
      expect(logs).toEqual(['self error draft failed (EIO)', 'self error draft failed (EIO)']);
      for (const line of logs) {
        expect(line).not.toContain('/private');
        expect(line).not.toContain('secret-body');
        expect(line).not.toContain('example-project');
      }
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
