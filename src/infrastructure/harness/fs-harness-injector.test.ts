import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HarnessPathTraversalError } from '../../application/ports/harness-injector.js';
import { createFsHarnessInjector } from './fs-harness-injector.js';

describe('createFsHarnessInjector', () => {
  let tmpDir: string;
  let packsRoot: string;
  let projectRoot: string;

  afterEach(() => {
    if (tmpDir !== undefined) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function setupFixture(): ReturnType<typeof createFsHarnessInjector> {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'bdboard-harness-inject-'));
    packsRoot = path.join(tmpDir, 'packs');
    projectRoot = path.join(tmpDir, 'project');
    mkdirSync(projectRoot, { recursive: true });
    return createFsHarnessInjector({ packsRoot });
  }

  function writePack(
    name: string,
    version: string,
    files: Record<string, string>,
  ): void {
    const packDir = path.join(packsRoot, name);
    mkdirSync(packDir, { recursive: true });
    writeFileSync(
      path.join(packDir, 'pack.json'),
      JSON.stringify({ name, version, description: `${name} pack` }),
      'utf8',
    );
    for (const [relativePath, content] of Object.entries(files)) {
      const absolute = path.join(packDir, relativePath);
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, content, 'utf8');
    }
  }

  it('copies pack files into .claude/skills and writes manifest', async () => {
    const injector = setupFixture();
    writePack('bdboard-harness', '0.1.0', {
      'SKILL.md': '# harness',
      'references/a.md': 'reference',
    });

    const manifest = await injector.injectPack(
      projectRoot,
      {
        name: 'bdboard-harness',
        version: '0.1.0',
        description: 'test',
        files: [{ relativePath: 'SKILL.md' }, { relativePath: 'references/a.md' }],
      },
      new Date('2026-08-16T10:00:00.000Z'),
    );

    expect(existsSync(path.join(projectRoot, '.claude/skills/bdboard-harness/SKILL.md'))).toBe(
      true,
    );
    expect(
      readFileSync(
        path.join(projectRoot, '.claude/skills/bdboard-harness/SKILL.md'),
        'utf8',
      ),
    ).toBe('# harness');
    expect(manifest.packs).toEqual([
      {
        name: 'bdboard-harness',
        version: '0.1.0',
        injectedAt: '2026-08-16T10:00:00.000Z',
        files: [
          '.claude/skills/bdboard-harness/SKILL.md',
          '.claude/skills/bdboard-harness/references/a.md',
        ],
      },
    ]);
    expect(
      JSON.parse(
        readFileSync(path.join(projectRoot, '.claude/bdboard-packs.json'), 'utf8'),
      ),
    ).toEqual(manifest);
  });

  it('removes stale files from a previous install of the same pack', async () => {
    const injector = setupFixture();
    writePack('bdboard-harness', '0.1.0', {
      'SKILL.md': '# v1',
      'references/old.md': 'old',
    });
    writePack('bdboard-harness', '0.2.0', {
      'SKILL.md': '# v2',
      'references/new.md': 'new',
    });

    await injector.injectPack(
      projectRoot,
      {
        name: 'bdboard-harness',
        version: '0.1.0',
        description: 'test',
        files: [{ relativePath: 'SKILL.md' }, { relativePath: 'references/old.md' }],
      },
      new Date('2026-08-16T10:00:00.000Z'),
    );

    const manifest = await injector.injectPack(
      projectRoot,
      {
        name: 'bdboard-harness',
        version: '0.2.0',
        description: 'test',
        files: [{ relativePath: 'SKILL.md' }, { relativePath: 'references/new.md' }],
      },
      new Date('2026-08-16T11:00:00.000Z'),
    );

    expect(
      existsSync(path.join(projectRoot, '.claude/skills/bdboard-harness/references/old.md')),
    ).toBe(false);
    expect(
      existsSync(path.join(projectRoot, '.claude/skills/bdboard-harness/references/new.md')),
    ).toBe(true);
    expect(manifest.packs[0]?.files).toEqual([
      '.claude/skills/bdboard-harness/SKILL.md',
      '.claude/skills/bdboard-harness/references/new.md',
    ]);
  });

  it('preserves manifest entries for other packs', async () => {
    const injector = setupFixture();
    writePack('alpha-pack', '1.0.0', { 'SKILL.md': '# alpha' });
    writePack('beta-pack', '1.0.0', { 'SKILL.md': '# beta' });

    await injector.injectPack(
      projectRoot,
      {
        name: 'alpha-pack',
        version: '1.0.0',
        description: 'alpha',
        files: [{ relativePath: 'SKILL.md' }],
      },
      new Date('2026-08-16T09:00:00.000Z'),
    );

    const manifest = await injector.injectPack(
      projectRoot,
      {
        name: 'beta-pack',
        version: '1.0.0',
        description: 'beta',
        files: [{ relativePath: 'SKILL.md' }],
      },
      new Date('2026-08-16T10:00:00.000Z'),
    );

    expect(manifest.packs).toEqual([
      {
        name: 'alpha-pack',
        version: '1.0.0',
        injectedAt: '2026-08-16T09:00:00.000Z',
        files: ['.claude/skills/alpha-pack/SKILL.md'],
      },
      {
        name: 'beta-pack',
        version: '1.0.0',
        injectedAt: '2026-08-16T10:00:00.000Z',
        files: ['.claude/skills/beta-pack/SKILL.md'],
      },
    ]);
  });

  it('rejects stale removal paths outside .claude/', async () => {
    const injector = setupFixture();
    writePack('evil-pack', '1.0.0', { 'SKILL.md': '# evil' });
    const manifestPath = path.join(projectRoot, '.claude/bdboard-packs.json');
    mkdirSync(path.dirname(manifestPath), { recursive: true });
    writeFileSync(
      manifestPath,
      JSON.stringify({
        packs: [
          {
            name: 'evil-pack',
            version: '0.9.0',
            injectedAt: '2026-08-16T00:00:00.000Z',
            files: ['src/escape.txt'],
          },
        ],
      }),
      'utf8',
    );
    mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
    writeFileSync(path.join(projectRoot, 'src/escape.txt'), 'secret', 'utf8');

    await expect(
      injector.injectPack(
        projectRoot,
        {
          name: 'evil-pack',
          version: '1.0.0',
          description: 'evil',
          files: [{ relativePath: 'SKILL.md' }],
        },
        new Date('2026-08-16T10:00:00.000Z'),
      ),
    ).rejects.toBeInstanceOf(HarnessPathTraversalError);
    expect(existsSync(path.join(projectRoot, 'src/escape.txt'))).toBe(true);
  });

  it('rejects pack file paths that escape the destination tree', async () => {
    const injector = setupFixture();
    writePack('evil-pack', '1.0.0', { 'SKILL.md': '# evil' });

    await expect(
      injector.injectPack(
        projectRoot,
        {
          name: 'evil-pack',
          version: '1.0.0',
          description: 'evil',
          files: [{ relativePath: '../outside.md' }],
        },
        new Date('2026-08-16T10:00:00.000Z'),
      ),
    ).rejects.toBeInstanceOf(HarnessPathTraversalError);
    expect(existsSync(path.join(projectRoot, 'outside.md'))).toBe(false);
  });

  it('returns empty manifest when manifest file is missing or invalid', async () => {
    const injector = setupFixture();
    expect(await injector.readManifest(projectRoot)).toEqual({ packs: [] });

    mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
    writeFileSync(path.join(projectRoot, '.claude/bdboard-packs.json'), '{bad', 'utf8');
    expect(await injector.readManifest(projectRoot)).toEqual({ packs: [] });
  });
});
