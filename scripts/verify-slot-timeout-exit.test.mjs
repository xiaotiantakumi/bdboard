// bdboard-wj9m: `npm run verify` (scripts/verify.mjs) の終了コード。verify スロットの待ちが打ち切られた
// ときは、verify の失敗 (1) と区別できる予約値 SLOT_WAIT_TIMEOUT_EXIT_CODE (75) で終わる。merge-pr の
// 着地後検証 (scripts/merge-pr/landed-verify.mjs) はこれを main の破損と取り違えない
// (そちらのテストは merge-pr.slot-timeout.test.mjs)。
//
// verify.mjs を実プロセスで起動する。本物の repo を使うと本物の verify (tsc/vitest 一式) が走って
// しまうため、node-version-guard.test.mjs と同じく verify.mjs と import 先を一時ディレクトリへ
// コピーし、PATH 先頭の偽の npm (起動されたら marker を作り FAKE_NPM_EXIT で終わるだけ) で受ける。
// win32 は偽の npm (sh スクリプト) を spawn できないので対象外 (定数と分岐は OS 非依存)。
//
// bdboard-ulxa.3 (PR #854 再レビュー): 偽の npm は自分の引数 (走らされた npm script) と親 (= グループリーダー
// の node) のコマンドラインも書き残す。`--light` の配線 (verify:steps / verify:light の振り分けと、リーダーへの
// --light の引き継ぎ) を verify.mjs の実プロセスで確かめるため — verify-steps.test.mjs は純関数しか見ない。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { IN_VERIFY_ENV, SLOT_IDENTITY_ENV, SLOT_WAIT_TIMEOUT_EXIT_CODE, withoutSlotIdentity } from './verify-slot.mjs';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const tempDirs = [];
const liveProcesses = [];

const makeTempDir = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  while (liveProcesses.length > 0) {
    liveProcesses.pop().kill('SIGKILL');
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

// verify.mjs から相対 import で辿れる scripts/*.mjs を全部集める (import が増えてもコピー漏れで
// 偽の失敗/偽の成功にならないように)。
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

const runVerifyCopy = ({ npmExit = 0, slotEnv = {}, slotDir = makeTempDir('verify-exit-slots-'), args = [] } = {}) => {
  const root = makeTempDir('verify-exit-');
  fs.mkdirSync(path.join(root, 'scripts'));
  for (const file of collectLocalImports('verify.mjs')) {
    fs.copyFileSync(path.join(scriptsDir, file), path.join(root, 'scripts', file));
  }
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ engines: { node: '>=1.0.0' } }));
  const fakeBin = path.join(root, 'fake-bin');
  fs.mkdirSync(fakeBin);
  const marker = path.join(root, 'npm-was-spawned');
  const npmArgsFile = path.join(root, 'npm-args');
  const leaderFile = path.join(root, 'npm-parent');
  const fakeNpm = path.join(fakeBin, 'npm');
  // marker には、リーダー経由で本体ステップに渡ったスロットの素性 (bdboard-xdk8) を 1 行ずつ書く (無ければ -)。
  const identity = SLOT_IDENTITY_ENV.map((name) => `echo "${name}=\${${name}:--}"`);
  identity.push(`echo "${IN_VERIFY_ENV}=\${${IN_VERIFY_ENV}:--}"`);
  fs.writeFileSync(
    fakeNpm,
    [
      '#!/bin/sh',
      '{',
      ...identity,
      '} > "$FAKE_NPM_MARKER"',
      'printf \'%s\\n\' "$*" > "$FAKE_NPM_ARGS"',
      'ps -ww -o args= -p "$PPID" > "$FAKE_NPM_PARENT"',
      'exit "$FAKE_NPM_EXIT"',
      '',
    ].join('\n'),
  );
  fs.chmodSync(fakeNpm, 0o755);
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'verify.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      // landed の着地後検証の中でこのテストが走っても、外側の素性を受け継がない (bdboard-xdk8)。
      ...withoutSlotIdentity(process.env),
      [IN_VERIFY_ENV]: undefined, // この verify の中で走るテストでも、verify.mjs がフラグを立てることを確かめるため外す (bdboard-72oy)
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
      FAKE_NPM_MARKER: marker,
      FAKE_NPM_ARGS: npmArgsFile,
      FAKE_NPM_PARENT: leaderFile,
      FAKE_NPM_EXIT: String(npmExit),
      BDBOARD_VERIFY_SLOT_DIR: slotDir,
      ...slotEnv,
    },
    timeout: 20_000,
  });
  const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : null);
  return {
    result,
    npmSpawned: fs.existsSync(marker),
    stepEnv: fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : null,
    slotDir,
    npmArgs: read(npmArgsFile),
    leaderCommand: read(leaderFile),
  };
};

// 枠 (1 つだけ) を握ったまま生きている別プロセスの holder を置く。走っている holder の顔ぶれが変わらないので待ちが打ち切られる。
const occupyOnlySlot = (slotDir) => {
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  liveProcesses.push(holder);
  fs.writeFileSync(path.join(slotDir, `holder-${holder.pid}.json`), JSON.stringify({ pid: holder.pid, joinedAt: Date.now() - 1_000, cwd: '/fake' }));
  return holder;
};

describe('SLOT_WAIT_TIMEOUT_EXIT_CODE', () => {
  it('is EX_TEMPFAIL (75), the same "retry later" code merge-pr uses, and not the plain failure code', () => {
    expect(SLOT_WAIT_TIMEOUT_EXIT_CODE).toBe(75);
  });
});

