import { describe, expect, it } from 'vitest';
import { getProjectHarnessStatus } from './get-project-harness-status.js';
import type { PackRegistryPort } from '../ports/pack-registry.js';

function fakeRegistry(
  packs: readonly { name: string; version: string; description?: string }[],
): PackRegistryPort {
  return {
    async listPacks() {
      return packs.map((pack) => ({
        name: pack.name,
        version: pack.version,
        description: pack.description ?? '',
      }));
    },
    async getPack(name) {
      const pack = packs.find((candidate) => candidate.name === name);
      if (pack === undefined) {
        return undefined;
      }
      return {
        name: pack.name,
        version: pack.version,
        description: pack.description ?? '',
        files: [],
      };
    },
  };
}

describe('getProjectHarnessStatus', () => {
  it('reports drift when installed version differs from available', async () => {
    const status = await getProjectHarnessStatus(
      fakeRegistry([{ name: 'bdboard-harness', version: '0.2.0' }]),
      {
        packs: [
          {
            name: 'bdboard-harness',
            version: '0.1.0',
            injectedAt: '2026-08-16T00:00:00.000Z',
            files: ['.claude/skills/bdboard-harness/SKILL.md'],
          },
        ],
      },
    );

    expect(status.packs).toEqual([
      {
        name: 'bdboard-harness',
        availableVersion: '0.2.0',
        installedVersion: '0.1.0',
        drift: true,
      },
    ]);
  });

  it('reports no drift when versions match', async () => {
    const status = await getProjectHarnessStatus(
      fakeRegistry([{ name: 'bdboard-harness', version: '0.1.0' }]),
      {
        packs: [
          {
            name: 'bdboard-harness',
            version: '0.1.0',
            injectedAt: '2026-08-16T00:00:00.000Z',
            files: [],
          },
        ],
      },
    );

    expect(status.packs[0]?.drift).toBe(false);
    expect(status.packs[0]?.installedVersion).toBe('0.1.0');
  });

  it('keeps other installed packs out of registry listing', async () => {
    const status = await getProjectHarnessStatus(
      fakeRegistry([{ name: 'bdboard-harness', version: '0.1.0' }]),
      {
        packs: [
          {
            name: 'other-pack',
            version: '9.9.9',
            injectedAt: '2026-08-16T00:00:00.000Z',
            files: [],
          },
        ],
      },
    );

    expect(status.packs).toEqual([
      {
        name: 'bdboard-harness',
        availableVersion: '0.1.0',
        installedVersion: null,
        drift: false,
      },
    ]);
  });

  it('lists multiple available packs independently', async () => {
    const status = await getProjectHarnessStatus(
      fakeRegistry([
        { name: 'alpha-pack', version: '1.0.0' },
        { name: 'beta-pack', version: '2.0.0' },
      ]),
      {
        packs: [
          {
            name: 'beta-pack',
            version: '1.0.0',
            injectedAt: '2026-08-16T00:00:00.000Z',
            files: [],
          },
        ],
      },
    );

    expect(status.packs).toEqual([
      {
        name: 'alpha-pack',
        availableVersion: '1.0.0',
        installedVersion: null,
        drift: false,
      },
      {
        name: 'beta-pack',
        availableVersion: '2.0.0',
        installedVersion: '1.0.0',
        drift: true,
      },
    ]);
  });
});
