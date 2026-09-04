import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  getProjectHarnessStatus,
  resolveProjectContractState,
} from './get-project-harness-status.js';
import type { ContractState } from '../../domain/harness-contract.js';
import type { HarnessManifest } from '../../domain/harness-pack.js';
import type { HarnessContractReaderPort } from '../ports/harness-contract-reader.js';
import type { PackRegistryPort } from '../ports/pack-registry.js';

const NOT_APPLICABLE: ContractState = { state: 'not-applicable' };

const INJECTED_MANIFEST: HarnessManifest = {
  packs: [
    {
      name: 'bdboard-harness',
      version: '0.1.0',
      injectedAt: '2026-09-04T00:00:00.000Z',
      files: [],
    },
  ],
};

function fakeContractReader(options: {
  readonly contract?: string | null;
  readonly scriptsByPath?: Readonly<Record<string, readonly string[] | null>>;
}): HarnessContractReaderPort {
  return {
    readContract: vi.fn(async () => options.contract ?? null),
    readPackageScripts: vi.fn(
      async (packageRootPath: string) =>
        options.scriptsByPath?.[packageRootPath] ?? null,
    ),
  };
}

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
      NOT_APPLICABLE,
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
      NOT_APPLICABLE,
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
      NOT_APPLICABLE,
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
      NOT_APPLICABLE,
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

describe('resolveProjectContractState', () => {
  it('returns not-applicable for a project with no injected pack, without touching the disk', async () => {
    const reader = fakeContractReader({ contract: '{"version":1}' });

    const state = await resolveProjectContractState(reader, '/tmp/proj', {
      packs: [],
    });

    expect(state).toEqual({ state: 'not-applicable' });
    expect(reader.readContract).not.toHaveBeenCalled();
    expect(reader.readPackageScripts).not.toHaveBeenCalled();
  });

  it('returns missing when an injected project has no contract file', async () => {
    const reader = fakeContractReader({ contract: null });

    const state = await resolveProjectContractState(
      reader,
      '/tmp/proj',
      INJECTED_MANIFEST,
    );

    expect(state).toEqual({ state: 'missing' });
    expect(reader.readPackageScripts).not.toHaveBeenCalled();
  });

  it('returns invalid for a broken contract file', async () => {
    const reader = fakeContractReader({ contract: '{ broken' });

    const state = await resolveProjectContractState(
      reader,
      '/tmp/proj',
      INJECTED_MANIFEST,
    );

    expect(state.state).toBe('invalid');
  });

  it('returns ok when the declared npm script exists in the project package.json', async () => {
    const reader = fakeContractReader({
      contract: JSON.stringify({ version: 1, verify: 'npm run verify', prFlow: 'pr' }),
      scriptsByPath: { '/tmp/proj': ['verify'] },
    });

    const state = await resolveProjectContractState(
      reader,
      '/tmp/proj',
      INJECTED_MANIFEST,
    );

    expect(state).toEqual({
      state: 'ok',
      verify: 'npm run verify',
      prFlow: 'pr',
      mainBranch: 'main',
    });
    expect(reader.readPackageScripts).toHaveBeenCalledWith('/tmp/proj');
  });

  it('reads the package.json of the --prefix directory', async () => {
    // 実装は path.join で解決するので、期待値も同じ関数で組み立てる。
    // リテラルの '/tmp/proj/web' は Windows で '\\tmp\\proj\\web' と食い違う
    // (しかもキー側が外れると「読めなかった = 判定不能 = ok」に倒れて、
    // state だけ見るアサーションは通ってしまう)。
    const prefixedRoot = path.join('/tmp/proj', 'web');
    const reader = fakeContractReader({
      contract: JSON.stringify({
        version: 1,
        verify: 'npm --prefix web run build:web',
        prFlow: 'pr',
      }),
      scriptsByPath: { [prefixedRoot]: ['build:web'] },
    });

    const state = await resolveProjectContractState(
      reader,
      '/tmp/proj',
      INJECTED_MANIFEST,
    );

    expect(reader.readPackageScripts).toHaveBeenCalledWith(prefixedRoot);
    expect(state.state).toBe('ok');
  });

  it('returns command-missing when the declared npm script is absent', async () => {
    const reader = fakeContractReader({
      contract: JSON.stringify({ version: 1, verify: 'npm run verify', prFlow: 'pr' }),
      scriptsByPath: { '/tmp/proj': ['build'] },
    });

    const state = await resolveProjectContractState(
      reader,
      '/tmp/proj',
      INJECTED_MANIFEST,
    );

    expect(state).toEqual({
      state: 'command-missing',
      script: 'verify',
      verify: 'npm run verify',
    });
  });

  it('does not read a package.json for a non-npm verify command', async () => {
    const reader = fakeContractReader({
      contract: JSON.stringify({ version: 1, verify: 'make verify', prFlow: 'direct' }),
    });

    const state = await resolveProjectContractState(
      reader,
      '/tmp/proj',
      INJECTED_MANIFEST,
    );

    expect(state.state).toBe('ok');
    expect(reader.readPackageScripts).not.toHaveBeenCalled();
  });
});
