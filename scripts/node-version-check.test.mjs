// bdboard-qoxg: node-version-check.mjs (always-on-server.sh の停止前 node 版ゲート) のテスト。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { EXIT_OK, EXIT_SHORTFALL, findNvmNodeBin, formatShortfallLines } from './node-version-check.mjs';

const script = fileURLToPath(new URL('./node-version-check.mjs', import.meta.url));

const tempDirs = [];
const makeTempDir = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

// nvm 風の <nvmDir>/versions/node/<version>/bin/node を作る (中身は空のファイルで足りる)。
const makeNvmDir = (versions) => {
  const nvmDir = makeTempDir('node-check-nvm-');
  for (const version of versions) {
    const binDir = path.join(nvmDir, 'versions', 'node', version, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'node'), '');
  }
  return nvmDir;
};

const binOf = (nvmDir, version) => path.join(nvmDir, 'versions', 'node', version, 'bin');

const makeRepo = ({ engines, nvmrc }) => {
  const repo = makeTempDir('node-check-repo-');
  const pkg = engines === undefined ? {} : { engines: { node: engines } };
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify(pkg));
  if (nvmrc !== undefined) {
    fs.writeFileSync(path.join(repo, '.nvmrc'), `${nvmrc}\n`);
  }
  return repo;
};

const runCheck = (repo, env = {}) => {
  const { NVM_DIR, ...rest } = process.env;
  const result = spawnSync(process.execPath, [script, repo], {
    encoding: 'utf8',
    env: { ...rest, HOME: makeTempDir('node-check-home-'), ...env },
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};

describe('findNvmNodeBin', () => {
  it('returns the bin of the highest version that satisfies the range', () => {
    const nvmDir = makeNvmDir(['v14.15.0', 'v22.13.0', 'v22.14.0', 'v20.12.2']);
    expect(findNvmNodeBin({ range: '>=22.13.0', nvmrc: undefined, nvmDir })).toBe(binOf(nvmDir, 'v22.14.0'));
  });

  it('prefers the .nvmrc major over a higher major', () => {
    const nvmDir = makeNvmDir(['v22.14.0', 'v24.1.0']);
    expect(findNvmNodeBin({ range: '>=22.13.0', nvmrc: '22', nvmDir })).toBe(binOf(nvmDir, 'v22.14.0'));
    expect(findNvmNodeBin({ range: '>=22.13.0', nvmrc: 'v24', nvmDir })).toBe(binOf(nvmDir, 'v24.1.0'));
  });

  it('ignores the .nvmrc major when no satisfying candidate has it, or when it is not a version', () => {
    const nvmDir = makeNvmDir(['v22.14.0']);
    expect(findNvmNodeBin({ range: '>=22.13.0', nvmrc: '24', nvmDir })).toBe(binOf(nvmDir, 'v22.14.0'));
    expect(findNvmNodeBin({ range: '>=22.13.0', nvmrc: 'lts/*', nvmDir })).toBe(binOf(nvmDir, 'v22.14.0'));
  });

  it('skips versions without bin/node and versions that do not satisfy the range', () => {
    const nvmDir = makeNvmDir(['v14.15.0', 'v22.9.0']);
    fs.mkdirSync(path.join(nvmDir, 'versions', 'node', 'v22.14.0'), { recursive: true });
    expect(findNvmNodeBin({ range: '>=22.13.0', nvmrc: '22', nvmDir })).toBeNull();
  });

  it('returns null instead of throwing when the nvm directory is missing', () => {
    const missing = path.join(makeTempDir('node-check-missing-'), 'no-such-nvm');
    expect(findNvmNodeBin({ range: '>=22.13.0', nvmrc: '22', nvmDir: missing })).toBeNull();
  });
});

describe('formatShortfallLines', () => {
  it('names the required range, the current node, and the nvm bin to use', () => {
    const text = formatShortfallLines({
      current: '14.15.0',
      nodePath: '/old/bin/node',
      required: '>=22.13.0',
      nvmrc: '22',
      nvmBin: '/nvm/v22/bin',
    }).join('\n');
    expect(text).toContain('>=22.13.0');
    expect(text).toContain('v14.15.0 (/old/bin/node)');
    expect(text).toContain('使うべき node: /nvm/v22/bin');
    expect(text).toContain('PATH は書き換えません');
  });

  it('falls back to the .nvmrc, then to a generic hint, when there is no nvm candidate', () => {
    const base = { current: '14.15.0', nodePath: '/old/bin/node', required: '>=22.13.0', nvmBin: null };
    expect(formatShortfallLines({ ...base, nvmrc: '22' }).join('\n')).toContain('.nvmrc (= 22)');
    const generic = formatShortfallLines({ ...base, nvmrc: undefined }).join('\n');
    expect(generic).toContain('PATH の先頭に置いて再実行してください');
    expect(generic).not.toContain('.nvmrc');
  });
});

describe('node-version-check.mjs CLI', () => {
  it('exits 3 with the requirement, the running node, and the nvm bin when node is too old', () => {
    const nvmDir = makeNvmDir(['v999.1.0']);
    const repo = makeRepo({ engines: '>=999.0.0', nvmrc: '999' });
    const result = runCheck(repo, { NVM_DIR: nvmDir });
    expect(result.status).toBe(EXIT_SHORTFALL);
    expect(result.stdout).toContain('>=999.0.0');
    expect(result.stdout).toContain(`v${process.versions.node}`);
    expect(result.stdout).toContain(`使うべき node: ${binOf(nvmDir, 'v999.1.0')}`);
  });

  it('falls back to $HOME/.nvm when NVM_DIR is not set', () => {
    const home = makeTempDir('node-check-home-');
    const nvmDir = path.join(home, '.nvm');
    fs.mkdirSync(path.join(binOf(nvmDir, 'v999.1.0')), { recursive: true });
    fs.writeFileSync(path.join(binOf(nvmDir, 'v999.1.0'), 'node'), '');
    const repo = makeRepo({ engines: '>=999.0.0' });
    const result = runCheck(repo, { HOME: home });
    expect(result.status).toBe(EXIT_SHORTFALL);
    expect(result.stdout).toContain(binOf(nvmDir, 'v999.1.0'));
  });

  it('exits 0 silently when the running node satisfies engines.node', () => {
    const result = runCheck(makeRepo({ engines: '>=1.0.0' }));
    expect(result.status).toBe(EXIT_OK);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('fails open when engines.node is absent, unreadable, or not in >=X.Y.Z form', () => {
    expect(runCheck(makeRepo({ engines: undefined })).status).toBe(EXIT_OK);
    expect(runCheck(makeRepo({ engines: '^999.0.0' })).status).toBe(EXIT_OK);
    const noPackage = makeTempDir('node-check-empty-');
    expect(runCheck(noPackage).status).toBe(EXIT_OK);
  });
});