// node を同期で起こす (打ち切りのテストはスロットの poll 2 秒 + 起動で、負荷の無い状態でも 2 秒強)。
// verify の並列実行中でも既定 5 秒で落ちないよう、node-version-guard.test.mjs の実プロセステストと
// 同じく余裕を取る。spawnSync 自体の上限 (20 秒) より長くしておく。
describe.skipIf(process.platform === 'win32')('verify.mjs exit codes (real process, copied scripts + fake npm)', { timeout: 30_000 }, () => {
  it('exits 75 without starting any verify step when the slot wait times out', () => {
    const slotDir = makeTempDir('verify-exit-slots-');
    const holder = occupyOnlySlot(slotDir);
    const { result, npmSpawned } = runVerifyCopy({
      slotDir,
      slotEnv: { BDBOARD_VERIFY_SLOTS: '1', BDBOARD_VERIFY_SLOT_WAIT_MS: '1000' },
    });
    expect(result.status).toBe(SLOT_WAIT_TIMEOUT_EXIT_CODE);
    expect(result.stderr).toContain('timed out');
    expect(result.stderr).toContain('waiting for a verify slot');
    expect(npmSpawned).toBe(false);
    // 自分の holder file は片付けてある (先客のものだけが残る)。
    expect(fs.readdirSync(slotDir)).toEqual([`holder-${holder.pid}.json`]);
  });

  // PR #855 のレビュー (B1): merge-pr は着地後検証に BDBOARD_VERIFY_PRIORITY=landed を渡す。それがテストの中の verify.mjs まで
  // 届くと landed の待ちの延長 (32 分) が効き、上のテストが 20 秒で kill されて (143) 着地後検証が failure になっていた。
  it('still exits 75 within the short wait when it inherits a landed identity (an explicit BDBOARD_VERIFY_SLOT_WAIT_MS wins)', () => {
    const slotDir = makeTempDir('verify-exit-slots-');
    const holder = occupyOnlySlot(slotDir);
    const elsewhere = makeTempDir('verify-exit-reservation-');
    const foreignReservation = path.join(elsewhere, `holder-${holder.pid}.json`);
    fs.writeFileSync(foreignReservation, '{}');
    const started = Date.now();
    const { result, npmSpawned } = runVerifyCopy({
      slotDir,
      slotEnv: {
        BDBOARD_VERIFY_SLOTS: '1',
        BDBOARD_VERIFY_SLOT_WAIT_MS: '1000',
        BDBOARD_VERIFY_PRIORITY: 'landed',
        BDBOARD_VERIFY_QUEUE_SINCE: String(Date.now() - 20 * 60_000),
        BDBOARD_VERIFY_SLOT_HANDOFF: foreignReservation,
      },
    });
    expect(result.status, result.stderr).toBe(SLOT_WAIT_TIMEOUT_EXIT_CODE);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(result.stderr).toContain('priority landed');
    expect(npmSpawned).toBe(false);
    expect(fs.existsSync(foreignReservation)).toBe(true); // 別の置き場の holder は予約として消さない
  });

  it('does not pass its slot identity (priority, queue time, reservation) on to the verify steps', () => {
    const { result, stepEnv } = runVerifyCopy({
      slotEnv: { BDBOARD_VERIFY_PRIORITY: 'landed', BDBOARD_VERIFY_QUEUE_SINCE: String(Date.now()), BDBOARD_VERIFY_SLOT_HANDOFF: '/nowhere/holder-1.json' },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(stepEnv.trim().split('\n').slice(0, SLOT_IDENTITY_ENV.length)).toEqual(SLOT_IDENTITY_ENV.map((name) => `${name}=-`));
    expect(stepEnv.trim().split('\n').at(-1)).toBe(`${IN_VERIFY_ENV}=1`);
  });

  it('passes the verify flag even when slot identity is set', () => {
    const { result, stepEnv } = runVerifyCopy({
      slotEnv: { BDBOARD_VERIFY_PRIORITY: 'landed', BDBOARD_VERIFY_QUEUE_SINCE: String(Date.now()) },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(stepEnv.trim().split('\n').at(-1)).toBe(`${IN_VERIFY_ENV}=1`);
  });

  it('passes the verify steps exit code through unchanged (0 and a plain failure)', () => {
    expect(runVerifyCopy({ npmExit: 0 }).result.status).toBe(0);
    const failed = runVerifyCopy({ npmExit: 2 });
    expect(failed.result.status).toBe(2);
    expect(failed.npmSpawned).toBe(true);
  });

  it('runs verify:steps by default and verify:light with --light, handing --light to the group leader only then (bdboard-ulxa.3)', () => {
    const plain = runVerifyCopy();
    expect(plain.result.status).toBe(0);
    expect(plain.npmArgs).toBe('run verify:steps');
    expect(plain.leaderCommand).toMatch(/\/scripts\/verify\.mjs --group-leader$/);

    const light = runVerifyCopy({ args: ['--light'] });
    expect(light.result.status).toBe(0);
    expect(light.result.stderr).toContain('verify: --light = verify:light');
    expect(light.npmArgs).toBe('run verify:light');
    expect(light.leaderCommand).toMatch(/\/scripts\/verify\.mjs --group-leader --light$/);
  });

  it('never returns the reserved 75 for a verify step that happens to exit 75 (reported as a plain failure, 1)', () => {
    const { result, npmSpawned } = runVerifyCopy({ npmExit: SLOT_WAIT_TIMEOUT_EXIT_CODE });
    expect(npmSpawned).toBe(true); // 本体ステップは走った = スロット待ちの打ち切りではない
    expect(result.status).toBe(1);
  });
});
