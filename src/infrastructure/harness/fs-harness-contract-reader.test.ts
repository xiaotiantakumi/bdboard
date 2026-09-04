import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HARNESS_CONTRACT_RELATIVE_PATH } from '../../domain/harness-contract.js';
import { createFsHarnessContractReader } from './fs-harness-contract-reader.js';

describe('createFsHarnessContractReader', () => {
  let tmpDir: string;
  let projectRoot: string;

  afterEach(() => {
    if (tmpDir !== undefined) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function setupFixture(): void {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'bdboard-harness-contract-'));
    projectRoot = path.join(tmpDir, 'project');
    mkdirSync(projectRoot, { recursive: true });
  }

  function writeProjectFile(relativePath: string, content: string): void {
    const absolute = path.join(projectRoot, relativePath);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
  }

  describe('readContract', () => {
    it('returns the contract body when the file exists', async () => {
      setupFixture();
      writeProjectFile(HARNESS_CONTRACT_RELATIVE_PATH, '{"version":1}');

      const reader = createFsHarnessContractReader();

      expect(await reader.readContract(projectRoot)).toBe('{"version":1}');
    });

    it('returns null when the file does not exist', async () => {
      setupFixture();

      const reader = createFsHarnessContractReader();

      expect(await reader.readContract(projectRoot)).toBeNull();
    });

    it('returns null when the project root does not exist at all', async () => {
      setupFixture();

      const reader = createFsHarnessContractReader();

      expect(await reader.readContract(path.join(tmpDir, 'missing'))).toBeNull();
    });
  });

  describe('readPackageScripts', () => {
    it('returns the script names of the package.json in that directory', async () => {
      setupFixture();
      writeProjectFile(
        'package.json',
        JSON.stringify({ scripts: { verify: 'x', build: 'y' } }),
      );

      const reader = createFsHarnessContractReader();

      expect(await reader.readPackageScripts(projectRoot)).toEqual(['verify', 'build']);
    });

    it('resolves a nested package directory (npm --prefix web)', async () => {
      setupFixture();
      writeProjectFile('package.json', JSON.stringify({ scripts: { verify: 'x' } }));
      writeProjectFile('web/package.json', JSON.stringify({ scripts: { 'build:web': 'y' } }));

      const reader = createFsHarnessContractReader();

      expect(await reader.readPackageScripts(path.join(projectRoot, 'web'))).toEqual([
        'build:web',
      ]);
    });

    it('returns an empty list when package.json has no scripts', async () => {
      setupFixture();
      writeProjectFile('package.json', JSON.stringify({ name: 'x' }));

      const reader = createFsHarnessContractReader();

      expect(await reader.readPackageScripts(projectRoot)).toEqual([]);
    });

    it("returns 'absent' when package.json does not exist", async () => {
      setupFixture();

      const reader = createFsHarnessContractReader();

      expect(await reader.readPackageScripts(projectRoot)).toBe('absent');
    });

    it("returns 'absent' when the package directory does not exist", async () => {
      setupFixture();

      const reader = createFsHarnessContractReader();

      expect(await reader.readPackageScripts(path.join(projectRoot, 'nope'))).toBe(
        'absent',
      );
    });

    it('returns null when package.json exists but is not valid JSON', async () => {
      // 「無い」ではなく「読めない」= 判定不能。呼び出し側はこれで警告しない。
      setupFixture();
      writeProjectFile('package.json', '{ broken');

      const reader = createFsHarnessContractReader();

      expect(await reader.readPackageScripts(projectRoot)).toBeNull();
    });

    it('returns null when scripts is not an object', async () => {
      setupFixture();
      writeProjectFile('package.json', JSON.stringify({ scripts: ['verify'] }));

      const reader = createFsHarnessContractReader();

      expect(await reader.readPackageScripts(projectRoot)).toBeNull();
    });
  });
});
