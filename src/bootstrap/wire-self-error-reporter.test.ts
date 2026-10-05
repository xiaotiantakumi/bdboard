/** bdboard-4y8q.6.3: wiring 本物の下書き保存と self-error opt-out。 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIssueDraftService } from '../application/issue-report/issue-draft-service.js';
import { createFsIssueDraftStorage } from '../infrastructure/fs/fs-issue-draft-storage.js';
import { wireSelfErrorReporter } from './wire-self-error-reporter.js';
import { BdError } from '../application/ports/issue-repository.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

async function makeStorage() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bdboard-self-error-'));
  dirs.push(dir);
  let id = 0;
  const service = createIssueDraftService({ storage: createFsIssueDraftStorage(dir, { warn: vi.fn() }), now: () => new Date('2026-10-06T00:00:00.000Z'), newId: () => `179124480000${id++}-1234567890abcdef` });
  return { service };
}

describe('wireSelfErrorReporter', () => {
  it('stores a masked report from a refresh callback', async () => {
    const { service } = await makeStorage();
    const p = { id: 'p', name: 'example-project', rootPath: '/private/example-project', aliasPaths: [], prefixes: ['epic-haslett-00ae14'] };
    const cache = { listProjects: () => [{ project: p, tickets: [], fingerprint: '', fetchedAt: new Date() }], listProjectRefs: () => [p] };
    const wired = wireSelfErrorReporter({ env: {}, service, cache, applicationVersion: { getVersion: () => '1.2.3' }, now: () => new Date('2026-10-06T00:00:00.000Z'), log: vi.fn() });
    const result = { refreshed: [], reused: [], removed: [], errors: [new BdError('unknown', 'p', 'database "epic_haslett_00ae14" not found on dolt server at 127.0.0.1:3307')] };
    expect(wired.onRefreshResult).toBeDefined();
    expect(wired.reporter).toBeDefined();
    // kind unknown は 3 回続けて見えてから下書きにする (bdboard-f2ob)。1 回目と 2 回目では何も作らない。
    await wired.reporter?.observeRefresh(result, [p]);
    await wired.reporter?.observeRefresh(result, [p]);
    expect((await service.listWithPendingCount()).drafts).toHaveLength(0);
    wired.onRefreshResult?.(result, [p]);
    await vi.waitFor(async () => expect((await service.listWithPendingCount()).drafts).toHaveLength(1));
    // 同じ失敗をもう一度流しても、1 時間は同じ下書きに足されない (throttle)。
    await wired.reporter?.observeRefresh(result, [p]);
    const drafts = (await service.listWithPendingCount()).drafts;
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ title: '[bdboard 本体] bd-refresh:unknown', occurrenceCount: 1, localOnly: { errorTextRaw: 'database "<project>" not found on dolt server at 127.0.0.1:3307' } });
    expect(drafts[0]?.title).not.toContain('/private/example-project');
    expect(drafts[0]?.body).not.toContain('/private/example-project');
    expect(drafts[0]?.title).not.toContain('example-project');
    expect(drafts[0]?.body).not.toContain('example-project');
    expect(drafts[0]?.localOnly.errorTextRaw).not.toContain('epic-haslett-00ae14');
  });

  it.each(['off', 'OFF', ' 0 ', 'false'])('does not report when disabled by %s', (value) => {
    const receive = vi.fn(); const log = vi.fn();
    const wired = wireSelfErrorReporter({ env: { BDBOARD_SELF_ERROR_DRAFTS: value }, service: { receive }, cache: { listProjects: () => [] }, applicationVersion: { getVersion: () => '1' }, log });
    // 止めているときは reporter も onRefreshResult も作らない (refresh は observer を作らず、何も呼ばれない)。
    expect(wired.onRefreshResult).toBeUndefined();
    expect(wired.reporter).toBeUndefined();
    expect(receive).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledExactlyOnceWith('Self error drafts: disabled (BDBOARD_SELF_ERROR_DRAFTS)');
  });

  it.each([undefined, '', 'on'])('enables reporting when value is %s', async (value) => {
    const receive = vi.fn().mockResolvedValue({ ok: true });
    const wired = wireSelfErrorReporter({ env: { ...(value === undefined ? {} : { BDBOARD_SELF_ERROR_DRAFTS: value }) }, service: { receive }, cache: { listProjects: () => [] }, applicationVersion: { getVersion: () => '1' }, log: vi.fn() });
    expect(wired.onRefreshResult).toBeDefined();
    await wired.reporter?.report({ source: 'api:GET /manual', errorText: 'issue' });
    expect(receive).toHaveBeenCalledTimes(1);
  });
});
