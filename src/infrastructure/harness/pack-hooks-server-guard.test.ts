import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommandResult } from '../../application/ports/command-runner.js';
import { NodeCommandRunner } from '../process/node-command-runner.js';

/**
 * bdboard-harness パックの pre-bash-guard.sh 規則 7 (hooks/server-guard.sh) の統合テスト
 * (bdboard-hpu8)。
 *
 * 規則 7 は「常時稼働サーバー (契約 alwaysOnServer.port) を守る」ための 3 つの判定:
 *   7a. サブエージェント (hook 入力に agent_id がある) から main checkout での git pull
 *   7b. サブエージェントから main checkout でのサーバー起動と、再起動スクリプトの実行
 *   7c. 誰からでも、listener PID (とその親) を直接 kill する / port から引いた PID を kill する
 *
 * 本物の 8787 には一切触れない。listener はこのテストプロセス自身が確保した空きポートに
 * 立てる (lsof がそのポートの listener として vitest ワーカーの PID を返す)。hook は deny
 * するだけで kill はしないので、自プロセスの PID を「守られる対象」として使える。
 *
 * pack-hooks.test.ts と同じく Windows では skip (POSIX シェル前提)。
 */

const PACKS_ROOT = fileURLToPath(new URL('../../../harness/packs/', import.meta.url));
const PRE_BASH_GUARD = path.join(PACKS_ROOT, 'bdboard-harness', 'hooks', 'pre-bash-guard.sh');

const runner = new NodeCommandRunner();

