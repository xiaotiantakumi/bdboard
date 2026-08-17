import { describe, expect, it, vi } from 'vitest';
import { getAllProjectsHarnessStatus } from './get-all-projects-harness-status.js';
import type { HarnessInjectorPort } from '../ports/harness-injector.js';
import type { PackRegistryPort } from '../ports/pack-registry.js';
import type { Project } from '../../domain/project.js';

function project(id: string, rootPath: string): Project {
  return {
    id,
    name: id,
    rootPath,
    prefixes: ['bdboard'],
    aliasPaths: [],
  };
}

function fakeRegistry(
  packs: readonly { name: string; version: string; description?: string }[],
): PackRegistryPort {
  const listPacks = vi.fn(async () =>
    packs.map((pack) => ({
      name: pack.name,
      version: pack.version,
      description: pack.description ?? '',
    })),
  );

  return {
    listPacks,
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

describe('getAllProjectsHarnessStatus', () => {
  it('loads available packs once and returns status for every project', async () => {
    const registry = fakeRegistry([{ name: 'bdboard-harness', version: '0.2.0' }]);
    const injector: HarnessInjectorPort = {
      readManifest: vi.fn(async (rootPath: string) => {
        if (rootPath === '/tmp/proj-a') {
          return {
            packs: [
              {
                name: 'bdboard-harness',
                version: '0.1.0',
                injectedAt: '2026-08-16T00:00:00.000Z',
                files: [],
              },
            ],
          };
        }
        return {
          packs: [
            {
              name: 'bdboard-harness',
              version: '0.2.0',
              injectedAt: '2026-08-16T00:00:00.000Z',
              files: [],
            },
          ],
        };
      }),
      injectPack: vi.fn(),
    };

    const statuses = await getAllProjectsHarnessStatus({
      registry,
      injector,
      projects: [project('/tmp/proj-a', '/tmp/proj-a'), project('/tmp/proj-b', '/tmp/proj-b')],
    });

    expect(registry.listPacks).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual([
      {
        projectId: '/tmp/proj-a',
        status: {
          packs: [
            {
              name: 'bdboard-harness',
              availableVersion: '0.2.0',
              installedVersion: '0.1.0',
              drift: true,
            },
          ],
        },
      },
      {
        projectId: '/tmp/proj-b',
        status: {
          packs: [
            {
              name: 'bdboard-harness',
              availableVersion: '0.2.0',
              installedVersion: '0.2.0',
              drift: false,
            },
          ],
        },
      },
    ]);
  });

  it('returns an empty list when there are no projects', async () => {
    const registry = fakeRegistry([{ name: 'bdboard-harness', version: '0.1.0' }]);
    const injector: HarnessInjectorPort = {
      readManifest: vi.fn(),
      injectPack: vi.fn(),
    };

    const statuses = await getAllProjectsHarnessStatus({
      registry,
      injector,
      projects: [],
    });

    expect(registry.listPacks).toHaveBeenCalledTimes(1);
    expect(injector.readManifest).not.toHaveBeenCalled();
    expect(statuses).toEqual([]);
  });
});
