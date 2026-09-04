import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandResult } from '../../application/ports/command-runner.js';
import { NodeCommandRunner } from '../process/node-command-runner.js';
import { createFsPackRegistry } from './fs-pack-registry.js';

/**
 * bdboard-harness パックの hooks/ スクリプトの統合テスト (bdboard-pkr6.1)。
 *
 * hook は Claude Code から「bash で spawn し stdin に JSON を流す」形でしか
 * 呼ばれないので、テストも同じ形で叩く。ロジックを TypeScript に写して単体テスト
 * しても、実際に走るシェルの挙動 (bash 3.2 互換性・grep の方言・git の呼び出し) は
 * 何も保証されないため。
 *
 * Windows CI では skip する: 対象がそもそも POSIX シェルスクリプトで、bash・
 * coreutils・chmod による実行ビットが揃っている前提で書かれている。
 *
 * 実行ビットには依存せず `bash <script>` で呼ぶ (注入時の chmod は bdboard-pkr6.2)。
 */

const PACKS_ROOT = fileURLToPath(new URL('../../../harness/packs/', import.meta.url));
const HOOKS_DIR = path.join(PACKS_ROOT, 'bdboard-harness', 'hooks');

const PRE_BASH_GUARD = path.join(HOOKS_DIR, 'pre-bash-guard.sh');
const PRE_EDIT_GUARD = path.join(HOOKS_DIR, 'pre-edit-guard.sh');
const STOP_TICKET_GATE = path.join(HOOKS_DIR, 'stop-ticket-gate.sh');

const runner = new NodeCommandRunner();

interface RunOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
}

async function runHook(
  script: string,
  payload: Record<string, unknown>,
  options?: RunOptions,
): Promise<CommandResult> {
  return runner.run('bash', [script], {
    input: JSON.stringify(payload),
    timeoutMs: 20_000,
    ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options?.env === undefined ? {} : { env: options.env }),
  });
}

