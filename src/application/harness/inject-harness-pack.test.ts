import { describe, expect, it, vi } from 'vitest';
import { injectHarnessPack } from './inject-harness-pack.js';
import type { HarnessInjectorPort } from '../ports/harness-injector.js';
import type { PackRegistryPort } from '../ports/pack-registry.js';

describe('injectHarnessPack', () => {
  it('returns pack-not-found when registry has no pack', async () => {
    const registry: PackRegistryPort = {
      listPacks: vi.fn(async () => []),
      getPack: vi.fn(async () => undefined),
    };
    const injector: HarnessInjectorPort = {
      readManifest: vi.fn(async () => ({ packs: [] })),
      injectPack: vi.fn(),
    };

    const result = await injectHarnessPack(
      { registry, injector, now: () => new Date('2026-08-16T00:00:00.000Z') },
      '/tmp/project',
      'missing-pack',
    );

    expect(result).toEqual({ ok: false, failure: { kind: 'pack-not-found' } });
    expect(injector.injectPack).not.toHaveBeenCalled();
  });

  it('delegates to injector and returns manifest on success', async () => {
    const manifest = {
      packs: [
        {
          name: 'bdboard-harness',
          version: '0.1.0',
          injectedAt: '2026-08-16T00:00:00.000Z',
          files: ['.claude/skills/bdboard-harness/SKILL.md'],
        },
      ],
    };

    const registry: PackRegistryPort = {
      listPacks: vi.fn(async () => []),
      getPack: vi.fn(async () => ({
        name: 'bdboard-harness',
        version: '0.1.0',
        description: 'test',
        files: [{ relativePath: 'SKILL.md' }],
      })),
    };
    const injector: HarnessInjectorPort = {
      readManifest: vi.fn(async () => ({ packs: [] })),
      injectPack: vi.fn(async () => manifest),
    };

    const now = new Date('2026-08-16T00:00:00.000Z');
    const result = await injectHarnessPack(
      { registry, injector, now: () => now },
      '/tmp/project',
      'bdboard-harness',
    );

    expect(result).toEqual({ ok: true, manifest });
    expect(injector.injectPack).toHaveBeenCalledWith(
      '/tmp/project',
      expect.objectContaining({ name: 'bdboard-harness' }),
      now,
    );
  });
});
