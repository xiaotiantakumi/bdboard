// bdboard-9nah: 議長の cwd が古い worktree のままだと、案内どおり相対パスで
// (`scripts/always-on-server.sh ...`) 呼んでも、その worktree に取り残された旧版が実行され、
// main に入った以後の修正 (安全策も含む) が効かない事故につながる (bdboard-flpp の設計レビューで
// 指摘)。always-on-server.sh 自身が「自分の置き場所が main checkout の scripts/ でなければ
// main 側の現在版へ exec し直す」自己検出/委譲を、実際の git worktree 構成 (`git worktree add`)
// と固有マーカーを出す最小スタブで確かめる。本物のサーバーは起動しない。
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REAL_SCRIPT = fileURLToPath(new URL('./always-on-server.sh', import.meta.url));
const REAL_DEPLOY_CHANGED = fileURLToPath(new URL('./deploy-changed.sh', import.meta.url));
const SCRIPT_BASENAME = ['always', 'on', 'server'].join('-') + '.sh';

// main 側は「いま main checkout に入っている現在の版」を表す固有マーカースクリプトに
// 差し替える。実際の always-on-server.sh を複製すると、その本体をテストが二重に保守する
// ことになるため、委譲が「正しいファイルへ・元の引数のまま」届いたことだけを見る最小スタブに
// している。
const MAIN_MARKER_SCRIPT = `#!/usr/bin/env bash
printf 'MAIN-VERSION-EXECUTED args=%s\\n' "$*"
exit 0
`;

