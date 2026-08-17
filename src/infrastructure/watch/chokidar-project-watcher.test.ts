import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectWatchHandle } from '../../application/ports/project-watcher.js';
import type { Project } from '../../domain/project.js';
import { createChokidarProjectWatcher } from './chokidar-project-watcher.js';

// 実ファイルシステムのイベントを待つテストなので、debounce は短く、待ち時間は長めに取る。
const DEBOUNCE_MS = 20;
const WAIT_TIMEOUT_MS = 8000;
const TEST_TIMEOUT_MS = 20000;
const TOUCH_INTERVAL_MS = 50;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Changes {
  readonly seen: string[];
  readonly onChange: (projectId: string) => void;
}

function collectChanges(): Changes {
  const seen: string[] = [];
  return {
    seen,
    onChange(projectId: string): void {
      seen.push(projectId);
    },
  };
}

/**
 * chokidar の add() は非同期に効く(watcher.add() が返った時点ではまだ購読前のことがある)ので、
 * 条件が満たされるまで書き込みを繰り返す。満たされずタイムアウトしたら false。
 */
async function touchUntil(
  filePaths: readonly string[],
  isDone: () => boolean,
  timeoutMs = WAIT_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let counter = 0;

  while (Date.now() < deadline) {
    counter += 1;
    for (const filePath of filePaths) {
      await writeFile(filePath, `touch ${counter}\n`);
    }
    await delay(TOUCH_INTERVAL_MS);
    if (isDone()) {
      return true;
    }
  }

  return isDone();
}

describe('createChokidarProjectWatcher', () => {
  let root: string;
  let handle: ProjectWatchHandle | undefined;

  beforeEach(async () => {
    // macOS の /var -> /private/var のような symlink 越しだと chokidar の報告パスと
    // 監視パスがずれるので、実体パスに解決してから使う。
    root = await realpath(await mkdtemp(join(tmpdir(), 'bdboard-watch-')));
  });

  afterEach(async () => {
    await handle?.stop();
    handle = undefined;
    await rm(root, { recursive: true, force: true });
  });

  /** .beads/last-touched を持つプロジェクトを作り、その last-touched のパスを返す */
  async function makeProject(id: string): Promise<{
    project: Project;
    lastTouched: string;
  }> {
    const rootPath = join(root, id);
    const beadsDir = join(rootPath, '.beads');
    await mkdir(beadsDir, { recursive: true });
    const lastTouched = join(beadsDir, 'last-touched');
    await writeFile(lastTouched, 'initial\n');

    return {
      project: {
        id,
        name: id,
        rootPath,
        prefixes: [id],
        aliasPaths: [],
      },
      lastTouched,
    };
  }

  it(
    'reports changes for a project added after watching started',
    async () => {
      const alpha = await makeProject('alpha');
      const beta = await makeProject('beta');
      const changes = collectChanges();

      handle = await createChokidarProjectWatcher({
        debounceMs: DEBOUNCE_MS,
      }).watch([alpha.project], changes.onChange);

      await handle.update([alpha.project, beta.project]);

      const fired = await touchUntil([beta.lastTouched], () =>
        changes.seen.includes('beta'),
      );

      expect(fired).toBe(true);
      expect(changes.seen).toContain('beta');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reports changes for the very first project when watching started empty',
    async () => {
      const alpha = await makeProject('alpha');
      const changes = collectChanges();

      handle = await createChokidarProjectWatcher({
        debounceMs: DEBOUNCE_MS,
      }).watch([], changes.onChange);

      await handle.update([alpha.project]);

      const fired = await touchUntil([alpha.lastTouched], () =>
        changes.seen.includes('alpha'),
      );

      expect(fired).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'stops reporting a project dropped from the watch set',
    async () => {
      const alpha = await makeProject('alpha');
      const beta = await makeProject('beta');
      const changes = collectChanges();

      handle = await createChokidarProjectWatcher({
        debounceMs: DEBOUNCE_MS,
      }).watch([alpha.project, beta.project], changes.onChange);

      // まず両方が実際に監視されていることを確かめる(そうでないと後半の「飛ばない」が無意味)
      const bothWatched = await touchUntil(
        [alpha.lastTouched, beta.lastTouched],
        () => changes.seen.includes('alpha') && changes.seen.includes('beta'),
      );
      expect(bothWatched).toBe(true);

      await handle.update([alpha.project]);
      // update 直前に投げ込まれた debounce 済みイベントを吐き切らせてから記録を捨てる
      await delay(TOUCH_INTERVAL_MS * 4);
      changes.seen.length = 0;

      // alpha(監視継続)が飛ぶまで両方を叩き続ける。alpha が飛ぶだけの時間が経っても
      // beta が飛んでいなければ、beta は本当に外れている。
      const alphaFired = await touchUntil(
        [alpha.lastTouched, beta.lastTouched],
        () => changes.seen.includes('alpha'),
      );

      expect(alphaFired).toBe(true);
      expect(changes.seen).not.toContain('beta');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'stops reporting anything after stop()',
    async () => {
      const alpha = await makeProject('alpha');
      const changes = collectChanges();

      const stopped = await createChokidarProjectWatcher({
        debounceMs: DEBOUNCE_MS,
      }).watch([alpha.project], changes.onChange);

      const fired = await touchUntil([alpha.lastTouched], () =>
        changes.seen.includes('alpha'),
      );
      expect(fired).toBe(true);

      await stopped.stop();
      await delay(TOUCH_INTERVAL_MS * 4);
      changes.seen.length = 0;

      await touchUntil(
        [alpha.lastTouched],
        () => changes.seen.length > 0,
        TOUCH_INTERVAL_MS * 10,
      );

      expect(changes.seen).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});
