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
const failure = (detail = SENTENCE, kind: 'unknown' | 'schema-mismatch' = 'unknown'): RefreshResult => ({
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
  it('keeps one draft for 30 identical failures, then merges one more report an hour later', async () => {
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

    clock.at = START + HOUR + 60_000;
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

      expect(wired.onRefreshResult(failure(), [PROJECT])).toBeUndefined();
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
