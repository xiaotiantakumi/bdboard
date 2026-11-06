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
      readSettings: vi.fn(async () => [null, null]),
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
        hooks: [],
        role: 'base' as const,
        requires: [],
        files: [{ relativePath: 'SKILL.md' }],
      })),
    };
    const injector: HarnessInjectorPort = {
      readSettings: vi.fn(async () => [null, null]),
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

  describe('role/requires combination check', () => {
    const baseSummary = {
      name: 'base-pack',
      version: '1.0.0',
      description: '',
      hooks: [],
      role: 'base' as const,
      requires: [] as string[],
    };
    const optionalSummary = {
      ...baseSummary,
      name: 'video-pack',
      role: 'optional' as const,
      requires: ['base-pack'],
    };

    function setup(installed: string[]) {
      const registry: PackRegistryPort = {
        listPacks: vi.fn(async () => [baseSummary, optionalSummary]),
        getPack: vi.fn(async (name: string) => {
          const summary = [baseSummary, optionalSummary].find((p) => p.name === name);
          return summary === undefined ? undefined : { ...summary, files: [] };
        }),
      };
      const injector: HarnessInjectorPort = {
        readSettings: vi.fn(async () => null),
        readManifest: vi.fn(async () => ({
          packs: installed.map((name) => ({
            name,
            version: '1.0.0',
            injectedAt: '2026-11-06T00:00:00.000Z',
            files: [],
          })),
        })),
        injectPack: vi.fn(async () => ({ packs: [] })),
      };
      return { registry, injector };
    }

    it('rejects an optional pack when its base is not injected, without writing anything', async () => {
      const { registry, injector } = setup([]);

      const result = await injectHarnessPack(
        { registry, injector, now: () => new Date('2026-11-06T00:00:00.000Z') },
        '/tmp/project',
        'video-pack',
      );

      expect(result).toMatchObject({
        ok: false,
        failure: { kind: 'not-injectable', code: 'requires-not-injected' },
      });
      expect(injector.injectPack).not.toHaveBeenCalled();
    });

    it('injects an optional pack once its base is in the injection record', async () => {
      const { registry, injector } = setup(['base-pack']);

      const result = await injectHarnessPack(
        { registry, injector, now: () => new Date('2026-11-06T00:00:00.000Z') },
        '/tmp/project',
        'video-pack',
      );

      expect(result.ok).toBe(true);
      expect(injector.injectPack).toHaveBeenCalledTimes(1);
    });

    it('rejects a base pack that declares requires', async () => {
      const registry: PackRegistryPort = {
        listPacks: vi.fn(async () => []),
        getPack: vi.fn(async () => ({
          ...baseSummary,
          requires: ['other'],
          files: [],
        })),
      };
      const injector: HarnessInjectorPort = {
        readSettings: vi.fn(async () => null),
        readManifest: vi.fn(async () => ({ packs: [] })),
        injectPack: vi.fn(),
      };

      const result = await injectHarnessPack(
        { registry, injector, now: () => new Date() },
        '/tmp/project',
        'base-pack',
      );

      expect(result).toMatchObject({
        ok: false,
        failure: { kind: 'not-injectable', code: 'base-has-requires' },
      });
      expect(injector.injectPack).not.toHaveBeenCalled();
    });
  });
});
