// bdboard-41rp: CI は Node 22 だけなので、BDBOARD_OLD_NODE の実 Node で verify の版ガードが
// SyntaxError より先に動くことを確認する。CI の ubuntu verify job だけが絶対パスを設定し、未設定時は
// Windows と通常のローカル実行を変えないため skip する。ただし BDBOARD_OLD_NODE_REQUIRED=1
// (CI の verify job に job 単位で設定) のときに未設定なら skip せず落とす — ワークフローの
// ステップが消えて黙って skip に戻り、CI が緑のまま検出力を失うのを防ぐ。
// ローカル再現: BDBOARD_OLD_NODE=$HOME/.nvm/versions/node/v14.15.0/bin/node npm run test:server -- scripts/node-version-guard.old-node.test.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { parseMinimumRange, readEnginesNodeRange, satisfiesMinimum } from './node-version-guard.mjs';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(scriptsDir, '..');
const oldNode = process.env.BDBOARD_OLD_NODE;
const oldNodeRequired = process.env.BDBOARD_OLD_NODE_REQUIRED === '1';
const tempDirs = [];

const makeTempDir = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

const runOldNode = (args, options = {}) => {
  const { FORCE_COLOR, NODE_OPTIONS, ...env } = process.env;
  return spawnSync(oldNode, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...env,
      // ガードが壊れて (呼び出しが消える・スロット獲得の後ろへ動く等) 本物の verify に進んでも、
      // マシン共有の verify スロット (bdboard-d48) を奪わず、すぐ諦めるようにしておく。
      BDBOARD_VERIFY_SLOT_DIR: makeTempDir('node-guard-old-node-slots-'),
      BDBOARD_VERIFY_SLOTS: '1',
      BDBOARD_VERIFY_SLOT_WAIT_MS: '1000',
    },
    timeout: 10_000,
    ...options,
  });
};

// verify が版ガードで止まったことの判定。exit 1 だけでは SyntaxError / ガード前の実行時エラー
// (どちらも exit 1) と区別できないので、決め手はガードのメッセージそのもの。
const expectGuardShortfall = (result, version, range) => {
  const output = `${result.stderr}${result.stdout}`;
  expect(result.status).toBe(1);
  expect(output).toContain(`verify: Node.js ${range} が必要ですが`);
  expect(output).toContain(`v${version}`);
  expect(output).not.toMatch(/SyntaxError/);
  expect(output).toContain('tsc / vite / vitest を 1 つも起動せずに終了します');
};

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe.runIf(oldNodeRequired && !oldNode)('verify.mjs node guard: CI wiring', () => {
  it('BDBOARD_OLD_NODE must be set when BDBOARD_OLD_NODE_REQUIRED=1', () => {
    expect.fail(
      'BDBOARD_OLD_NODE_REQUIRED=1 なのに BDBOARD_OLD_NODE が未設定です。.github/workflows/ci.yml の verify job で旧 Node を入れて export するステップを確認してください。',
    );
  });
});

describe.skipIf(!oldNode)('verify.mjs node guard on a real old Node', () => {
  const range = readEnginesNodeRange(repoRoot);

  const readOldNodeVersion = () => {
    const result = runOldNode(['--version']);
    const version = `${result.stdout}${result.stderr}`.trim();
    expect(result.status, `BDBOARD_OLD_NODE could not run: ${oldNode}`).toBe(0);
    return version.replace(/^v/, '');
  };

  // 要件を満たす Node では verify が本物の verify を開始してしまうため、spawn 前に拒否する。
  const assertOldNodeIsTooOld = () => {
    // engines が ">=X.Y.Z" 以外の書式だとガードは fail-open する。その場合に下の
    // 「既に満たしている」という紛らわしい失敗ではなく、原因をそのまま出す。
    expect(
      parseMinimumRange(range),
      `package.json engines.node (${range}) is not in ">=X.Y.Z" form; the guard is fail-open and cannot be tested.`,
    ).not.toBeNull();
    const version = readOldNodeVersion();
    expect(
      satisfiesMinimum(version, range),
      `BDBOARD_OLD_NODE (v${version}) already satisfies engines.node (${range}); running verify.mjs would start a real verify and prove nothing; refusing to spawn.`,
    ).toBe(false);
    return version;
  };

  it('BDBOARD_OLD_NODE points to an existing file', () => {
    expect(fs.existsSync(oldNode), `BDBOARD_OLD_NODE does not exist: ${oldNode}`).toBe(true);
  });

  it('BDBOARD_OLD_NODE is older than package.json engines.node', () => {
    assertOldNodeIsTooOld();
  });

  it('prints the version-shortfall message rather than SyntaxError for the real repository', () => {
    const version = assertOldNodeIsTooOld();
    const result = runOldNode([path.join(repoRoot, 'scripts/verify.mjs')]);
    expectGuardShortfall(result, version, range);
  });

  // 対照実験: ガードの import graph にパースできない構文が入ったら、上の判定が実際に落ちることを示す。
  // プローブはどの Node でもパースできない構文にする (特定の版だけ通らない新構文だと、
  // CI の旧 Node を上げたときにこの対照だけが壊れる)。
  it('the shortfall check fails when the guard import graph stops parsing', () => {
    const version = assertOldNodeIsTooOld();
    const root = makeTempDir('node-guard-old-node-');
    const copiedScripts = path.join(root, 'scripts');
    fs.mkdirSync(copiedScripts);
    for (const file of fs.readdirSync(scriptsDir)) {
      if (file.endsWith('.mjs') && !file.endsWith('.test.mjs')) {
        fs.copyFileSync(path.join(scriptsDir, file), path.join(copiedScripts, file));
      }
    }
    fs.copyFileSync(path.join(repoRoot, 'package.json'), path.join(root, 'package.json'));
    const nvmrc = path.join(repoRoot, '.nvmrc');
    if (fs.existsSync(nvmrc)) {
      fs.copyFileSync(nvmrc, path.join(root, '.nvmrc'));
    }
    fs.appendFileSync(path.join(copiedScripts, 'node-version-guard.mjs'), '\nexport const __bdboard41rpProbe = ;\n');

    const result = runOldNode([path.join(copiedScripts, 'verify.mjs')], { cwd: root });
    expect(() => expectGuardShortfall(result, version, range)).toThrow();
    expect(`${result.stderr}${result.stdout}`).toMatch(/SyntaxError/);
  });
}, 30_000);
