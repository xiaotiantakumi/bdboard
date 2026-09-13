// bdboard-eu2k: node-version-guard.mjs (verify の Node 版ガード) のテスト。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  checkNodeVersion,
  formatNodeVersionError,
  parseMinimumRange,
  parseNodeVersion,
  readEnginesNodeRange,
  satisfiesMinimum,
} from './node-version-guard.mjs';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));

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

describe('parseNodeVersion', () => {
  it('parses with and without the v prefix', () => {
    expect(parseNodeVersion('v14.15.0')).toEqual({ major: 14, minor: 15, patch: 0 });
    expect(parseNodeVersion('22.9.0')).toEqual({ major: 22, minor: 9, patch: 0 });
  });

  it('fills missing minor/patch with 0 and ignores prerelease', () => {
    expect(parseNodeVersion('22')).toEqual({ major: 22, minor: 0, patch: 0 });
    expect(parseNodeVersion('22.9')).toEqual({ major: 22, minor: 9, patch: 0 });
    expect(parseNodeVersion('22.9.0-pre')).toEqual({ major: 22, minor: 9, patch: 0 });
  });

  it('returns null for garbage', () => {
    expect(parseNodeVersion('lts/*')).toBeNull();
    expect(parseNodeVersion('')).toBeNull();
    expect(parseNodeVersion(undefined)).toBeNull();
  });
});

describe('parseMinimumRange', () => {
  it('accepts >= with optional whitespace and partial versions', () => {
    expect(parseMinimumRange('>=22.9.0')).toEqual({ major: 22, minor: 9, patch: 0 });
    expect(parseMinimumRange('>= 22.9.0')).toEqual({ major: 22, minor: 9, patch: 0 });
    expect(parseMinimumRange('>=22.9')).toEqual({ major: 22, minor: 9, patch: 0 });
  });

  it('returns null for range forms it does not understand', () => {
    expect(parseMinimumRange('^22.9.0')).toBeNull();
    expect(parseMinimumRange('>=20 <23')).toBeNull();
    expect(parseMinimumRange(undefined)).toBeNull();
  });
});

describe('satisfiesMinimum (engines >=22.9.0)', () => {
  const range = '>=22.9.0';

  it.each([
    ['22.8.0', false],
    ['22.8.9', false],
    ['v22.8.99', false],
    ['22.9.0', true],
    ['22.9.1', true],
    ['22.14.0', true],
    ['23.0.0', true],
    ['23.11.1', true],
    ['14.15.0', false],
    ['v14.15.0', false],
    ['20.19.3', false],
  ])('%s → %s', (current, expected) => {
    expect(satisfiesMinimum(current, range)).toBe(expected);
  });

  it('accepts the ">= 22.9" spelling', () => {
    expect(satisfiesMinimum('22.8.9', '>= 22.9')).toBe(false);
    expect(satisfiesMinimum('22.9.0', '>= 22.9')).toBe(true);
  });

  it('fails open when the range or the current version cannot be parsed', () => {
    expect(satisfiesMinimum('14.15.0', undefined)).toBe(true);
    expect(satisfiesMinimum('14.15.0', '^22.9.0')).toBe(true);
    expect(satisfiesMinimum('not-a-version', '>=22.9.0')).toBe(true);
  });
});

describe('readEnginesNodeRange', () => {
  it('reads engines.node from package.json', () => {
    const dir = makeTempDir('node-guard-pkg-');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ engines: { node: '>=22.9.0' } }));
    expect(readEnginesNodeRange(dir)).toBe('>=22.9.0');
  });

  it('returns undefined when engines is missing or package.json is unreadable', () => {
    const dir = makeTempDir('node-guard-pkg-');
    expect(readEnginesNodeRange(dir)).toBeUndefined();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
    expect(readEnginesNodeRange(dir)).toBeUndefined();
    fs.writeFileSync(path.join(dir, 'package.json'), '{ not json');
    expect(readEnginesNodeRange(dir)).toBeUndefined();
  });

  it('matches the real repo package.json (the guard reads it, not a hardcoded value)', () => {
    const repoRoot = path.join(scriptsDir, '..');
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    expect(readEnginesNodeRange(repoRoot)).toBe(pkg.engines.node);
    // engines の書式を ">=X.Y.Z" 以外に変えると satisfiesMinimum は fail-open でガードが
    // 黙って無効になる。書式変更をここで検出し、ガード側の追従を促す。
    expect(parseMinimumRange(pkg.engines.node)).not.toBeNull();
  });
});

describe('formatNodeVersionError', () => {
  it('names the required version, the current version and the .nvmrc guidance', () => {
    const message = formatNodeVersionError({ current: '14.15.0', required: '>=22.9.0', nvmrc: '22' });
    expect(message).toContain('>=22.9.0');
    expect(message).toContain('v14.15.0');
    expect(message).toContain('.nvmrc (= 22)');
    expect(message).toContain('nvm use');
  });

  it('does not double the v prefix and omits nvm guidance without .nvmrc', () => {
    const message = formatNodeVersionError({ current: 'v14.15.0', required: '>=22.9.0', nvmrc: undefined });
    expect(message).toContain('v14.15.0');
    expect(message).not.toContain('vv14');
    expect(message).not.toContain('nvm use');
  });
});

