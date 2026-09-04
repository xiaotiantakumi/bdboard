import { describe, expect, it, vi } from 'vitest';
import { getAllProjectsHarnessStatus } from './get-all-projects-harness-status.js';
import type { ContractState } from '../../domain/harness-contract.js';
import type { HarnessContractReaderPort } from '../ports/harness-contract-reader.js';
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

function fakeContractReader(
  contractsByRoot: Readonly<Record<string, string>> = {},
  scriptsByRoot: Readonly<Record<string, readonly string[]>> = {},
): HarnessContractReaderPort {
  return {
    readContract: vi.fn(async (rootPath: string) => contractsByRoot[rootPath] ?? null),
    readPackageScripts: vi.fn(async (rootPath: string) => scriptsByRoot[rootPath] ?? null),
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

const MISSING_CONTRACT: ContractState = { state: 'missing' };

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
      contractReader: fakeContractReader(),
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
          contract: MISSING_CONTRACT,
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
          contract: MISSING_CONTRACT,
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
      contractReader: fakeContractReader(),
      projects: [],
    });

    expect(registry.listPacks).toHaveBeenCalledTimes(1);
    expect(injector.readManifest).not.toHaveBeenCalled();
    expect(statuses).toEqual([]);
  });
  it('does not warn about the contract for projects with no injected pack', async () => {
    // bd 運用プロジェクトの多くは未注入。そこへ「検証ループ未定義」を一斉に
    // 出すと Hygiene が無視される警告で埋まるので、未注入は not-applicable に倒す。
    const registry = fakeRegistry([{ name: 'bdboard-harness', version: '0.2.0' }]);
    const injector: HarnessInjectorPort = {
      readManifest: vi.fn(async (rootPath: string) =>
        rootPath === '/tmp/injected'
          ? {
              packs: [
                {
                  name: 'bdboard-harness',
                  version: '0.2.0',
                  injectedAt: '2026-09-04T00:00:00.000Z',
                  files: [],
                },
              ],
            }
          : { packs: [] },
      ),
      injectPack: vi.fn(),
    };
    const contractReader = fakeContractReader();

    const statuses = await getAllProjectsHarnessStatus({
      registry,
      injector,
      contractReader,
      projects: [
        project('/tmp/injected', '/tmp/injected'),
        project('/tmp/untouched', '/tmp/untouched'),
      ],
    });

    expect(statuses.map((entry) => entry.status.contract)).toEqual([
      { state: 'missing' },
      { state: 'not-applicable' },
    ]);
    expect(contractReader.readContract).toHaveBeenCalledTimes(1);
    expect(contractReader.readContract).toHaveBeenCalledWith('/tmp/injected');
  });

  it('evaluates the contract per project root', async () => {
    const registry = fakeRegistry([{ name: 'bdboard-harness', version: '0.2.0' }]);
    const injector: HarnessInjectorPort = {
      readManifest: vi.fn(async () => ({
        packs: [
          {
            name: 'bdboard-harness',
            version: '0.2.0',
            injectedAt: '2026-09-04T00:00:00.000Z',
            files: [],
          },
        ],
      })),
      injectPack: vi.fn(),
    };
    const contractReader = fakeContractReader(
      {
        '/tmp/ok': JSON.stringify({
          version: 1,
          verify: 'npm run verify',
          prFlow: 'pr',
        }),
        '/tmp/broken': '{ broken',
      },
      { '/tmp/ok': ['verify'] },
    );

    const statuses = await getAllProjectsHarnessStatus({
      registry,
      injector,
      contractReader,
      projects: [project('/tmp/ok', '/tmp/ok'), project('/tmp/broken', '/tmp/broken')],
    });

    expect(statuses[0]?.status.contract).toEqual({
      state: 'ok',
      verify: 'npm run verify',
      prFlow: 'pr',
      mainBranch: 'main',
    });
    expect(statuses[1]?.status.contract.state).toBe('invalid');
  });
});
