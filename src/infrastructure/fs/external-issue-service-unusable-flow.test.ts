import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult, CommandRunner } from '../../application/ports/command-runner.js';
import { createExternalIssueService } from '../../application/issue-report/external-issue-service.js';
import type { StoredExternalIssueSnapshot } from '../../domain/external-issue-snapshot-record.js';
import { createGhCliExternalIssueSource } from '../gh/gh-cli-external-issue-source.js';
import { createFsExternalIssueSnapshotStorage } from './fs-external-issue-snapshot-storage.js';

// bdboard-g2ti: 実物の gh アダプタ (CommandRunner は fake) と実物のファイル保存で、使えない写しがディスクに
// 残っているときの作り直しを確かめる (application の層は infrastructure を import できないので、通しはここに置く)。
const REPO_SLUG = 'xiaotiantakumi/bdboard';
const PROJECT_ROOT = '/example/projects/bdboard';

describe('a snapshot file that cannot be used, with the real gh adapter and the real file storage', () => {
  let root: string;
  let baseDir: string;
  let stdout: string;
  const warn = vi.fn<(message: string) => void>();

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bdboard-external-unusable-'));
    baseDir = path.join(root, 'external-issues');
    stdout = '';
    warn.mockClear();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function row(number: number, body = 'body text'): string {
    return JSON.stringify({
      number,
      title: `issue ${number}`,
      body,
      bodyLength: Array.from(body).length,
      updatedAt: '2026-10-05T00:00:00Z',
      author: 'someone',
      authorAssociation: 'NONE',
      pullRequest: false,
    });
  }

  function createService() {
    const runner: CommandRunner = {
      run: vi.fn(() => Promise.resolve<CommandResult>({ stdout: `${stdout}\n`, stderr: '', exitCode: 0 })),
    };
    return createExternalIssueService({
      source: createGhCliExternalIssueSource(runner, { repoSlug: REPO_SLUG }),
      refReader: { listExternalRefs: () => Promise.resolve([]) },
      storage: createFsExternalIssueSnapshotStorage(baseDir, { warn }),
      projectRootPath: PROJECT_ROOT,
      repoSlug: REPO_SLUG,
    });
  }

  async function readSaved(number: number): Promise<StoredExternalIssueSnapshot> {
    return JSON.parse(await fs.readFile(path.join(baseDir, `${number}.json`), 'utf8')) as StoredExternalIssueSnapshot;
  }

  it('broken JSON: makes the file again with needsRejudge=true, and the next poll keeps the mark', async () => {
    await fs.mkdir(baseDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(baseDir, '1.json'), 'not json {', { mode: 0o600 });
    stdout = row(1);
    const service = createService();

    const first = await service.poll();

    expect(first.state).toBe('ok');
    expect(first.issues[0]?.snapshot.needsRejudge).toBe(true);
    expect(await readSaved(1)).toMatchObject({ number: 1, body: 'body text', needsRejudge: true, missingSince: null });
    expect(warn).toHaveBeenCalledWith('external issue snapshot 1 is skipped: not valid JSON');

    const second = await service.poll();

    expect(second.issues[0]?.snapshot.needsRejudge).toBe(true);
    expect((await readSaved(1)).needsRejudge).toBe(true);
  });

  it('old format (a field the current format needs is missing): makes the file again with needsRejudge=true even though the content is unchanged', async () => {
    stdout = row(2);
    expect((await createService().poll()).issues[0]?.snapshot.needsRejudge).toBe(false);
    // 将来 checks に欄を足すと、足す前の写しはこの形になる (今の形から欄を 1 つ欠いたファイルで真似る)。
    const old = (await readSaved(2)) as unknown as { checks: { body: Record<string, unknown> } };
    delete old.checks.body.links;
    await fs.writeFile(path.join(baseDir, '2.json'), JSON.stringify(old), { mode: 0o600 });
    // 別のサービス (再起動を模す) が、使えなくなった写しを読む。
    const service = createService();

    const list = await service.poll();

    expect(list.state).toBe('ok');
    expect(list.issues[0]?.snapshot.needsRejudge).toBe(true);
    expect(await readSaved(2)).toMatchObject({ number: 2, needsRejudge: true, body: 'body text' });
    expect(warn).toHaveBeenCalledWith('external issue snapshot 2 is skipped: does not match the snapshot format');
  });

  it('first seen (no file): does not mark needsRejudge, now or on the next poll', async () => {
    stdout = row(3);
    const service = createService();

    const first = await service.poll();

    expect(first.issues[0]?.snapshot.needsRejudge).toBe(false);
    expect(await readSaved(3)).toMatchObject({ number: 3, needsRejudge: false });
    expect(warn).not.toHaveBeenCalled();

    const second = await service.poll();

    expect(second.issues[0]?.snapshot.needsRejudge).toBe(false);
    expect((await readSaved(3)).needsRejudge).toBe(false);
  });

  it('a broken file next to good ones: the broken one is marked, and the good ones still compare with their own saved copy', async () => {
    stdout = [row(4), row(5), row(6)].join('\n');
    await createService().poll();
    await fs.writeFile(path.join(baseDir, '4.json'), '{"number":4', { mode: 0o600 });
    stdout = [row(4), row(5), row(6, 'edited body')].join('\n');
    const service = createService();

    const list = await service.poll();

    expect(list.issues.map((entry) => [entry.number, entry.snapshot.needsRejudge])).toEqual([
      [4, true],
      [5, false],
      [6, true],
    ]);
    // 6 は使える写し (本文は最初のまま) と比べて立った。4 は使えない写しを作り直した分で、今の内容が写しになる。
    expect(await readSaved(6)).toMatchObject({ body: 'body text', needsRejudge: true });
    expect(await readSaved(4)).toMatchObject({ body: 'body text', needsRejudge: true });
  });
});