describe('checkNodeVersion', () => {
  const makeRepo = (enginesNode, nvmrc) => {
    const dir = makeTempDir('node-guard-repo-');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ engines: { node: enginesNode } }));
    if (nvmrc !== undefined) {
      fs.writeFileSync(path.join(dir, '.nvmrc'), `${nvmrc}\n`);
    }
    return dir;
  };

  it('is ok when the running version satisfies engines', () => {
    expect(checkNodeVersion({ repoRoot: makeRepo('>=22.9.0', '22'), nodeVersion: '22.14.0' })).toEqual({ ok: true });
  });

  it('reports a message when the version is too old', () => {
    const result = checkNodeVersion({ repoRoot: makeRepo('>=22.9.0', '22'), nodeVersion: '14.15.0' });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('>=22.9.0');
    expect(result.message).toContain('v14.15.0');
    expect(result.message).toContain('.nvmrc (= 22)');
  });

  it('defaults to the running process version', () => {
    expect(checkNodeVersion({ repoRoot: makeRepo('>=1.0.0') })).toEqual({ ok: true });
    expect(checkNodeVersion({ repoRoot: makeRepo('>=999.0.0') }).ok).toBe(false);
  });
});

// verify.mjs を実プロセスで起動し、版不足なら npm (= verify の本体ステップ → tsc/vite/vitest) を
// 1 つも spawn しないことを固定する。本物の repo の package.json を書き換えずに engines を
// 変えるため、verify.mjs と import 先を一時ディレクトリへコピーする (verify.mjs は自分の
// 位置から repoRoot を決める)。PATH 先頭の fake npm は起動されたら marker を作るだけ。
// win32 は fake npm の sh スクリプトを spawn できない (verify.mjs は shell: true で
// npm.cmd を探す) ので対象外 — ガード自体は OS 非依存で、上の単体テストが覆う。
describe.skipIf(process.platform === 'win32')('verify.mjs node guard (real process)', () => {
  // verify.mjs から相対 import で辿れる scripts/*.mjs を全部集める。verify.mjs に import が
  // 増えてもコピー漏れで偽の失敗/偽の成功にならないようにする。
  const collectLocalImports = (entry, seen = new Set()) => {
    if (seen.has(entry)) {
      return seen;
    }
    seen.add(entry);
    const source = fs.readFileSync(path.join(scriptsDir, entry), 'utf8');
    for (const match of source.matchAll(/from\s+['"]\.\/([\w.-]+\.mjs)['"]/g)) {
      collectLocalImports(match[1], seen);
    }
    return seen;
  };

  const runVerifyCopy = (enginesNode) => {
    const root = makeTempDir('node-guard-verify-');
    fs.mkdirSync(path.join(root, 'scripts'));
    for (const file of collectLocalImports('verify.mjs')) {
      fs.copyFileSync(path.join(scriptsDir, file), path.join(root, 'scripts', file));
    }
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ engines: { node: enginesNode } }));
    fs.writeFileSync(path.join(root, '.nvmrc'), '22\n');

    const fakeBin = path.join(root, 'fake-bin');
    fs.mkdirSync(fakeBin);
    const marker = path.join(root, 'npm-was-spawned');
    const fakeNpm = path.join(fakeBin, 'npm');
    fs.writeFileSync(fakeNpm, '#!/bin/sh\n: > "$FAKE_NPM_MARKER"\nexit 0\n');
    fs.chmodSync(fakeNpm, 0o755);
    const slotDir = path.join(root, 'slots');

    const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'verify.mjs')], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
        FAKE_NPM_MARKER: marker,
        BDBOARD_VERIFY_SLOT_DIR: slotDir,
      },
      timeout: 10_000,
    });
    return {
      result,
      npmSpawned: fs.existsSync(marker),
      slotDirCreated: fs.existsSync(slotDir),
    };
  };

  it(
    'exits 1 with the version message and spawns nothing when engines is not met',
    () => {
      const { result, npmSpawned, slotDirCreated } = runVerifyCopy('>=999.0.0');
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('>=999.0.0');
      expect(result.stderr).toContain(`v${process.versions.node}`);
      expect(npmSpawned).toBe(false);
      // スロット獲得より前に終わっている (待ち行列にも並ばない)。
      expect(slotDirCreated).toBe(false);
    },
    15_000,
  );

  // 対照: 同じ仕掛けで engines を満たすと npm まで到達する = 上のテストの「spawn していない」
  // が仕掛けの不備による偽の合格ではないことを示す (node 22 では従来どおりの経路)。
  it(
    'still reaches npm when engines is met',
    () => {
      const { result, npmSpawned } = runVerifyCopy('>=1.0.0');
      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain('Node.js >=1.0.0');
      expect(npmSpawned).toBe(true);
    },
    15_000,
  );
});
