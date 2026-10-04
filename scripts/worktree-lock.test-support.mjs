// bdboard-wea0.1: worktree lock のテスト (worktree-lock.test.mjs / verify-worktree-lock.test.mjs) の共通部品。
//
// probeLock は検査対象のモジュールを使わない独立した観測点: 新しい perl プロセスが path を自分で開き (= 新しい
// 記述)、flock(NB) が通るかだけを見て、すぐ閉じて終わる。実プロセスのテストは perl を要るので、perl が無い
// (と win32) ときは skip する (CI の ubuntu と macOS には perl がある)。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { findFlockHelper, FLOCK_HELPER_ENV } from './worktree-lock.mjs';

const PROBE_SCRIPT = 'open(F,"+<",$ARGV[0]) or exit 2; exit(flock(F,$ARGV[1]) ? 0 : 1)';
const PROBE_OPS = { EX: 6, SH: 5 }; // LOCK_EX|LOCK_NB, LOCK_SH|LOCK_NB

/** 'free' | 'busy' | 'error(<status>)'。 */
export function probeLock(lockPath, mode = 'EX') {
  const result = spawnSync('perl', ['-e', PROBE_SCRIPT, lockPath, String(PROBE_OPS[mode])], { stdio: 'ignore' });
  if (result.status === 0) {
    return 'free';
  }
  return result.status === 1 ? 'busy' : `error(${result.status})`;
}

export const realProcessLockTestsSkipped =
  process.platform === 'win32' || spawnSync('perl', ['-e', 'use Fcntl qw(:flock); exit 0'], { stdio: 'ignore' }).status !== 0;

/** helper (argv 接頭辞) が lockPath の記述で動くか (python3 のテストを、python3 が無い環境で skip するため)。 */
export function helperWorks(lockPath, helper) {
  const fd = fs.openSync(lockPath, 'a+');
  try {
    return findFlockHelper(fd, { env: { [FLOCK_HELPER_ENV]: JSON.stringify(helper) } }) !== null;
  } finally {
    fs.closeSync(fd);
  }
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// verify.mjs から相対 import で辿れる scripts/*.mjs を全部集める (verify-slot-timeout-exit.test.mjs と同じ)。
const collectLocalImports = (scriptsDir, entry, seen = new Set()) => {
  if (!seen.has(entry)) {
    seen.add(entry);
    for (const match of fs.readFileSync(path.join(scriptsDir, entry), 'utf8').matchAll(/from\s+['"]\.\/([\w.-]+\.mjs)['"]/g)) {
      collectLocalImports(scriptsDir, match[1], seen);
    }
  }
  return seen;
};

// 偽の npm: $PPID (= verify のリーダー) と marker を書き、FAKE_NPM_RELEASE があればそのファイルが現れるまで (最大約 10 秒) 待つ。
const FAKE_NPM = [
  '#!/bin/sh',
  'echo "$PPID" > "$FAKE_NPM_LEADER"',
  'echo "BDBOARD_WORKTREE_HELD_BY=${BDBOARD_WORKTREE_HELD_BY:--}" > "$FAKE_NPM_MARKER"',
  'i=0',
  'while [ -n "$FAKE_NPM_RELEASE" ] && [ ! -f "$FAKE_NPM_RELEASE" ] && [ "$i" -lt 100 ]; do sleep 0.1; i=$((i+1)); done',
  'exit 0',
  '',
].join('\n');

/** root に verify.mjs (と import 先)、engines の緩い package.json、fake-bin/npm を置く。 */
export function writeVerifyCopy(scriptsDir, root) {
  fs.mkdirSync(path.join(root, 'scripts'));
  for (const file of collectLocalImports(scriptsDir, 'verify.mjs')) {
    fs.copyFileSync(path.join(scriptsDir, file), path.join(root, 'scripts', file));
  }
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ engines: { node: '>=1.0.0' } }));
  fs.mkdirSync(path.join(root, 'fake-bin'));
  fs.writeFileSync(path.join(root, 'fake-bin', 'npm'), FAKE_NPM, { mode: 0o755 });
}

/** コピーした worktree-lock.mjs の release() を、閉じずに投げるよう書き換える (リーダー終了時の close の失敗の代わり)。 */
export function injectReleaseFailure(root) {
  const file = path.join(root, 'scripts', 'worktree-lock.mjs');
  const source = fs.readFileSync(file, 'utf8');
  const patched = source.replace('    release() {\n', "    release() {\n      throw new Error('EIO: injected close failure');\n");
  if (patched === source) {
    throw new Error('injectReleaseFailure: release() not found in the copied worktree-lock.mjs');
  }
  fs.writeFileSync(file, patched);
}

export async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for: ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
