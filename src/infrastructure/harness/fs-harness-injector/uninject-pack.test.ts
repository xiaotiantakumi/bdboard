import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PackSummary } from '../../../domain/harness-pack.js';
import { createFsPackRegistry } from '../fs-pack-registry.js';
import { createFsHarnessInjector } from '../fs-harness-injector.js';
import { applyUninject } from './uninject-apply.js';
import { planUninject, type UninjectPlan } from './uninject-pack.js';

/**
 * 往復テスト: 注入 (本物の injectPack) → 外す (planUninject + applyUninject) で、注入先が
 * 元の状態に戻る (bdboard-l1m1.7)。
 */
describe('planUninject / applyUninject', () => {
  let tmpDir: string;
  let packsRoot: string;
  let projectRoot: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'bdboard-harness-uninject-'));
    packsRoot = path.join(tmpDir, 'bdboard', 'harness', 'packs');
    projectRoot = path.join(tmpDir, 'project');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(packsRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writePack(
    name: string,
    extra: { role?: 'base' | 'optional'; requires?: string[]; hookScript?: string; hookEvent?: string },
  ): void {
    const hookScript = extra.hookScript ?? 'hooks/run.sh';
    const packDir = path.join(packsRoot, name);
    mkdirSync(path.join(packDir, 'hooks'), { recursive: true });
    mkdirSync(path.join(packDir, 'references'), { recursive: true });
    writeFileSync(
      path.join(packDir, 'pack.json'),
      JSON.stringify({
        name,
        version: '1.0.0',
        description: `${name} pack`,
        ...(extra.role === undefined ? {} : { role: extra.role }),
        ...(extra.requires === undefined ? {} : { requires: extra.requires }),
        hooks: [{ event: extra.hookEvent ?? 'Stop', script: hookScript, timeout: 5 }],
      }),
      'utf8',
    );
    writeFileSync(path.join(packDir, 'SKILL.md'), `# ${name}\n`, 'utf8');
    writeFileSync(path.join(packDir, hookScript), '#!/bin/bash\nexit 0\n', 'utf8');
    writeFileSync(path.join(packDir, 'references', 'note.md'), 'note\n', 'utf8');
  }

  function setupPacks(): void {
    writePack('base-pack', { role: 'base', hookEvent: 'Stop' });
    writePack('video-pack', { role: 'optional', requires: ['base-pack'], hookEvent: 'SessionStart' });
    writePack('extra-pack', { role: 'optional', requires: ['video-pack'], hookEvent: 'SessionStart' });
  }

  async function inject(name: string): Promise<void> {
    const registry = createFsPackRegistry(packsRoot);
    const pack = await registry.getPack(name);
    if (pack === undefined) {
      throw new Error(`fixture pack missing: ${name}`);
    }
    await createFsHarnessInjector({ packsRoot }).injectPack(projectRoot, pack, new Date('2026-11-06T00:00:00Z'));
  }

  async function available(): Promise<readonly PackSummary[]> {
    return createFsPackRegistry(packsRoot).listPacks();
  }

  async function planOk(packName: string): Promise<UninjectPlan> {
    const plan = await planUninject({
      projectRootPath: projectRoot,
      packName,
      packsRoot,
      available: await available(),
    });
    if (!plan.ok) {
      throw new Error(`expected a plan, got refusal: ${plan.code}: ${plan.reason}`);
    }
    return plan;
  }

  function snapshot(root: string): Record<string, string> {
    const result: Record<string, string> = {};
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          result[`${path.relative(root, absolute)}/`] = '<dir>';
          walk(absolute);
        } else {
          result[path.relative(root, absolute)] = readFileSync(absolute, 'utf8');
        }
      }
    };
    walk(root);
    return result;
  }

  function readJson(relativePath: string): unknown {
    return JSON.parse(readFileSync(path.join(projectRoot, relativePath), 'utf8'));
  }

  const USER_HOOK = {
    hooks: [{ type: 'command', command: 'echo user-hook' }],
  };

  it('round trip: a fresh project goes back to its original state (only the shared settings.local.json ignore line remains)', async () => {
    setupPacks();
    writeFileSync(path.join(projectRoot, 'README.md'), 'hello\n', 'utf8');
    writeFileSync(path.join(projectRoot, '.gitignore'), 'node_modules\n', 'utf8');
    const before = snapshot(projectRoot);

    await inject('base-pack');
    expect(snapshot(projectRoot)).not.toEqual(before);

    await applyUninject(await planOk('base-pack'));

    const after = snapshot(projectRoot);
    // 空ディレクトリ (.claude/ 以下) まで畳まれ、注入が作ったファイルは何も残らない。
    expect(Object.keys(after).filter((key) => key.startsWith('.claude'))).toEqual([]);
    // 無関係なファイルは変わらない。
    expect(after['README.md']).toBe('hello\n');
    // .gitignore: 元の行 + 全パック共有の settings.local.json の行 (とその管理ヘッダー) だけが残る。
    // 自分のパックの行と注入記録の行は戻る。
    expect(after['.gitignore']).toBe(
      [
        'node_modules',
        '# bdboard-harness: managed pack injections (do not edit lines below by hand)',
        '.claude/settings.local.json',
        '',
      ].join('\n'),
    );
    expect(Object.keys(after).sort()).toEqual(['.gitignore', 'README.md']);
  });

  it('round trip: other hooks and settings in settings.json and settings.local.json are untouched', async () => {
    setupPacks();
    const settingsJson = {
      permissions: { deny: ['Bash(rm -rf *)'] },
      hooks: { Stop: [USER_HOOK] },
    };
    const localJson = {
      env: { FOO: 'bar' },
      hooks: { Stop: [USER_HOOK], PreToolUse: [{ matcher: 'Bash', ...USER_HOOK }] },
    };
    mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
    writeFileSync(
      path.join(projectRoot, '.claude/settings.json'),
      `${JSON.stringify(settingsJson, null, 2)}\n`,
      'utf8',
    );
    writeFileSync(
      path.join(projectRoot, '.claude/settings.local.json'),
      `${JSON.stringify(localJson, null, 2)}\n`,
      'utf8',
    );

    await inject('base-pack');
    expect((readJson('.claude/settings.local.json') as { hooks: { Stop: unknown[] } }).hooks.Stop).toHaveLength(2);

    await applyUninject(await planOk('base-pack'));

    expect(readJson('.claude/settings.json')).toEqual(settingsJson);
    expect(readJson('.claude/settings.local.json')).toEqual(localJson);
  });

  it('removes the pack hooks from both settings.json (legacy registration) and settings.local.json', async () => {
    setupPacks();
    await inject('base-pack');
    // 移行前の注入先: 同じ hook が settings.json にも載っている (本物の mergeHarnessHooks の出力を複製)。
    const local = readFileSync(path.join(projectRoot, '.claude/settings.local.json'), 'utf8');
    writeFileSync(path.join(projectRoot, '.claude/settings.json'), local, 'utf8');

    const plan = await planOk('base-pack');
    expect(plan.settings.map((entry) => entry.relativePath)).toEqual([
      '.claude/settings.json',
      '.claude/settings.local.json',
    ]);
    await applyUninject(plan);

    expect(Object.keys(snapshot(projectRoot)).filter((key) => key.startsWith('.claude'))).toEqual([]);
  });

  it('removes the pack entry from the manifest and keeps the other packs intact', async () => {
    setupPacks();
    await inject('base-pack');
    await inject('video-pack');
    const baseFilesBefore = Object.entries(snapshot(projectRoot)).filter(([key]) =>
      key.startsWith('.claude/skills/base-pack/'),
    );

    await applyUninject(await planOk('video-pack'));

    const manifest = readJson('.claude/bdboard-packs.json') as { packs: { name: string }[] };
    expect(manifest.packs.map((entry) => entry.name)).toEqual(['base-pack']);
    const after = snapshot(projectRoot);
    expect(Object.keys(after).some((key) => key.startsWith('.claude/skills/video-pack'))).toBe(false);
    expect(
      Object.entries(after).filter(([key]) => key.startsWith('.claude/skills/base-pack/')),
    ).toEqual(baseFilesBefore);
    // base の hook は残り、video の hook だけが消える。
    const hooks = (readJson('.claude/settings.local.json') as { hooks: Record<string, unknown> }).hooks;
    expect(Object.keys(hooks)).toEqual(['Stop']);
    const gitignore = after['.gitignore'];
    expect(gitignore).toContain('.claude/skills/base-pack/');
    expect(gitignore).not.toContain('.claude/skills/video-pack/');
    // まだ最後のパックではないので注入記録の行は残る。
    expect(gitignore).toContain('.claude/bdboard-packs.json');
  });

  it('allows removing the base once the optional packs that need it are gone', async () => {
    setupPacks();
    await inject('base-pack');
    await inject('video-pack');

    await applyUninject(await planOk('video-pack'));
    await applyUninject(await planOk('base-pack'));

    expect(Object.keys(snapshot(projectRoot)).filter((key) => key.startsWith('.claude'))).toEqual([]);
  });

  it('refuses to remove a pack that an injected pack requires (base with a dependent optional pack)', async () => {
    setupPacks();
    await inject('base-pack');
    await inject('video-pack');

    const result = await planUninject({
      projectRootPath: projectRoot,
      packName: 'base-pack',
      packsRoot,
      available: await available(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('required-by-injected');
      expect(result.reason).toContain('video-pack');
    }
  });

  it('refuses to remove a pack in the middle of a chain (A -> B -> C: C while A is injected)', async () => {
    setupPacks();
    await inject('base-pack');
    await inject('video-pack');
    await inject('extra-pack');

    for (const target of ['base-pack', 'video-pack']) {
      const result = await planUninject({
        projectRootPath: projectRoot,
        packName: target,
        packsRoot,
        available: await available(),
      });
      expect(result.ok).toBe(false);
    }
    // 末端 (extra-pack) は外せる。
    expect((await planOk('extra-pack')).ok).toBe(true);
  });

  it('refuses a pack that is not in the manifest', async () => {
    setupPacks();
    await inject('base-pack');

    const result = await planUninject({
      projectRootPath: projectRoot,
      packName: 'video-pack',
      packsRoot,
      available: await available(),
    });

    expect(result).toMatchObject({ ok: false, code: 'not-injected' });
  });

  it('refuses a self-injection target (the repo that holds the pack originals)', async () => {
    setupPacks();
    const selfRoot = path.join(tmpDir, 'bdboard');
    await createFsHarnessInjector({ packsRoot }).injectPack(
      selfRoot,
      (await createFsPackRegistry(packsRoot).getPack('base-pack'))!,
      new Date('2026-11-06T00:00:00Z'),
    );

    const result = await planUninject({
      projectRootPath: selfRoot,
      packName: 'base-pack',
      packsRoot,
      available: await available(),
    });

    expect(result).toMatchObject({ ok: false, code: 'self-injection' });
  });

  it('planning is read-only (the dry-run lists what would go and changes nothing)', async () => {
    setupPacks();
    await inject('base-pack');
    const before = snapshot(projectRoot);

    const plan = await planOk('base-pack');

    expect(snapshot(projectRoot)).toEqual(before);
    expect(plan.files.every((file) => file.exists)).toBe(true);
    expect(plan.files.map((file) => file.relativePath)).toContain('.claude/skills/base-pack/SKILL.md');
    expect(plan.manifest.content).toBeNull();
  });

  it('leaves a user file inside the pack directory and keeps the directory', async () => {
    setupPacks();
    await inject('base-pack');
    writeFileSync(path.join(projectRoot, '.claude/skills/base-pack/my-notes.md'), 'mine\n', 'utf8');

    await applyUninject(await planOk('base-pack'));

    const after = snapshot(projectRoot);
    expect(after['.claude/skills/base-pack/my-notes.md']).toBe('mine\n');
    expect(after['.claude/skills/base-pack/SKILL.md']).toBeUndefined();
  });

  it('refuses without writing when a settings file holds the pack marker but is broken JSON', async () => {
    setupPacks();
    await inject('base-pack');
    const broken = '{ "hooks": /.claude/skills/base-pack/hooks/ ';
    writeFileSync(path.join(projectRoot, '.claude/settings.json'), broken, 'utf8');
    const before = snapshot(projectRoot);

    const result = await planUninject({
      projectRootPath: projectRoot,
      packName: 'base-pack',
      packsRoot,
      available: await available(),
    });

    expect(result).toMatchObject({ ok: false, code: 'settings-unreadable' });
    expect(snapshot(projectRoot)).toEqual(before);
  });

  it('can be re-run after a partial failure (files already gone are fine)', async () => {
    setupPacks();
    await inject('base-pack');
    const first = await planOk('base-pack');
    // 先に一部のファイルだけ消えた状態を作る。
    rmSync(path.join(projectRoot, '.claude/skills/base-pack/SKILL.md'));

    await applyUninject(first);

    expect(Object.keys(snapshot(projectRoot)).filter((key) => key.startsWith('.claude'))).toEqual([]);
  });
});
