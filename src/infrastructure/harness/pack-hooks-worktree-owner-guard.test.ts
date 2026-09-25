import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CommandResult } from '../../application/ports/command-runner.js';
import { NodeCommandRunner } from '../process/node-command-runner.js';

const PACKS_ROOT = fileURLToPath(new URL('../../../harness/packs/', import.meta.url));
const PRE_BASH_GUARD = path.join(PACKS_ROOT, 'bdboard-harness', 'hooks', 'pre-bash-guard.sh');
const runner = new NodeCommandRunner();
const GIT_IDENTITY = ['-c', 'user.name=bdboard-test', '-c', 'user.email=bdboard-test@example.invalid', '-c', 'commit.gpgsign=false'];

describe.skipIf(process.platform === 'win32')('bdboard-harness worktree owner guard (bdboard-gsnn)', () => {
  let tmpRoot: string;
  let env: Record<string, string>;
  let main: string;
  let wtA: string;
  let wtB: string;

  beforeAll(async () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'bdboard-worktree-owner-guard-'));
    const home = path.join(tmpRoot, 'home');
    mkdirSync(home, { recursive: true });
    env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, TMPDIR: tmpRoot };
    main = path.join(tmpRoot, 'main');
    await initGitRepo(main, 'main');
    writeContract(main, { version: 1 });
    await runGit(main, ['add', '.claude']);
    await runGit(main, [...GIT_IDENTITY, 'commit', '-q', '-m', 'contract']);
    wtA = path.join(main, '.claude', 'worktrees', 'ticket-a');
    wtB = path.join(main, '.claude', 'worktrees', 'ticket-b');
    await runGit(main, ['worktree', 'add', '-q', wtA, '-b', 'bd/ticket-a']);
    await runGit(main, ['worktree', 'add', '-q', wtB, '-b', 'bd/ticket-b']);
  });

  beforeEach(() => {
    rmSync(path.join(main, '.git', 'bdboard-worktree-owners'), { recursive: true, force: true });
    mkdirSync(path.join(main, '.git', 'bdboard-worktree-owners'), { recursive: true });
  });

  afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

  function writeContract(repoPath: string, contract: Record<string, unknown>): void {
    mkdirSync(path.join(repoPath, '.claude'), { recursive: true });
    writeFileSync(path.join(repoPath, '.claude', 'bdboard-harness.json'), JSON.stringify(contract));
  }

  async function runGit(cwd: string, args: readonly string[]): Promise<void> {
    const result = await runner.run('git', args, { cwd, env, timeoutMs: 20_000 });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed (${result.exitCode}): ${result.stderr}`);
  }

  async function initGitRepo(repoPath: string, branch: string): Promise<void> {
    mkdirSync(repoPath, { recursive: true });
    await runGit(repoPath, ['init', '-q']);
    await runGit(repoPath, ['checkout', '-q', '-b', branch]);
    await runGit(repoPath, [...GIT_IDENTITY, 'commit', '-q', '--allow-empty', '-m', 'init']);
  }

  async function runBashHook(call: { command: string; cwd: string; agentId?: string }): Promise<CommandResult> {
    const payload: Record<string, unknown> = { tool_name: 'Bash', tool_input: { command: call.command }, cwd: call.cwd };
    if (call.agentId !== undefined) payload.agent_id = call.agentId;
    return runner.run('bash', [PRE_BASH_GUARD], {
      input: JSON.stringify(payload), cwd: call.cwd, env, timeoutMs: 20_000,
    });
  }

  function expectDeny(result: CommandResult, ...fragments: readonly string[]): void {
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    const lines = result.stderr.split('\n').filter((line) => line.length > 0);
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(lines[0]).toMatch(/^bdboard-harness: /);
    for (const fragment of fragments) expect(result.stderr).toContain(fragment);
  }

  function expectAllow(result: CommandResult): void {
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  }

  async function claimA(): Promise<void> {
    expectAllow(await runBashHook({ command: `cd ${wtA} && git commit -m x --allow-empty`, cwd: main, agentId: 'agent-1' }));
  }

  it('denies another agent commit in the owned worktree', async () => {
    await claimA();
    expectDeny(await runBashHook({ command: `cd ${wtA} && git commit -m y --allow-empty`, cwd: main, agentId: 'agent-2' }), 'worktree', 'bd/ticket-a');
  });
  it('denies another agent push in the owned worktree', async () => {
    await claimA();
    expectDeny(await runBashHook({ command: `cd ${wtA} && git push`, cwd: main, agentId: 'agent-2' }), 'worktree', 'bd/ticket-a');
  });
  it('denies removing another agent worktree via git -C', async () => {
    await claimA();
    expectDeny(await runBashHook({ command: `git -C ${wtA} worktree remove ${wtA}`, cwd: main, agentId: 'agent-2' }), 'worktree', 'bd/ticket-a');
  });
  it('denies force deleting another agent branch', async () => {
    await claimA();
    expectDeny(await runBashHook({ command: 'git branch -D bd/ticket-a', cwd: main, agentId: 'agent-2' }), 'worktree', 'bd/ticket-a');
  });
  it('denies merge-pr prepare in the owned worktree', async () => {
    await claimA();
    expectDeny(await runBashHook({ command: `cd ${wtA} && npm run merge-pr -- prepare 1`, cwd: main, agentId: 'agent-2' }), 'worktree', 'bd/ticket-a');
  });
  it('denies merge-pr gate --repair in the owned worktree', async () => {
    await claimA();
    expectDeny(await runBashHook({ command: `cd ${wtA} && npm run merge-pr -- gate 1 --repair`, cwd: main, agentId: 'agent-2' }), 'worktree', 'bd/ticket-a');
  });
  it('denies gh pr merge in the owned worktree', async () => {
    await claimA();
    expectDeny(await runBashHook({ command: `cd ${wtA} && gh pr merge 1`, cwd: main, agentId: 'agent-2' }), 'worktree', 'bd/ticket-a');
  });
  it('denies release from a subagent in any cwd', async () => {
    expectDeny(await runBashHook({ command: 'bash scripts/worktree-owner.sh release ticket-a', cwd: main, agentId: 'agent-2' }), '議長専用');
  });
  it('allows the owner commit', async () => {
    await claimA();
    expectAllow(await runBashHook({ command: `cd ${wtA} && git commit -m x --allow-empty`, cwd: main, agentId: 'agent-1' }));
  });
  it('allows the chair push in another agent worktree', async () => {
    await claimA();
    expectAllow(await runBashHook({ command: `cd ${wtA} && git push`, cwd: main }));
  });
  it('lets the first subagent claim an unowned worktree', async () => {
    expectAllow(await runBashHook({ command: `cd ${wtB} && git commit -m x --allow-empty`, cwd: main, agentId: 'agent-2' }));
  });
  it('denies a later different agent after delayed claim', async () => {
    expectAllow(await runBashHook({ command: `cd ${wtB} && git commit -m x --allow-empty`, cwd: main, agentId: 'agent-2' }));
    expectDeny(await runBashHook({ command: `cd ${wtB} && git push`, cwd: main, agentId: 'agent-1' }), 'worktree', 'bd/ticket-b');
  });
  it('allows read only status from another subagent', async () => {
    await claimA();
    expectAllow(await runBashHook({ command: `cd ${wtA} && git status`, cwd: main, agentId: 'agent-2' }));
  });
  it('allows chair release command', async () => {
    expectAllow(await runBashHook({ command: 'scripts/worktree-owner.sh release ticket-a', cwd: main }));
  });
  it('allows other git commands in the worktree', async () => {
    await claimA();
    expectAllow(await runBashHook({ command: `cd ${wtA} && git log -1`, cwd: main, agentId: 'agent-1' }));
  });
});
