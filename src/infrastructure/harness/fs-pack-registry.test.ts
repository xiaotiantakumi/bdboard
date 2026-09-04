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
        hooks: [],
      },
    ]);

    const pack = await registry.getPack('bdboard-harness');
    expect(pack?.files.map((file) => file.relativePath)).toEqual([
      'SKILL.md',
      'references/a.md',
    ]);
  });

  it('reads hook declarations, defaulting timeout and matcher', async () => {
    const registry = makeRegistry();
    const packDir = path.join(packsRoot, 'hooked-pack');
    mkdirSync(path.join(packDir, 'hooks'), { recursive: true });
    writeFileSync(
      path.join(packDir, 'pack.json'),
      JSON.stringify({
        name: 'hooked-pack',
        version: '0.1.0',
        description: 'hooked',
        hooks: [
          { event: 'PreToolUse', matcher: 'Bash', script: 'hooks/a.sh', timeout: 25 },
          { event: 'Stop', script: 'hooks/b.sh' },
        ],
      }),
      'utf8',
    );
    writeFileSync(path.join(packDir, 'hooks', 'a.sh'), '#!/bin/sh\n', 'utf8');
    writeFileSync(path.join(packDir, 'hooks', 'b.sh'), '#!/bin/sh\n', 'utf8');

    const pack = await registry.getPack('hooked-pack');
    expect(pack?.hooks).toEqual([
      { event: 'PreToolUse', matcher: 'Bash', script: 'hooks/a.sh', timeout: 25 },
      { event: 'Stop', matcher: '', script: 'hooks/b.sh', timeout: 10 },
    ]);
  });

  it.each([
    ['hooks is not an array', { hooks: {} }],
    ['event is missing', { hooks: [{ script: 'hooks/a.sh' }] }],
    ['script is outside hooks/', { hooks: [{ event: 'Stop', script: 'SKILL.md' }] }],
    ['script escapes the pack', { hooks: [{ event: 'Stop', script: 'hooks/../x.sh' }] }],
    [
      'timeout is not a positive integer',
      { hooks: [{ event: 'Stop', script: 'hooks/a.sh', timeout: 0 }] },
    ],
  ])('rejects the whole pack when %s', async (_name, extra) => {
    // 原本の typo で機械ガードが黙って無効になるより、パックが見えないほうがよい。
    const registry = makeRegistry();
    const packDir = path.join(packsRoot, 'broken-pack');
    mkdirSync(packDir, { recursive: true });
    writeFileSync(
      path.join(packDir, 'pack.json'),
      JSON.stringify({
        name: 'broken-pack',
        version: '0.1.0',
        description: 'broken',
        ...extra,
      }),
      'utf8',
    );

    expect(await registry.getPack('broken-pack')).toBeUndefined();
    expect(await registry.listPacks()).toEqual([]);
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
    });
    expect(pack?.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pack?.files.some((file) => file.relativePath === 'SKILL.md')).toBe(true);
    expect(
      pack?.files.some((file) => file.relativePath === 'references/worktree-pr-flow.md'),
    ).toBe(true);
  });

  it('declares the three machine guards as hooks', async () => {
    const repoRoot = path.resolve(import.meta.dirname, '../../..');
    const registry = createFsPackRegistry(path.join(repoRoot, 'harness', 'packs'));
    const pack = await registry.getPack('bdboard-harness');

    expect(pack?.hooks.map((hook) => [hook.event, hook.script])).toEqual([
      ['PreToolUse', 'hooks/pre-bash-guard.sh'],
      ['PreToolUse', 'hooks/pre-edit-guard.sh'],
      ['Stop', 'hooks/stop-ticket-gate.sh'],
    ]);
    // 宣言されたスクリプトは必ずパックに同梱されている。
    for (const hook of pack?.hooks ?? []) {
      expect(pack?.files.some((file) => file.relativePath === hook.script)).toBe(true);
    }
    // timeout は必ず有限。Claude Code 既定の 600 秒に落とさない (pkr6.1 M3)。
    for (const hook of pack?.hooks ?? []) {
      expect(hook.timeout).toBeGreaterThan(0);
      expect(hook.timeout).toBeLessThanOrEqual(120);
    }
  });
});
