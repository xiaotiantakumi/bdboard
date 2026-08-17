import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFsPackRegistry } from './fs-pack-registry.js';

describe('createFsPackRegistry', () => {
  let tmpDir: string;
  let packsRoot: string;

  afterEach(() => {
    if (tmpDir !== undefined) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function makeRegistry(): ReturnType<typeof createFsPackRegistry> {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'bdboard-pack-registry-'));
    packsRoot = path.join(tmpDir, 'packs');
    mkdirSync(packsRoot, { recursive: true });
    return createFsPackRegistry(packsRoot);
  }

  it('lists packs from harness/packs layout', async () => {
    const registry = makeRegistry();
    const packDir = path.join(packsRoot, 'bdboard-harness');
    mkdirSync(path.join(packDir, 'references'), { recursive: true });
    writeFileSync(
      path.join(packDir, 'pack.json'),
      JSON.stringify({
        name: 'bdboard-harness',
        version: '0.1.0',
        description: 'test pack',
      }),
      'utf8',
    );
    writeFileSync(path.join(packDir, 'SKILL.md'), '# skill', 'utf8');
    writeFileSync(path.join(packDir, 'references', 'a.md'), 'ref', 'utf8');

    const packs = await registry.listPacks();
    expect(packs).toEqual([
      {
        name: 'bdboard-harness',
        version: '0.1.0',
        description: 'test pack',
      },
    ]);

    const pack = await registry.getPack('bdboard-harness');
    expect(pack?.files.map((file) => file.relativePath)).toEqual([
      'SKILL.md',
      'references/a.md',
    ]);
  });

  it('excludes pack.json from file listing', async () => {
    const registry = makeRegistry();
    const packDir = path.join(packsRoot, 'sample-pack');
    mkdirSync(packDir, { recursive: true });
    writeFileSync(
      path.join(packDir, 'pack.json'),
      JSON.stringify({
        name: 'sample-pack',
        version: '1.0.0',
        description: 'sample',
      }),
      'utf8',
    );
    writeFileSync(path.join(packDir, 'SKILL.md'), '# skill', 'utf8');

    const pack = await registry.getPack('sample-pack');
    expect(pack?.files).toEqual([{ relativePath: 'SKILL.md' }]);
    expect(pack?.files.some((file) => file.relativePath === 'pack.json')).toBe(false);
  });
});

describe('createFsPackRegistry (repo fixture)', () => {
  it('reads the real bdboard-harness pack', async () => {
    const repoRoot = path.resolve(import.meta.dirname, '../../..');
    const registry = createFsPackRegistry(path.join(repoRoot, 'harness', 'packs'));
    const pack = await registry.getPack('bdboard-harness');

    expect(pack).toMatchObject({
      name: 'bdboard-harness',
      version: '0.1.1',
    });
    expect(pack?.files.some((file) => file.relativePath === 'SKILL.md')).toBe(true);
    expect(
      pack?.files.some((file) => file.relativePath === 'references/worktree-pr-flow.md'),
    ).toBe(true);
  });
});