describe.skipIf(process.platform === 'win32')('bdboard-harness pack hooks', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'bdboard-pack-hooks-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe('pack packaging', () => {
    it('enumerates hooks/ as injectable pack files', async () => {
      const registry = createFsPackRegistry(PACKS_ROOT);
      const pack = await registry.getPack('bdboard-harness');

      const relativePaths = (pack?.files ?? []).map((file) => file.relativePath);
      expect(relativePaths).toEqual(
        expect.arrayContaining([
          'hooks/README.md',
          'hooks/pre-bash-guard.sh',
          'hooks/pre-edit-guard.sh',
          'hooks/stop-ticket-gate.sh',
        ]),
      );
    });
  });

  describe('pre-bash-guard.sh', () => {
    // 各ケースは repo 外の一時ディレクトリを cwd にする。検証コントラクトの
    // 有無で判定が変わる規則があるので、bdboard 自身の worktree に依存させない。
    const denyCases: ReadonlyArray<{
      readonly name: string;
      readonly payload: Record<string, unknown>;
      readonly stderrIncludes: string;
    }> = [
      {
        name: 'pkill',
        payload: { tool_name: 'Bash', tool_input: { command: 'pkill -f tsx' } },
        stderrIncludes: 'pkill/killall',
      },
      {
        name: 'bd dolt push without --remote',
        payload: { tool_name: 'Bash', tool_input: { command: 'bd dolt push' } },
        stderrIncludes: '--remote',
      },
      {
        name: 'git stash pop',
        payload: { tool_name: 'Bash', tool_input: { command: 'git stash pop' } },
        stderrIncludes: 'git stash push -u -m',
      },
      {
        name: 'trailing & together with run_in_background',
        payload: {
          tool_name: 'Bash',
          tool_input: { command: 'npm run verify > /tmp/v.log 2>&1 &', run_in_background: true },
        },
        stderrIncludes: 'run_in_background',
      },
    ];

    for (const denyCase of denyCases) {
      it(`denies ${denyCase.name} with exit 2 and an alternative`, async () => {
        const result = await runHook(PRE_BASH_GUARD, { ...denyCase.payload, cwd: tmpRoot });

        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain(denyCase.stderrIncludes);
        expect(result.stderr.trim().split('\n').length).toBeLessThanOrEqual(3);
      });
    }

    const allowCases: ReadonlyArray<{
      readonly name: string;
      readonly payload: Record<string, unknown>;
    }> = [
      {
        name: 'pgrep -x',
        payload: { tool_name: 'Bash', tool_input: { command: 'pgrep -x node' } },
      },
      {
        name: 'git stash push -u -m',
        payload: { tool_name: 'Bash', tool_input: { command: 'git stash push -u -m "wip"' } },
      },
      {
        name: 'bd dolt push --remote legacy',
        payload: { tool_name: 'Bash', tool_input: { command: 'bd dolt push --remote legacy' } },
      },
      {
        // 2>&1 は末尾 & ではない。run_in_background:true でも通ること。
        name: 'redirect-only background command',
        payload: {
          tool_name: 'Bash',
          tool_input: {
            command: 'npm run verify > /tmp/v.log 2>&1; echo EXIT=$? >> /tmp/v.log',
            run_in_background: true,
          },
        },
      },
    ];

    for (const allowCase of allowCases) {
      it(`allows ${allowCase.name} silently`, async () => {
        const result = await runHook(PRE_BASH_GUARD, { ...allowCase.payload, cwd: tmpRoot });

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe('');
      });
    }

    it('denies a project contract pattern with the contract message', async () => {
      const projectRoot = path.join(tmpRoot, 'project');
      mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
      const env = isolatedEnv();
      await initGitRepo(projectRoot, 'main', env);
      writeFileSync(
        path.join(projectRoot, '.claude', 'bdboard-harness.json'),
        `${JSON.stringify({
          mainBranch: 'main',
          hooks: {
            denyBashPatterns: ['npm run verify:steps'],
            denyBashMessages: ['verify:steps は直叩き禁止です。npm run verify を使ってください。'],
          },
        })}\n`,
        'utf8',
      );

      const denied = await runHook(
        PRE_BASH_GUARD,
        { tool_name: 'Bash', cwd: projectRoot, tool_input: { command: 'npm run verify:steps' } },
        { cwd: projectRoot, env },
      );
      expect(denied.exitCode).toBe(2);
      expect(denied.stderr).toContain('verify:steps は直叩き禁止です');

      const allowed = await runHook(
        PRE_BASH_GUARD,
        { tool_name: 'Bash', cwd: projectRoot, tool_input: { command: 'npm run verify' } },
        { cwd: projectRoot, env },
      );
      expect(allowed.exitCode).toBe(0);
      expect(allowed.stderr).toBe('');
    });
  });

  describe('pre-edit-guard.sh', () => {
    it('denies editing the injected copy of the pack', async () => {
      const target = path.join(tmpRoot, '.claude', 'skills', 'bdboard-harness', 'SKILL.md');
      const result = await runHook(PRE_EDIT_GUARD, {
        tool_name: 'Edit',
        cwd: tmpRoot,
        tool_input: { file_path: target },
      });

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('harness/packs/bdboard-harness/');
    });

    it('denies .beads/ edits on a bd/ branch', async () => {
      const env = isolatedEnv();
      const repo = path.join(tmpRoot, 'repo');
      await initGitRepo(repo, 'bd/test-1', env);

      const result = await runHook(
        PRE_EDIT_GUARD,
        {
          tool_name: 'Write',
          cwd: repo,
          tool_input: { file_path: path.join(repo, '.beads', 'issues.jsonl') },
        },
        { cwd: repo, env },
      );

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('bd/test-1');
    });

    it('allows .beads/ edits outside a bd/ branch', async () => {
      const env = isolatedEnv();
      const repo = path.join(tmpRoot, 'repo');
      await initGitRepo(repo, 'main', env);

      const result = await runHook(
        PRE_EDIT_GUARD,
        {
          tool_name: 'Write',
          cwd: repo,
          tool_input: { file_path: path.join(repo, '.beads', 'issues.jsonl') },
        },
        { cwd: repo, env },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
    });

    it('allows an ordinary source file', async () => {
      const result = await runHook(PRE_EDIT_GUARD, {
        tool_name: 'Edit',
        cwd: tmpRoot,
        tool_input: { file_path: path.join(tmpRoot, 'src', 'foo.ts') },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
    });

    it('normalizes notebook_path before matching', async () => {
      const target = path.join(tmpRoot, 'src', '..', '.claude', 'skills', 'bdboard-harness', 'a.ipynb');
      const result = await runHook(PRE_EDIT_GUARD, {
        tool_name: 'NotebookEdit',
        cwd: tmpRoot,
        tool_input: { notebook_path: target },
      });

      expect(result.exitCode).toBe(2);
    });
  });

  describe('stop-ticket-gate.sh', () => {
    /**
     * Stop hook は bd を叩くので、PATH の先頭に固定 JSON を返す fake bd を置いた
     * 一時ディレクトリを差し込む。実際の .beads/ を読ませないため。
     */
    async function setupTicketWorktree(options: {
      readonly branch: string;
      readonly comments: string;
      readonly dirty: boolean;
    }): Promise<{ repo: string; env: Record<string, string> }> {
      const binDir = path.join(tmpRoot, 'bin');
      mkdirSync(binDir, { recursive: true });
      const fakeBd = path.join(binDir, 'bd');
      writeFileSync(
        fakeBd,
        [
          '#!/bin/sh',
          'case "$1" in',
          `  show) cat <<'BD_SHOW_EOF'`,
          JSON.stringify([{ id: 'test-1', status: 'in_progress' }]),
          'BD_SHOW_EOF',
          '    ;;',
          `  comments) cat <<'BD_COMMENTS_EOF'`,
          options.comments,
          'BD_COMMENTS_EOF',
          '    ;;',
          '  *) exit 1 ;;',
          'esac',
          '',
        ].join('\n'),
        'utf8',
      );
      chmodSync(fakeBd, 0o755);

      const env = isolatedEnv(binDir);
      const repo = path.join(tmpRoot, 'repo');
      await initGitRepo(repo, options.branch, env);
      if (options.dirty) {
        writeFileSync(path.join(repo, 'dirty.txt'), 'wip\n', 'utf8');
      }

      return { repo, env };
    }

    it('passes when the branch is not a per-ticket branch', async () => {
      const { repo, env } = await setupTicketWorktree({
        branch: 'main',
        comments: '[]',
        dirty: true,
      });

      const result = await runHook(
        STOP_TICKET_GATE,
        { hook_event_name: 'Stop', cwd: repo },
        { cwd: repo, env },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
    });

    it('passes when stop_hook_active is true', async () => {
      const { repo, env } = await setupTicketWorktree({
        branch: 'bd/test-1',
        comments: '[]',
        dirty: true,
      });

      const result = await runHook(
        STOP_TICKET_GATE,
        { hook_event_name: 'Stop', cwd: repo, stop_hook_active: true },
        { cwd: repo, env },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
    });

    it('passes when a PR comment already exists', async () => {
      const { repo, env } = await setupTicketWorktree({
        branch: 'bd/test-1',
        comments: JSON.stringify([
          { text: 'PR: https://example.invalid/pull/1', created_at: '2020-01-01T00:00:00Z' },
        ]),
        dirty: true,
      });

      const result = await runHook(
        STOP_TICKET_GATE,
        { hook_event_name: 'Stop', cwd: repo },
        { cwd: repo, env },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
    });

    it('blocks an in_progress ticket with uncommitted work and no trace', async () => {
      const { repo, env } = await setupTicketWorktree({
        branch: 'bd/test-1',
        comments: '[]',
        dirty: true,
      });

      const result = await runHook(
        STOP_TICKET_GATE,
        { hook_event_name: 'Stop', cwd: repo },
        { cwd: repo, env },
      );

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('test-1');
      expect(result.stderr).toContain('in_progress');
      expect(result.stderr.trim().split('\n').length).toBeLessThanOrEqual(3);
    });

    it('passes when the working tree is clean', async () => {
      const { repo, env } = await setupTicketWorktree({
        branch: 'bd/test-1',
        comments: '[]',
        dirty: false,
      });

      const result = await runHook(
        STOP_TICKET_GATE,
        { hook_event_name: 'Stop', cwd: repo },
        { cwd: repo, env },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
    });

    it('passes when the latest comment is within 15 minutes', async () => {
      // bd の created_at は秒精度の UTC。ミリ秒を落として同じ形にそろえる。
      const recent = new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      const { repo, env } = await setupTicketWorktree({
        branch: 'bd/test-1',
        comments: JSON.stringify([{ text: '作業中断: 残りは X', created_at: recent }]),
        dirty: true,
      });

      const result = await runHook(
        STOP_TICKET_GATE,
        { hook_event_name: 'Stop', cwd: repo },
        { cwd: repo, env },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
    });
  });

  /**
   * 子プロセスの環境を最小限に固定する。NodeCommandRunner の `env` は継承ではなく
   * 置き換えなので、PATH と HOME だけを与えてユーザーの global gitconfig や
   * 実物の bd を巻き込まないようにする。
   */
  function isolatedEnv(pathPrefix?: string): Record<string, string> {
    const home = path.join(tmpRoot, 'home');
    mkdirSync(home, { recursive: true });
    const basePath = process.env.PATH ?? '/usr/bin:/bin';
    return {
      PATH: pathPrefix === undefined ? basePath : `${pathPrefix}${path.delimiter}${basePath}`,
      HOME: home,
    };
  }

  async function initGitRepo(
    repoPath: string,
    branch: string,
    env: Record<string, string>,
  ): Promise<void> {
    mkdirSync(repoPath, { recursive: true });
    await runGit(repoPath, ['init', '-q'], env);
    await runGit(repoPath, ['checkout', '-q', '-b', branch], env);
    await runGit(
      repoPath,
      [
        '-c',
        'user.name=bdboard-test',
        '-c',
        'user.email=bdboard-test@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'init',
      ],
      env,
    );
  }

  async function runGit(
    cwd: string,
    args: readonly string[],
    env: Record<string, string>,
  ): Promise<void> {
    const result = await runner.run('git', args, { cwd, env, timeoutMs: 20_000 });
    if (result.exitCode !== 0) {
      throw new Error(`git ${args.join(' ')} failed (${result.exitCode}): ${result.stderr}`);
    }
  }
});
