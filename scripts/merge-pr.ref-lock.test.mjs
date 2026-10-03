// bdboard-1syo: origin/main の tracking ref に stale lock が残ったとき、merge-pr は 75 (待って再試行) ではなく
// 専用の終了コード 8 で止まり、lock のパスと「他の git が動いていないことを確かめてから消す」案内を出す。
// lock は自動では消さない。共有の harness (一時リポジトリ + 偽の gh / bd / npm) は merge-pr.test-support.mjs。
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { refetchMain } from './merge-pr/context.mjs';
import { refLockFailure, refLockLines } from './merge-pr/ref-lock.mjs';
import { git, mainCheckout, peerCommit, PR, registerTempRepoHooks, run, setup, tmp, work } from './merge-pr.test-support.mjs';

/**
 * lock が効くのは fetch が tracking ref を更新するときだけ (最新なら lock を取りに行かない)。
 * なので origin の main を 1 コミット進める。remote 名ではなくパスへ push して、手元の
 * refs/remotes/origin/main は動かさない (動かすと次の fetch が空振りして lock に当たらない)。
 */
function moveOriginMainBehindTrackingRef() {
  const peer = peerCommit();
  git(work, ['push', '-q', path.join(tmp, 'origin.git'), `${peer}:refs/heads/main`]);
  return peer;
}

const lockFile = () => path.join(mainCheckout, '.git', 'refs', 'remotes', 'origin', 'main.lock');

describe('merge-pr ref lock handling (bdboard-1syo)', () => {
  registerTempRepoHooks();
  const tempDirs = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prepare / gate / verify stop with exit 8 and the cleanup advice, and never delete the lock', () => {
    setup();
    moveOriginMainBehindTrackingRef();
    writeFileSync(lockFile(), '');
    for (const args of [['prepare', String(PR)], ['prepare', String(PR), '--dry-run'], ['gate', String(PR)], ['verify', 'a'.repeat(40)]]) {
      const result = run(args);
      expect(result.status, `${args.join(' ')}:\n${result.stderr}`).toBe(8);
      expect(result.stderr).toContain('main.lock');
      expect(result.stderr).toContain('ロック');
      expect(result.stderr).toContain('ps -axo pid,etime,command');
      expect(result.stderr).toContain('rm -f');
      expect(result.stderr).toContain('自動では消しません');
      // 再試行を促す 75 系の文言は出さない。
      expect(result.stderr).not.toContain('prepare からやり直してください');
      expect(existsSync(lockFile()), `${args.join(' ')} must leave the lock alone`).toBe(true);
    }
  });

  it('after the lock is removed as advised, prepare gets past the fetch', () => {
    setup();
    moveOriginMainBehindTrackingRef();
    writeFileSync(lockFile(), '');
    expect(run(['prepare', String(PR)]).status).toBe(8);
    rmSync(lockFile());
    // origin/main が PR の先に進んでいる (S1 のクラス R = 3) が、fetch は通って分類まで進む。
    const result = run(['prepare', String(PR)]);
    expect(result.status, result.stderr).toBe(3);
    expect(result.stderr).not.toContain('ロック');
  });

  it('a fetch failure that is not a lock stays exit 75 (a transient failure)', () => {
    setup();
    git(work, ['remote', 'set-url', 'origin', path.join(tmp, 'does-not-exist.git')]);
    const result = run(['prepare', String(PR)]);
    expect(result.status, result.stderr).toBe(75);
    expect(result.stderr).toContain('git fetch origin main に失敗しました');
    expect(result.stderr).not.toContain('ロック');
  });

  it('finish carries on from the local origin/main (it must still return the slot) and only prints the advice', () => {
    setup();
    moveOriginMainBehindTrackingRef();
    writeFileSync(lockFile(), '');
    const result = run(['finish', String(PR)]);
    // gate の記録が無いので finish 自身は 2 で止まるが、それは fetch の失敗ではない。
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain('手元の origin/main で続けます');
    expect(result.stderr).toContain('main.lock');
    expect(result.stderr).toContain('rm -f');
    expect(existsSync(lockFile())).toBe(true);
  });

  it('refetchMain never throws on a lock: it prints the advice once and returns the local origin/main', () => {
    setup();
    moveOriginMainBehindTrackingRef();
    writeFileSync(lockFile(), '');
    const ctx = { cwd: work, config: { mainBranch: 'main' }, mainRef: 'origin/main' };
    const before = git(work, ['rev-parse', 'origin/main']);
    const writes = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    let first;
    let second;
    try {
      first = refetchMain(ctx);
      second = refetchMain(ctx);
    } finally {
      spy.mockRestore();
    }
    expect(first).toBe(before);
    expect(second).toBe(before);
    const advice = writes.filter((line) => line.includes('main.lock') && line.includes('ロックファイル'));
    expect(advice).toHaveLength(1);
    expect(existsSync(lockFile())).toBe(true);
  });

  it('refLockFailure separates a persistent lock from a transient race and from unrelated failures', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bdboard-ref-lock-'));
    tempDirs.push(dir);
    expect(refLockFailure("fatal: unable to access 'https://example.invalid/': Could not resolve host", dir)).toBeNull();
    const absent = path.join(dir, 'absent.lock');
    expect(refLockFailure(`error: Unable to create '${absent}': File exists.`, dir)).toBeNull(); // もう無い = 一瞬の競合
    const present = path.join(dir, 'present.lock');
    writeFileSync(present, '');
    expect(refLockFailure(`error: cannot lock ref 'refs/remotes/origin/main': Unable to create '${present}': File exists.`, dir)).toEqual({
      lockPath: present,
    });
    expect(refLockFailure("error: cannot lock ref 'refs/remotes/origin/main'", dir)).toEqual({ lockPath: null });
    writeFileSync(path.join(dir, 'relative.lock'), '');
    expect(refLockFailure("Unable to create 'relative.lock': File exists.", dir)).toEqual({ lockPath: path.join(dir, 'relative.lock') });
  });

  it('refLockLines names the lock, asks for a check that no other git runs, and quotes the path', () => {
    const known = refLockLines('git fetch origin main', ' Unable to create \'/x/main.lock\': File exists. ', '/x/main.lock').join('\n');
    expect(known).toContain('git fetch origin main');
    expect(known).toContain('ロックファイル: /x/main.lock');
    expect(known).toContain('rm -f /x/main.lock');
    expect(known).toContain("ps -axo pid,etime,command | grep '[g]it '");
    expect(known).toContain('自動では消しません');
    const unknown = refLockLines('git fetch origin main', 'error: cannot lock ref', null).join('\n');
    expect(unknown).toContain('<ロックファイル>');
    expect(refLockLines('git fetch origin main', 'x', '/with space/main.lock').join('\n')).toContain("rm -f '/with space/main.lock'");
  });
});
