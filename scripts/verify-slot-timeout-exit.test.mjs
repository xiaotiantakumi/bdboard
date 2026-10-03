// bdboard-wj9m: `npm run verify` (scripts/verify.mjs) の終了コード。verify スロットの待ちが打ち切られた
// ときは、verify の失敗 (1) と区別できる予約値 SLOT_WAIT_TIMEOUT_EXIT_CODE (75) で終わる。merge-pr の
// 着地後検証 (scripts/merge-pr/landed-verify.mjs) はこれを main の破損と取り違えない
// (そちらのテストは merge-pr.slot-timeout.test.mjs)。
//
// verify.mjs を実プロセスで起動する。本物の repo を使うと本物の verify (tsc/vitest 一式) が走って
// しまうため、node-version-guard.test.mjs と同じく verify.mjs と import 先を一時ディレクトリへ
// コピーし、PATH 先頭の偽の npm (起動されたら marker を作り FAKE_NPM_EXIT で終わるだけ) で受ける。
// win32 は偽の npm (sh スクリプト) を spawn できないので対象外 (定数と分岐は OS 非依存)。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { SLOT_WAIT_TIMEOUT_EXIT_CODE } from './verify-slot.mjs';

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

const runVerifyCopy = ({ npmExit = 0, slotEnv = {}, slotDir = makeTempDir('verify-exit-slots-') } = {}) => {
  const root = makeTempDir('verify-exit-');
  fs.mkdirSync(path.join(root, 'scripts'));
  for (const file of collectLocalImports('verify.mjs')) {
    fs.copyFileSync(path.join(scriptsDir, file), path.join(root, 'scripts', file));
  }
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ engines: { node: '>=1.0.0' } }));
  const fakeBin = path.join(root, 'fake-bin');
  fs.mkdirSync(fakeBin);
  const marker = path.join(root, 'npm-was-spawned');
  const fakeNpm = path.join(fakeBin, 'npm');
  fs.writeFileSync(fakeNpm, '#!/bin/sh\n: > "$FAKE_NPM_MARKER"\nexit "$FAKE_NPM_EXIT"\n');
  fs.chmodSync(fakeNpm, 0o755);
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'verify.mjs')], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
      FAKE_NPM_MARKER: marker,
      FAKE_NPM_EXIT: String(npmExit),
      BDBOARD_VERIFY_SLOT_DIR: slotDir,
      ...slotEnv,
    },
    timeout: 20_000,
  });
  return { result, npmSpawned: fs.existsSync(marker), slotDir };
};

describe('SLOT_WAIT_TIMEOUT_EXIT_CODE', () => {
  it('is EX_TEMPFAIL (75), the same "retry later" code merge-pr uses, and not the plain failure code', () => {
    expect(SLOT_WAIT_TIMEOUT_EXIT_CODE).toBe(75);
  });
});

describe.skipIf(process.platform === 'win32')('verify.mjs exit codes (real process, copied scripts + fake npm)', () => {
  it('exits 75 without starting any verify step when the slot wait times out', () => {
    const slotDir = makeTempDir('verify-exit-slots-');
    // 枠 (1 つだけ) を握ったまま生きている別プロセス。走っている holder の顔ぶれが変わらないので待ちが打ち切られる。
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    liveProcesses.push(holder);
    fs.writeFileSync(path.join(slotDir, `holder-${holder.pid}.json`), JSON.stringify({ pid: holder.pid, joinedAt: Date.now() - 1_000, cwd: '/fake' }));
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

  it('passes the verify steps exit code through unchanged (0 and a plain failure)', () => {
    expect(runVerifyCopy({ npmExit: 0 }).result.status).toBe(0);
    const failed = runVerifyCopy({ npmExit: 2 });
    expect(failed.result.status).toBe(2);
    expect(failed.npmSpawned).toBe(true);
  });

  it('never returns the reserved 75 for a verify step that happens to exit 75 (reported as a plain failure, 1)', () => {
    const { result, npmSpawned } = runVerifyCopy({ npmExit: SLOT_WAIT_TIMEOUT_EXIT_CODE });
    expect(npmSpawned).toBe(true); // 本体ステップは走った = スロット待ちの打ち切りではない
    expect(result.status).toBe(1);
  });
});
