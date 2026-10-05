import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult, CommandRunner } from '../../application/ports/command-runner.js';
import { createExternalIssueService } from '../../application/issue-report/external-issue-service.js';
import type { StoredExternalIssueSnapshot } from '../../domain/external-issue-snapshot-record.js';
import { createGhCliExternalIssueSource } from '../gh/gh-cli-external-issue-source.js';
import { createFsExternalIssueSnapshotStorage } from './fs-external-issue-snapshot-storage.js';

// application の層は infrastructure を import できないので、実物の gh アダプタ (CommandRunner は fake) と
// 実物のファイル保存を組み合わせた通しの確認は、infrastructure 側のテストに置く (bdboard-4y8q.9.3)。
const REPO_SLUG = 'xiaotiantakumi/bdboard';
const PROJECT_ROOT = '/example/projects/bdboard';

describe('with the real gh adapter and the real file storage', () => {
  let root: string;

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function row(number: number, extra: Record<string, unknown> = {}): string {
    const body = typeof extra.body === 'string' ? extra.body : 'body text';
    return JSON.stringify({
      number,
      title: `issue ${number}`,
      body,
      bodyLength: Array.from(body).length,
      updatedAt: '2026-10-05T00:00:00Z',
      author: 'someone',
      authorAssociation: 'NONE',
      pullRequest: false,
      ...extra,
    });
  }

  it('lists no PR and no linked issue, saves 0600 files in a 0700 directory, and marks an edited body', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bdboard-external-service-'));
    const baseDir = path.join(root, 'external-issues');
    let stdout = [row(1), row(2, { pullRequest: true }), row(3), row(4, { body: 'has <!-- a hidden note --> in it' })].join('\n') + '\n';
    const calls: Array<readonly string[]> = [];
    const runner: CommandRunner = {
      run: vi.fn((_command: string, args: readonly string[]) => {
        calls.push(args);
        return Promise.resolve<CommandResult>({ stdout, stderr: '', exitCode: 0 });
      }),
    };
    const service = createExternalIssueService({
      source: createGhCliExternalIssueSource(runner, { repoSlug: REPO_SLUG }),
      refReader: { listExternalRefs: () => Promise.resolve(['gh-3']) },
      storage: createFsExternalIssueSnapshotStorage(baseDir),
      projectRootPath: PROJECT_ROOT,
      repoSlug: REPO_SLUG,
    });

    const first = await service.poll();

    expect(first.state).toBe('ok');
    // 2 は PR、3 は bd に紐付いているので並ばず、写しも無い。
    expect(first.issues.map((entry) => entry.number)).toEqual([1, 4]);
    expect((await fs.readdir(baseDir)).sort()).toEqual(['1.json', '4.json']);
    if (process.platform !== 'win32') {
      expect((await fs.stat(baseDir)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(path.join(baseDir, '4.json'))).mode & 0o777).toBe(0o600);
    }
    const saved = JSON.parse(await fs.readFile(path.join(baseDir, '4.json'), 'utf8')) as StoredExternalIssueSnapshot;
    expect(saved).toMatchObject({ number: 4, needsRejudge: false, body: 'has <!-- a hidden note --> in it' });
    expect(saved.checks.body.htmlComments.count).toBe(1);

    stdout = [row(1, { body: 'edited text' }), row(4, { body: 'has <!-- a hidden note --> in it', updatedAt: '2026-10-06T00:00:00Z' })].join('\n') + '\n';
    const second = await service.poll();

    expect(second.issues.map((entry) => [entry.number, entry.snapshot.needsRejudge, entry.snapshot.updatedAtChanged])).toEqual([
      [1, true, false],
      [4, false, true],
    ]);
    expect(JSON.parse(await fs.readFile(path.join(baseDir, '1.json'), 'utf8'))).toMatchObject({ needsRejudge: true, body: 'body text' });
    // gh へは読み取り (GET) の呼び出しだけ。
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) expect(args.slice(0, 3)).toEqual(['api', '--method', 'GET']);
  });
});