function git(repo, args, env) {
  const result = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} in ${repo} failed: ${result.stderr}`);
  }
  return result;
}

function commitAll(repo, env, message) {
  git(repo, ['add', '-A'], env);
  git(
    repo,
    [
      '-c',
      'user.name=bdboard-test',
      '-c',
      'user.email=bdboard-test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '-m',
      message,
    ],
    env,
  );
}

function run(scriptPath, cwd, args, env, extraEnv = {}) {
  const result = spawnSync('bash', [scriptPath, ...args], {
    cwd,
    env: { ...env, ...extraEnv },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe.skipIf(process.platform === 'win32')('always-on-server.sh self-exec guard (bdboard-9nah)', () => {
  let tmpRoot;
  let env;

  beforeAll(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'bdboard-self-exec-'));
    env = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: path.join(tmpRoot, 'home'),
    };
    mkdirSync(env.HOME, { recursive: true });
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function makeMainAndWorktree(label, { mainHasScript, mainScriptKind = 'marker' }) {
    const mainRepo = path.join(tmpRoot, `${label}-main`);
    mkdirSync(mainRepo, { recursive: true });
    writeFileSync(path.join(mainRepo, 'package.json'), JSON.stringify({ name: 'fake-bdboard', private: true }));
    if (mainHasScript) {
      mkdirSync(path.join(mainRepo, 'scripts'), { recursive: true });
      if (mainScriptKind === 'real') {
        // 「すでに main checkout の版として呼ばれた」ケースを確かめるテスト用: 委譲先の
        // マーカーではなく、いま編集中の実物を main 側にも置く (このときは worktree 側は使わない)。
        copyFileSync(REAL_SCRIPT, path.join(mainRepo, 'scripts', SCRIPT_BASENAME));
        chmodSync(path.join(mainRepo, 'scripts', SCRIPT_BASENAME), 0o755);
        copyFileSync(REAL_DEPLOY_CHANGED, path.join(mainRepo, 'scripts', 'deploy-changed.sh'));
      } else {
        writeFileSync(path.join(mainRepo, 'scripts', SCRIPT_BASENAME), MAIN_MARKER_SCRIPT, { mode: 0o755 });
      }
    }
    git(mainRepo, ['init', '-q', '-b', 'main'], env);
    commitAll(mainRepo, env, `${label} main`);

    const worktreeRepo = path.join(tmpRoot, `${label}-worktree`);
    git(mainRepo, ['worktree', 'add', '-q', worktreeRepo, '-b', `${label}-feature`], env);

    // worktree 側には「取り残された旧版」として、いま編集中の実物の always-on-server.sh
    // (自己検出ロジックを含む) と、それが読み込む deploy-changed.sh を置く。
    mkdirSync(path.join(worktreeRepo, 'scripts'), { recursive: true });
    copyFileSync(REAL_SCRIPT, path.join(worktreeRepo, 'scripts', SCRIPT_BASENAME));
    chmodSync(path.join(worktreeRepo, 'scripts', SCRIPT_BASENAME), 0o755);
    copyFileSync(REAL_DEPLOY_CHANGED, path.join(worktreeRepo, 'scripts', 'deploy-changed.sh'));

    return { mainRepo, worktreeRepo, staleScript: path.join(worktreeRepo, 'scripts', SCRIPT_BASENAME) };
  }

  it('delegates to the main checkout copy when run from a stale worktree copy', () => {
    const { worktreeRepo, staleScript } = makeMainAndWorktree('delegate', { mainHasScript: true });
    const result = run(staleScript, worktreeRepo, ['status', '--port', '19999'], env);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('main checkout');
    expect(result.stderr).toContain('bdboard-9nah');
    // 元の引数 (action + フラグ) がそのまま main 側の版へ渡っていること。
    expect(result.stdout).toContain('MAIN-VERSION-EXECUTED args=status --port 19999');
  });

  it('BDBOARD_SERVER_SKIP_SELF_EXEC=1 keeps running the stale copy itself (test/recursion escape hatch)', () => {
    const { worktreeRepo, staleScript } = makeMainAndWorktree('skip', { mainHasScript: true });
    // --port は本物の常駐サーバー(既定 8787)を一切参照しないよう、使われていなさそうな値を明示する。
    const result = run(staleScript, worktreeRepo, ['status', '--port', '19998'], env, {
      BDBOARD_SERVER_SKIP_SELF_EXEC: '1',
    });
    expect(result.status).toBe(0);
    // 委譲メッセージもマーカーも出ない = worktree 側の版が最後まで自分で走った。
    expect(result.stderr).not.toContain('bdboard-9nah');
    expect(result.stdout).not.toContain('MAIN-VERSION-EXECUTED');
    expect(result.stdout).toContain('main checkout :');
    expect(result.stdout).toContain('listener PID  : (not listening)');
  });

  it('fails open (keeps running the stale copy) when the main checkout has no matching script at all', () => {
    const { worktreeRepo, staleScript } = makeMainAndWorktree('missing', { mainHasScript: false });
    const result = run(staleScript, worktreeRepo, ['status', '--port', '19997'], env);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('bdboard-9nah');
    expect(result.stdout).not.toContain('MAIN-VERSION-EXECUTED');
    expect(result.stdout).toContain('main checkout :');
  });

  it('does not delegate when already invoked as the main checkout copy', () => {
    // マーカーへの委譲が起きた「ように見える」だけでは、本物のガード条件
    // (SCRIPT_DIR == MAIN_SCRIPT_DIR_CANON なら exec しない) 自体は検証できない。
    // ここでは main 側にも実物の always-on-server.sh を置き、main checkout から直接
    // 実行して、委譲メッセージが一切出ず・通常の status 出力がそのまま返ることを確かめる。
    const { mainRepo } = makeMainAndWorktree('canonical', { mainHasScript: true, mainScriptKind: 'real' });
    const mainScript = path.join(mainRepo, 'scripts', SCRIPT_BASENAME);
    const result = run(mainScript, mainRepo, ['status', '--port', '19996'], env);
    expect(result.status).toBe(0);
    // 委譲時のメッセージ (bdboard-9nah を含む) が出ていない = exec し直していない。
    expect(result.stderr).not.toContain('bdboard-9nah');
    expect(result.stdout).not.toContain('MAIN-VERSION-EXECUTED');
    // 委譲せず、実物の status 出力がそのまま返っている。
    expect(result.stdout).toContain('main checkout :');
    expect(result.stdout).toContain('listener PID  : (not listening)');
  });
});