describe.skipIf(process.platform === 'win32')('bdboard-harness pre-bash-guard rule 7 (server guard)', () => {
  let tmpRoot: string;
  let mainRepo: string;
  let worktree: string;
  let env: Record<string, string>;
  let listener: Server;
  let port: number;

  beforeAll(async () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'bdboard-server-guard-'));
    const home = path.join(tmpRoot, 'home');
    mkdirSync(home, { recursive: true });
    env = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      // 規則 7 の監査ログは ${TMPDIR:-/tmp}/bdboard-server-guard.log に書く。
      TMPDIR: tmpRoot,
    };

    listener = createServer();
    port = await new Promise<number>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', () => {
        const address = listener.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('listener has no port'));
          return;
        }
        resolve(address.port);
      });
    });

    mainRepo = path.join(tmpRoot, 'main');
    worktree = path.join(tmpRoot, 'wt');
    await initGitRepo(mainRepo, 'main');
    mkdirSync(path.join(mainRepo, '.claude'), { recursive: true });
    writeFileSync(
      path.join(mainRepo, '.claude', 'bdboard-harness.json'),
      JSON.stringify({
        version: 1,
        verify: 'npm run verify',
        prFlow: 'pr',
        mainBranch: 'main',
        alwaysOnServer: { port, restartScript: 'scripts/always-on-server.sh' },
      }),
    );
    await runGit(mainRepo, ['add', '.claude']);
    await runGit(mainRepo, [...GIT_IDENTITY, 'commit', '-q', '-m', 'contract']);
    await runGit(mainRepo, ['worktree', 'add', '-q', worktree, '-b', 'bd/test']);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  const GIT_IDENTITY = [
    '-c',
    'user.name=bdboard-test',
    '-c',
    'user.email=bdboard-test@example.invalid',
    '-c',
    'commit.gpgsign=false',
  ];

  async function runGit(cwd: string, args: readonly string[]): Promise<void> {
    const result = await runner.run('git', args, { cwd, env, timeoutMs: 20_000 });
    if (result.exitCode !== 0) {
      throw new Error(`git ${args.join(' ')} failed (${result.exitCode}): ${result.stderr}`);
    }
  }

  async function initGitRepo(repoPath: string, branch: string): Promise<void> {
    mkdirSync(repoPath, { recursive: true });
    await runGit(repoPath, ['init', '-q']);
    await runGit(repoPath, ['checkout', '-q', '-b', branch]);
    await runGit(repoPath, [...GIT_IDENTITY, 'commit', '-q', '--allow-empty', '-m', 'init']);
  }

  interface HookCall {
    readonly command: string;
    readonly cwd: string;
    /** 省略 = トップレベル (議長)。文字列 = サブエージェント。 */
    readonly agentId?: string;
  }

  async function runHook(call: HookCall): Promise<CommandResult> {
    const payload: Record<string, unknown> = {
      tool_name: 'Bash',
      tool_input: { command: call.command },
      cwd: call.cwd,
    };
    if (call.agentId !== undefined) {
      payload.agent_id = call.agentId;
    }
    return runner.run('bash', [PRE_BASH_GUARD], {
      input: JSON.stringify(payload),
      cwd: call.cwd,
      env,
      timeoutMs: 20_000,
    });
  }

  function expectDeny(result: CommandResult, ...fragments: readonly string[]): void {
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    const lines = result.stderr.split('\n').filter((line) => line.length > 0);
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(lines[0]).toMatch(/^bdboard-harness: /);
    for (const fragment of fragments) {
      expect(result.stderr).toContain(fragment);
    }
  }

  function expectAllow(result: CommandResult): void {
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  }

  describe('7a: git pull in the main checkout', () => {
    it('denies a subagent pulling in the main checkout (cwd)', async () => {
      expectDeny(
        await runHook({ command: 'git pull --ff-only', cwd: mainRepo, agentId: 'agent-1' }),
        'サブエージェント',
        'main checkout',
        'always-on-server.sh restart --expect-pid',
      );
    });

    it('denies a subagent that cd-s into the main checkout first (the 2026-09-20 shape)', async () => {
      expectDeny(
        await runHook({
          command: `cd ${mainRepo} && git pull --ff-only`,
          cwd: worktree,
          agentId: 'agent-1',
        }),
        'git pull',
      );
    });

    it('denies git -C <main> pull and a cd through a same-command variable', async () => {
      expectDeny(
        await runHook({ command: `git -C ${mainRepo} pull`, cwd: worktree, agentId: 'agent-1' }),
      );
      expectDeny(
        await runHook({
          command: `MAIN=${mainRepo}; cd "$MAIN" && git pull --ff-only`,
          cwd: worktree,
          agentId: 'agent-1',
        }),
      );
      // main checkout の下位ディレクトリでも toplevel は main。
      expectDeny(
        await runHook({
          command: `cd ${mainRepo}/.claude && git pull`,
          cwd: worktree,
          agentId: 'agent-1',
        }),
      );
    });

    it('allows a subagent pulling its own worktree, and the chair pulling main', async () => {
      expectAllow(await runHook({ command: 'git pull --ff-only', cwd: worktree, agentId: 'agent-1' }));
      expectAllow(await runHook({ command: 'git pull --ff-only', cwd: mainRepo }));
      // ( ) のサブシェル内の cd は閉じ括弧で巻き戻る。
      expectAllow(
        await runHook({
          command: `(cd ${mainRepo} && git log -1); git pull`,
          cwd: worktree,
          agentId: 'agent-1',
        }),
      );
    });
  });

  describe('7b: starting the server / running the restart script', () => {
    it('denies a subagent starting the server from the main checkout', async () => {
      expectDeny(
        await runHook({
          command: `cd ${mainRepo} && nohup npm run start > /tmp/x.log 2>&1`,
          cwd: worktree,
          agentId: 'agent-1',
        }),
        'npm run start',
      );
      expectDeny(
        await runHook({ command: 'npm run start', cwd: mainRepo, agentId: 'agent-1' }),
      );
      expectDeny(
        await runHook({
          command: `cd ${mainRepo} && tsx src/main.ts`,
          cwd: worktree,
          agentId: 'agent-1',
        }),
        'tsx src/main.ts',
      );
    });

    it('allows worktree test servers and another port from the main checkout', async () => {
      expectAllow(await runHook({ command: 'npm run start', cwd: worktree, agentId: 'agent-1' }));
      expectAllow(
        await runHook({
          command: 'BDBOARD_PORT=18790 npm run start',
          cwd: worktree,
          agentId: 'agent-1',
        }),
      );
      expectAllow(
        await runHook({
          command: 'BDBOARD_PORT=18790 npm run start',
          cwd: mainRepo,
          agentId: 'agent-1',
        }),
      );
      expectAllow(await runHook({ command: 'npm run start', cwd: mainRepo }));
    });

    it('denies a subagent running the restart script from anywhere, but not the chair', async () => {
      expectDeny(
        await runHook({
          command: 'BDBOARD_SERVER_CALLER=chair bash scripts/always-on-server.sh restart --expect-pid 1',
          cwd: worktree,
          agentId: 'agent-1',
        }),
        '再起動スクリプト',
      );
      expectAllow(
        await runHook({
          command: 'BDBOARD_SERVER_CALLER=chair bash scripts/always-on-server.sh restart --expect-pid 1',
          cwd: worktree,
        }),
      );
    });

    it('denies direct execution of the restart script without an interpreter prefix', async () => {
      expectDeny(
        await runHook({
          command: 'scripts/always-on-server.sh restart --expect-pid 1',
          cwd: worktree,
          agentId: 'agent-1',
        }),
        '再起動スクリプト',
      );
      expectDeny(
        await runHook({
          command: './scripts/always-on-server.sh restart --expect-pid 1',
          cwd: worktree,
          agentId: 'agent-1',
        }),
      );
      expectDeny(
        await runHook({
          command: 'sh scripts/always-on-server.sh restart --expect-pid 1',
          cwd: worktree,
          agentId: 'agent-1',
        }),
      );
    });


    // bdboard-wa48 レビュー (opus): 狭めた一致がインタプリタのフラグやラッパー経由の
    // 迂回を見逃していないか。narrow 一致 (コマンド語 / bash・sh の直後の引数だけ) に
    // 単純化すると、これらは main の全引数走査より検知が弱くなってしまう。
    it('still denies restart-script invocations through interpreter flags, wrappers, and indirection', async () => {
      const wrappedCommands = [
        'bash -x scripts/always-on-server.sh restart',
        'timeout 600 scripts/always-on-server.sh restart',
        'zsh scripts/always-on-server.sh restart',
        'source scripts/always-on-server.sh restart',
        '. scripts/always-on-server.sh restart',
        'bash -c "scripts/always-on-server.sh restart"',
        '$(git rev-parse --show-toplevel)/scripts/always-on-server.sh restart',
        'env -i bash scripts/always-on-server.sh restart',
      ];
      for (const command of wrappedCommands) {
        expectDeny(await runHook({ command, cwd: worktree, agentId: 'agent-1' }));
      }
    });

    // bdboard-wa48: 規則 7b はもともとセグメント中の全引数位置に basename 一致を見ていたため、
    // 再起動スクリプト名をただの検索語・grep パターン・コミットメッセージに含めただけの
    // コマンドまで deny していた (fable の設計レビューでも 24h に 3 件実測)。一致はコマンド語
    // 自身、または bash/sh の直後の引数だけに絞る。
    it('allows commands that merely mention the restart script filename as an argument', async () => {
      expectAllow(
        await runHook({
          command: 'bd search "always-on-server.sh"',
          cwd: worktree,
          agentId: 'agent-1',
        }),
      );
      expectAllow(
        await runHook({
          command: 'grep -r always-on-server.sh docs/',
          cwd: worktree,
          agentId: 'agent-1',
        }),
      );
      expectAllow(
        await runHook({
          command: 'git log -S always-on-server.sh',
          cwd: worktree,
          agentId: 'agent-1',
        }),
      );
      expectAllow(
        await runHook({
          command: 'cat scripts/always-on-server.sh',
          cwd: worktree,
          agentId: 'agent-1',
        }),
      );
      expectAllow(
        await runHook({
          command: 'wc -l scripts/always-on-server.sh',
          cwd: worktree,
          agentId: 'agent-1',
        }),
      );
      expectAllow(
        await runHook({
          command: 'git commit -m "docs: mention scripts/always-on-server.sh in README"',
          cwd: worktree,
          agentId: 'agent-1',
        }),
      );
    });
  });

  describe('7c: killing the listener', () => {
    it('denies killing the listener PID for the chair and for subagents', async () => {
      expectDeny(
        await runHook({ command: `kill ${process.pid}`, cwd: worktree }),
        `PID ${process.pid}`,
        'BDBOARD_SERVER_OVERRIDE',
      );
      expectDeny(
        await runHook({ command: `kill -9 ${process.pid}`, cwd: worktree, agentId: 'agent-1' }),
        'サブエージェントは kill も再起動もできません',
      );
      expectDeny(await runHook({ command: `kill -s TERM ${process.pid}`, cwd: mainRepo }));
    });

    it('denies PIDs derived from the port ($(...), variable, pipeline)', async () => {
      expectDeny(
        await runHook({ command: `kill $(lsof -tiTCP:${port} -sTCP:LISTEN)`, cwd: worktree }),
        `port ${port}`,
      );
      expectDeny(
        await runHook({
          command: `OLD=$(lsof -tiTCP:${port} -sTCP:LISTEN); kill $OLD`,
          cwd: worktree,
        }),
        '$OLD',
      );
      expectDeny(
        await runHook({ command: `lsof -tiTCP:${port} -sTCP:LISTEN | xargs kill`, cwd: worktree }),
        'パイプ',
      );
    });

    it('allows kill -0, unrelated PIDs, and mentioning the port without killing it', async () => {
      expectAllow(await runHook({ command: `kill -0 ${process.pid}`, cwd: worktree }));
      expectAllow(
        await runHook({
          command: `kill 999999; curl -s http://127.0.0.1:${port}/api/health`,
          cwd: worktree,
          agentId: 'agent-1',
        }),
      );
      expectAllow(await runHook({ command: `lsof -nP -iTCP:${port} -sTCP:LISTEN`, cwd: worktree }));
    });

    it('honours BDBOARD_SERVER_OVERRIDE for the chair only', async () => {
      expectAllow(
        await runHook({
          command: `BDBOARD_SERVER_OVERRIDE="manual stop" kill ${process.pid}`,
          cwd: worktree,
        }),
      );
      expectDeny(
        await runHook({
          command: `BDBOARD_SERVER_OVERRIDE="manual stop" kill ${process.pid}`,
          cwd: worktree,
          agentId: 'agent-1',
        }),
      );
    });

    it('writes one audit line per deny under $TMPDIR', () => {
      const auditLog = path.join(tmpRoot, 'bdboard-server-guard.log');
      const content = readFileSync(auditLog, 'utf8');
      expect(content).toContain('7a-git-pull\tagent=agent-1');
      expect(content).toContain('7c-kill-listener\tagent=top-level');
      expect(content).toContain('7b-restart-script');
    });
  });

  describe('activation', () => {
    it('stays silent when the contract has no alwaysOnServer', async () => {
      const plainRepo = path.join(tmpRoot, 'plain');
      await initGitRepo(plainRepo, 'main');
      mkdirSync(path.join(plainRepo, '.claude'), { recursive: true });
      writeFileSync(
        path.join(plainRepo, '.claude', 'bdboard-harness.json'),
        JSON.stringify({ version: 1, verify: 'npm test', prFlow: 'pr', mainBranch: 'main' }),
      );
      expectAllow(await runHook({ command: `kill ${process.pid}`, cwd: plainRepo }));
      expectAllow(await runHook({ command: 'git pull --ff-only', cwd: plainRepo, agentId: 'agent-1' }));
    });

    it('does not slow down commands that cannot touch the server (pre-filter)', async () => {
      expectAllow(await runHook({ command: 'ls -la && cat README.md', cwd: mainRepo, agentId: 'agent-1' }));
    });
  });
});
