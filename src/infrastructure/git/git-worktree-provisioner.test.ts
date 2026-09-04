import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CommandResult, CommandRunner } from '../../application/ports/command-runner.js';
import {
  startLiveCwdProcess,
  type LiveCwdProcess,
} from '../process/live-cwd-process.test-support.js';
import { NodeCommandRunner } from '../process/node-command-runner.js';
import {
  createGitWorktreeProvisioner,
  formatWorktreeBranchMismatchMessage,
  normalizePathForComparison,
} from './git-worktree-provisioner.js';

const ROOT = '/Users/example/repo';
const TICKET_ID = 'bdboard-54be.1';
const WORKTREE_PATH = path.join(ROOT, '.claude/worktrees', TICKET_ID);
const BRANCH_NAME = `bd/${TICKET_ID}`;

interface FakeRunnerOptions {
  readonly branchListResult?: CommandResult;
  readonly handler?: (
    command: string,
    args: readonly string[],
  ) => Promise<CommandResult> | CommandResult;
}

function createFakeRunner(options: FakeRunnerOptions = {}): {
  runner: CommandRunner;
  readonly calls: Array<{ command: string; args: readonly string[] }>;
} {
  const calls: Array<{ command: string; args: readonly string[] }> = [];

  const runner: CommandRunner = {
    async run(command, args) {
      calls.push({ command, args });
      if (isBranchList(args) && options.branchListResult !== undefined) {
        return options.branchListResult;
      }
      if (options.handler) {
        return await options.handler(command, args);
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };

  return { runner, calls };
}

function isWorktreeList(args: readonly string[]): boolean {
  return args[2] === 'worktree' && args[3] === 'list';
}

function isBranchList(args: readonly string[]): boolean {
  return args[2] === 'for-each-ref';
}

function isFetchOriginMain(args: readonly string[]): boolean {
  return args[2] === 'fetch' && args[3] === 'origin' && args[4] === 'main';
}

function isRevParseOriginMain(args: readonly string[]): boolean {
  return args[2] === 'rev-parse' && args.includes('origin/main');
}

function isWorktreeStatus(worktreePath: string, args: readonly string[]): boolean {
  return args[1] === worktreePath && args[2] === 'status';
}

function isWorktreeHeadBranch(worktreePath: string, args: readonly string[]): boolean {
  return (
    args[1] === worktreePath
    && args[2] === 'rev-parse'
    && args[3] === '--abbrev-ref'
    && args[4] === 'HEAD'
  );
}

function worktreeListWithManaged(
  ticketId: string,
  worktreePath = path.join(ROOT, '.claude/worktrees', ticketId),
): string {
  return [
    `worktree ${ROOT}`,
    'HEAD abc123',
    'branch refs/heads/main',
    '',
    `worktree ${worktreePath}`,
    'HEAD abc123',
    `branch refs/heads/bd/${ticketId}`,
    '',
  ].join('\n');
}

function isMergeCheck(args: readonly string[], branchName: string): boolean {
  return (
    args[2] === 'merge-base'
    && args[3] === '--is-ancestor'
    && args[4] === `refs/heads/${branchName}`
    && args[5] === 'origin/main'
  );
}

function isWorktreeRemove(args: readonly string[], worktreePath: string): boolean {
  return args[2] === 'worktree' && args[3] === 'remove' && args[4] === worktreePath;
}

async function runChecked(
  runner: NodeCommandRunner,
  command: string,
  args: readonly string[],
): Promise<void> {
  const result = await runner.run(command, args, { timeoutMs: 10_000 });
  if (result.exitCode !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr}`);
  }
}

describe('createGitWorktreeProvisioner', () => {
  it('creates a new worktree from origin/main when available', async () => {
    const { runner, calls } = createFakeRunner({
      handler: async (_command, args) => {
        if (args[2] === 'for-each-ref') {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (isWorktreeList(args)) {
          return { stdout: `worktree ${ROOT}\n`, stderr: '', exitCode: 0 };
        }
        if (isFetchOriginMain(args)) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (isRevParseOriginMain(args)) {
          return { stdout: 'abc123\n', stderr: '', exitCode: 0 };
        }
        if (args[2] === 'worktree' && args[3] === 'add' && args[4] === '-b') {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: 'unexpected', exitCode: 1 };
      },
    });

    const provisioner = createGitWorktreeProvisioner({ commandRunner: runner });
    const outcome = await provisioner.provision({
      repoRootPath: ROOT,
      ticketId: TICKET_ID,
    });

    expect(outcome).toEqual({
      ok: true,
      worktreePath: WORKTREE_PATH,
      branchName: BRANCH_NAME,
      reused: false,
    });

    expect(calls.some((call) => call.args.includes('origin/main'))).toBe(true);
    expect(calls.some((call) => isFetchOriginMain(call.args))).toBe(true);
    expect(
      calls.some(
        (call) =>
          call.args[2] === 'worktree'
          && call.args[3] === 'add'
          && call.args[4] === '-b'
          && call.args[5] === BRANCH_NAME
          && call.args[6] === WORKTREE_PATH,
      ),
    ).toBe(true);
  });

  it('removes a clean, idle, merged managed worktree and its branch before creating another', async () => {
    const oldTicketId = 'bdboard-old';
    const oldWorktreePath = path.join(ROOT, '.claude/worktrees', oldTicketId);
    const oldBranchName = `bd/${oldTicketId}`;
    const { runner, calls } = createFakeRunner({
      handler: async (command, args) => {
        if (isWorktreeList(args)) {
          return {
            stdout: worktreeListWithManaged(oldTicketId),
            stderr: '',
            exitCode: 0,
          };
        }
        if (isFetchOriginMain(args) || isRevParseOriginMain(args)) {
          return { stdout: 'abc123\n', stderr: '', exitCode: 0 };
        }
        if (isWorktreeStatus(oldWorktreePath, args) || isMergeCheck(args, oldBranchName)) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command === 'lsof') {
          return { stdout: '', stderr: '', exitCode: 1 };
        }
        if (
          isWorktreeRemove(args, oldWorktreePath)
          || (args[2] === 'branch' && args[3] === '-d' && args[4] === oldBranchName)
          || (args[2] === 'worktree' && args[3] === 'add' && args[4] === '-b')
        ) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (args[2] === 'for-each-ref') {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: 'unexpected', exitCode: 1 };
      },
    });

    const provisioner = createGitWorktreeProvisioner({ commandRunner: runner });
    const outcome = await provisioner.provision({
      repoRootPath: ROOT,
      ticketId: TICKET_ID,
      // 本番 (agent-run-routes) は必ず closed チケットの集合を渡す。省略すると
      // fail-closed で何も消えないので、掃除の経路を踏むテストは本番と同じ形で
      // 明示的に渡す。
      cleanupEligibleTicketIds: [oldTicketId],
    });

    expect(outcome.ok).toBe(true);
    expect(calls.some((call) => isWorktreeRemove(call.args, oldWorktreePath))).toBe(true);
    expect(
      calls.some(
        (call) =>
          call.args[2] === 'branch'
          && call.args[3] === '-d'
          && call.args[4] === oldBranchName,
      ),
    ).toBe(true);
  });

  it('does not remove a merged worktree when lsof reports a process using it', async () => {
    const oldTicketId = 'bdboard-busy';
    const oldWorktreePath = path.join(ROOT, '.claude/worktrees', oldTicketId);
    const oldBranchName = `bd/${oldTicketId}`;
    const { runner, calls } = createFakeRunner({
      handler: async (command, args) => {
        if (isWorktreeList(args)) {
          return {
            stdout: worktreeListWithManaged(oldTicketId),
            stderr: '',
            exitCode: 0,
          };
        }
        if (isFetchOriginMain(args) || isRevParseOriginMain(args)) {
          return { stdout: 'abc123\n', stderr: '', exitCode: 0 };
        }
        if (isWorktreeStatus(oldWorktreePath, args) || isMergeCheck(args, oldBranchName)) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command === 'lsof') {
          return {
            stdout: `node 123 user cwd DIR 1,1 0 1 ${oldWorktreePath}\n`,
            stderr: '',
            exitCode: 0,
          };
        }
        if (args[2] === 'for-each-ref') {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (args[2] === 'worktree' && args[3] === 'add' && args[4] === '-b') {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: 'unexpected', exitCode: 1 };
      },
    });

    const provisioner = createGitWorktreeProvisioner({ commandRunner: runner });
    await provisioner.provision({ repoRootPath: ROOT, ticketId: TICKET_ID });

    expect(calls.some((call) => isWorktreeRemove(call.args, oldWorktreePath))).toBe(false);
  });

  // bdboard-54be.3 の掃除は「merged かつ clean かつ idle」だけでは足りず、
  // 「そのチケットが closed である」ことも条件にしている。open のチケットの
  // worktree は、人がまだ作業している可能性があるので消してはいけない。
  //
  // この性質は eligibility の集合でしか表現されていないので、集合を渡さない
  // 場合の既定が「全部対象」だと静かに失われる。実際そうなっていた:
  // `cleanupEligibleTicketIds` は optional で、undefined は「フィルタ無し」=
  // 全チケットが削除候補、という fail-open な既定だった。省略した呼び出し側は
  // 「どの worktree を消してよいか」を考えなかった側なので、そこが一番広い
  // 権限を得るのは逆である。既定を fail-closed に変えたうえで、ここで固定する。
  it('does not remove a merged, clean, idle worktree whose ticket is not eligible', async () => {
    const openTicketId = 'bdboard-open';
    const openWorktreePath = path.join(ROOT, '.claude/worktrees', openTicketId);
    const openBranchName = `bd/${openTicketId}`;
    const { runner, calls } = createFakeRunner({
      handler: async (command, args) => {
        if (isWorktreeList(args)) {
          return {
            stdout: worktreeListWithManaged(openTicketId),
            stderr: '',
            exitCode: 0,
          };
        }
        if (isFetchOriginMain(args) || isRevParseOriginMain(args)) {
          return { stdout: 'abc123\n', stderr: '', exitCode: 0 };
        }
        // clean かつ merged かつ idle。つまり eligibility 以外の条件はすべて
        // 削除side に揃っており、残る唯一の歯止めが eligibility である。
        if (isWorktreeStatus(openWorktreePath, args) || isMergeCheck(args, openBranchName)) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command === 'lsof') {
          return { stdout: '', stderr: '', exitCode: 1 };
        }
        if (
          isWorktreeRemove(args, openWorktreePath)
          || (args[2] === 'branch' && args[3] === '-d' && args[4] === openBranchName)
          || (args[2] === 'worktree' && args[3] === 'add' && args[4] === '-b')
        ) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (args[2] === 'for-each-ref') {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: 'unexpected', exitCode: 1 };
      },
    });

    const provisioner = createGitWorktreeProvisioner({ commandRunner: runner });
    // closed チケットは別に1件あるが、open の方は含まれていない。
    const outcome = await provisioner.provision({
      repoRootPath: ROOT,
      ticketId: TICKET_ID,
      cleanupEligibleTicketIds: ['bdboard-some-other-closed'],
    });

    expect(outcome.ok).toBe(true);
    expect(calls.some((call) => isWorktreeRemove(call.args, openWorktreePath))).toBe(false);
    expect(
      calls.some(
        (call) =>
          call.args[2] === 'branch'
          && call.args[3] === '-d'
          && call.args[4] === openBranchName,
      ),
    ).toBe(false);
  });

  // 集合そのものを渡し忘れたときも同じく守られること (fail-closed の既定)。
  it('protects every managed worktree when no eligibility filter is supplied', async () => {
    const openTicketId = 'bdboard-unfiltered';
    const openWorktreePath = path.join(ROOT, '.claude/worktrees', openTicketId);
    const openBranchName = `bd/${openTicketId}`;
    const { runner, calls } = createFakeRunner({
      handler: async (command, args) => {
        if (isWorktreeList(args)) {
          return {
            stdout: worktreeListWithManaged(openTicketId),
            stderr: '',
            exitCode: 0,
          };
        }
        if (isFetchOriginMain(args) || isRevParseOriginMain(args)) {
          return { stdout: 'abc123\n', stderr: '', exitCode: 0 };
        }
        if (isWorktreeStatus(openWorktreePath, args) || isMergeCheck(args, openBranchName)) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command === 'lsof') {
          return { stdout: '', stderr: '', exitCode: 1 };
        }
        if (
          isWorktreeRemove(args, openWorktreePath)
          || (args[2] === 'branch' && args[3] === '-d' && args[4] === openBranchName)
          || (args[2] === 'worktree' && args[3] === 'add' && args[4] === '-b')
        ) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (args[2] === 'for-each-ref') {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: 'unexpected', exitCode: 1 };
      },
    });

    const provisioner = createGitWorktreeProvisioner({ commandRunner: runner });
    const outcome = await provisioner.provision({
      repoRootPath: ROOT,
      ticketId: TICKET_ID,
    });

    expect(outcome.ok).toBe(true);
    expect(calls.some((call) => isWorktreeRemove(call.args, openWorktreePath))).toBe(false);
  });

  it('fails closed and does not remove a merged worktree when lsof fails', async () => {
    const oldTicketId = 'bdboard-lsof-failure';
    const oldWorktreePath = path.join(ROOT, '.claude/worktrees', oldTicketId);
    const oldBranchName = `bd/${oldTicketId}`;
    const warnings: string[] = [];
    const { runner, calls } = createFakeRunner({
      handler: async (command, args) => {
        if (isWorktreeList(args)) {
          return {
            stdout: worktreeListWithManaged(oldTicketId),
            stderr: '',
            exitCode: 0,
          };
        }
        if (isFetchOriginMain(args) || isRevParseOriginMain(args)) {
          return { stdout: 'abc123\n', stderr: '', exitCode: 0 };
        }
        if (isWorktreeStatus(oldWorktreePath, args) || isMergeCheck(args, oldBranchName)) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (command === 'lsof') {
          return {
            stdout: '',
            stderr: 'spawn lsof ENOENT',
            exitCode: -1,
            failureKind: 'spawn-failed',
          };
        }
        if (args[2] === 'for-each-ref') {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (args[2] === 'worktree' && args[3] === 'add' && args[4] === '-b') {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: 'unexpected', exitCode: 1 };
      },
    });

    const provisioner = createGitWorktreeProvisioner({
      commandRunner: runner,
      logWarn: (message) => warnings.push(message),
    });
    await provisioner.provision({
      repoRootPath: ROOT,
      ticketId: TICKET_ID,
      cleanupEligibleTicketIds: [oldTicketId],
    });

    expect(calls.some((call) => isWorktreeRemove(call.args, oldWorktreePath))).toBe(false);
    expect(warnings).toEqual([
      `[agent-run cleanup] lsof failed for ${oldWorktreePath}; leaving it untouched`,
    ]);
  });

  it('refuses to create beyond the managed worktree cap when retained work cannot be cleaned', async () => {
    const oldTicketId = 'bdboard-unmerged';
    const oldWorktreePath = path.join(ROOT, '.claude/worktrees', oldTicketId);
    const oldBranchName = `bd/${oldTicketId}`;
    const { runner, calls } = createFakeRunner({
      handler: async (_command, args) => {
        if (isWorktreeList(args)) {
          return {
            stdout: worktreeListWithManaged(oldTicketId),
            stderr: '',
            exitCode: 0,
          };
        }
        if (isFetchOriginMain(args) || isRevParseOriginMain(args)) {
          return { stdout: 'abc123\n', stderr: '', exitCode: 0 };
        }
        if (isWorktreeStatus(oldWorktreePath, args)) {
          return { stdout: ' M src/investigation.ts\n', stderr: '', exitCode: 0 };
        }
        if (args[2] === 'for-each-ref') {
          return { stdout: oldBranchName, stderr: '', exitCode: 0 };
        }
        if (isMergeCheck(args, oldBranchName)) {
          return { stdout: '', stderr: '', exitCode: 1 };
        }
        return { stdout: '', stderr: 'unexpected', exitCode: 1 };
      },
    });

    const provisioner = createGitWorktreeProvisioner({
      commandRunner: runner,
      maxManagedWorktrees: 1,
    });
    const outcome = await provisioner.provision({
      repoRootPath: ROOT,
      ticketId: TICKET_ID,
    });

    expect(outcome).toEqual({
      ok: false,
      reason: 'worktree-limit-reached',
      message:
        'agent-run worktree limit reached (1); finish, merge, or manually remove an existing worktree before retrying',
    });
    expect(calls.some((call) => call.args[2] === 'worktree' && call.args[3] === 'add')).toBe(
      false,
    );
  });

  it('counts an unmerged branch-only leftover toward the managed worktree cap', async () => {
    const oldBranchName = 'bd/bdboard-branch-only';
    const { runner, calls } = createFakeRunner({
      handler: async (_command, args) => {
        if (isWorktreeList(args)) {
          return {
            stdout: [
              `worktree ${ROOT}`,
              'HEAD abc123',
              'branch refs/heads/main',
              '',
            ].join('\n'),
            stderr: '',
            exitCode: 0,
          };
        }
        if (isFetchOriginMain(args) || isRevParseOriginMain(args)) {
          return { stdout: 'abc123\n', stderr: '', exitCode: 0 };
        }
        if (args[2] === 'for-each-ref') {
          return { stdout: `${oldBranchName}\n`, stderr: '', exitCode: 0 };
        }
        if (isMergeCheck(args, oldBranchName)) {
          return { stdout: '', stderr: '', exitCode: 1 };
        }
        return { stdout: '', stderr: 'unexpected', exitCode: 1 };
      },
    });

    const provisioner = createGitWorktreeProvisioner({
      commandRunner: runner,
      maxManagedWorktrees: 1,
    });
    const outcome = await provisioner.provision({
      repoRootPath: ROOT,
      ticketId: TICKET_ID,
    });

    expect(outcome).toEqual({
      ok: false,
      reason: 'worktree-limit-reached',
      message:
        'agent-run worktree limit reached (1); finish, merge, or manually remove an existing worktree before retrying',
    });
    expect(calls.some((call) => call.args[2] === 'worktree' && call.args[3] === 'add')).toBe(
      false,
    );
  });

  it('preserves a disposable merged worktree when a real process has that cwd', async () => {
    const runner = new NodeCommandRunner();
    const lsofProbe = await runner.run('lsof', ['-v'], { timeoutMs: 5_000 });
    if (lsofProbe.failureKind === 'spawn-failed') {
      return;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdboard-lifecycle-'));
    const repoRoot = path.join(tmpDir, 'repo');
    const originPath = path.join(tmpDir, 'origin.git');
    const oldTicketId = 'bdboard-live';
    const oldWorktreePath = path.join(repoRoot, '.claude', 'worktrees', oldTicketId);
    const newTicketId = 'bdboard-next';
    let child: LiveCwdProcess | undefined;

    try {
      fs.mkdirSync(repoRoot, { recursive: true });
      await runChecked(runner, 'git', ['init', '--initial-branch=main', repoRoot]);
      await runChecked(runner, 'git', ['-C', repoRoot, 'config', 'user.name', 'bdboard-test']);
      await runChecked(runner, 'git', ['-C', repoRoot, 'config', 'user.email', 'test@example.invalid']);
      fs.writeFileSync(path.join(repoRoot, 'README.md'), 'fixture\n');
      await runChecked(runner, 'git', ['-C', repoRoot, 'add', 'README.md']);
      await runChecked(runner, 'git', ['-C', repoRoot, 'commit', '-m', 'fixture']);
      await runChecked(runner, 'git', ['init', '--bare', originPath]);
      await runChecked(runner, 'git', ['-C', repoRoot, 'remote', 'add', 'origin', originPath]);
      await runChecked(runner, 'git', ['-C', repoRoot, 'push', '-u', 'origin', 'main']);
      await runChecked(runner, 'git', [
        '-C',
        repoRoot,
        'worktree',
        'add',
        '-b',
        `bd/${oldTicketId}`,
        oldWorktreePath,
        'origin/main',
      ]);

      child = await startLiveCwdProcess(oldWorktreePath);

      const busyProbe = await runner.run(
        'lsof',
        ['-a', '-d', 'cwd', '+D', oldWorktreePath],
        { timeoutMs: 5_000 },
      );
      expect(busyProbe.stdout).toContain(String(child.pid));

      const provisioner = createGitWorktreeProvisioner({ commandRunner: runner });
      const outcome = await provisioner.provision({
        repoRootPath: repoRoot,
        ticketId: newTicketId,
      });

      expect(outcome.ok).toBe(true);
      expect(fs.existsSync(oldWorktreePath)).toBe(true);
      const oldBranch = await runner.run(
        'git',
        ['-C', repoRoot, 'rev-parse', '--verify', `bd/${oldTicketId}`],
        { timeoutMs: 5_000 },
      );
      expect(oldBranch.exitCode).toBe(0);
    } finally {
      if (child !== undefined) {
        await child.stop();
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('reuses a clean existing worktree at the expected path', async () => {
    const { runner, calls } = createFakeRunner({
      handler: async (_command, args) => {
        if (isWorktreeList(args)) {
          return {
            stdout: `worktree ${ROOT}\n\nworktree ${WORKTREE_PATH}\n`,
            stderr: '',
            exitCode: 0,
          };
        }
        if (isWorktreeStatus(WORKTREE_PATH, args)) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (isWorktreeHeadBranch(WORKTREE_PATH, args)) {
          return { stdout: `${BRANCH_NAME}\n`, stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: 'should not run', exitCode: 1 };
      },
    });

    const provisioner = createGitWorktreeProvisioner({ commandRunner: runner });
    const outcome = await provisioner.provision({
      repoRootPath: ROOT,
      ticketId: TICKET_ID,
    });

    expect(outcome).toEqual({
      ok: true,
      worktreePath: WORKTREE_PATH,
      branchName: BRANCH_NAME,
      reused: true,
    });
    expect(calls).toHaveLength(3);
    expect(calls[1]).toEqual({
      command: 'git',
      args: ['-C', WORKTREE_PATH, 'status', '--porcelain'],
    });
    expect(calls[2]).toEqual({
      command: 'git',
      args: ['-C', WORKTREE_PATH, 'rev-parse', '--abbrev-ref', 'HEAD'],
    });
  });

  it('rejects reuse when the existing worktree is on a different branch', async () => {
    const { runner, calls } = createFakeRunner({
      handler: async (_command, args) => {
        if (isWorktreeList(args)) {
          return {
            stdout: `worktree ${ROOT}\n\nworktree ${WORKTREE_PATH}\n`,
            stderr: '',
            exitCode: 0,
          };
        }
        if (isWorktreeStatus(WORKTREE_PATH, args)) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (isWorktreeHeadBranch(WORKTREE_PATH, args)) {
          return { stdout: 'main\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: 'should not run', exitCode: 1 };
      },
    });

    const provisioner = createGitWorktreeProvisioner({ commandRunner: runner });
    const outcome = await provisioner.provision({
      repoRootPath: ROOT,
      ticketId: TICKET_ID,
    });

    expect(outcome).toEqual({
      ok: false,
      reason: 'worktree-branch-mismatch',
      message: formatWorktreeBranchMismatchMessage(WORKTREE_PATH, 'main', BRANCH_NAME),
    });
    expect(calls.some((call) => call.args[2] === 'worktree' && call.args[3] === 'add')).toBe(
      false,
    );
  });

  it('returns git-failed when rev-parse --abbrev-ref HEAD fails during reuse', async () => {
    const { runner } = createFakeRunner({
      handler: async (_command, args) => {
        if (isWorktreeList(args)) {
          return {
            stdout: `worktree ${ROOT}\n\nworktree ${WORKTREE_PATH}\n`,
            stderr: '',
            exitCode: 0,
          };
        }
        if (isWorktreeStatus(WORKTREE_PATH, args)) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (isWorktreeHeadBranch(WORKTREE_PATH, args)) {
          return { stdout: '', stderr: 'not a git repository', exitCode: 128 };
        }
        return { stdout: '', stderr: 'should not run', exitCode: 1 };
      },
    });

    const provisioner = createGitWorktreeProvisioner({ commandRunner: runner });
    const outcome = await provisioner.provision({
      repoRootPath: ROOT,
      ticketId: TICKET_ID,
    });

    expect(outcome).toEqual({
      ok: false,
      reason: 'git-failed',
      message: 'not a git repository',
    });
  });

  it('rejects a dirty existing worktree without reusing it', async () => {
    const { runner, calls } = createFakeRunner({
      handler: async (_command, args) => {
        if (isWorktreeList(args)) {
          return {
            stdout: `worktree ${ROOT}\n\nworktree ${WORKTREE_PATH}\n`,
            stderr: '',
            exitCode: 0,
          };
        }
        if (isWorktreeStatus(WORKTREE_PATH, args)) {
          return { stdout: ' M src/main.ts\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: 'should not run', exitCode: 1 };
      },
    });

    const provisioner = createGitWorktreeProvisioner({ commandRunner: runner });
    const outcome = await provisioner.provision({
      repoRootPath: ROOT,
      ticketId: TICKET_ID,
    });

    expect(outcome).toEqual({
      ok: false,
      reason: 'worktree-dirty',
      message: `${WORKTREE_PATH}: uncommitted changes prevent agent run`,
    });
    expect(calls.some((call) => call.args[2] === 'worktree' && call.args[3] === 'add')).toBe(
      false,
    );
  });

  it('falls back to worktree add without -b when branch already exists', async () => {
    const { runner, calls } = createFakeRunner({
      handler: async (_command, args) => {
        if (args[2] === 'for-each-ref') {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (isWorktreeList(args)) {
          return { stdout: `worktree ${ROOT}\n`, stderr: '', exitCode: 0 };
        }
        if (isFetchOriginMain(args)) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (isRevParseOriginMain(args)) {
          return { stdout: 'abc123\n', stderr: '', exitCode: 0 };
        }
        if (args[2] === 'worktree' && args[3] === 'add' && args[4] === '-b') {
          return { stdout: '', stderr: 'fatal: branch already exists', exitCode: 128 };
        }
        if (args[2] === 'worktree' && args[3] === 'add' && args[4] === WORKTREE_PATH) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: 'unexpected', exitCode: 1 };
      },
    });

    const provisioner = createGitWorktreeProvisioner({ commandRunner: runner });
    const outcome = await provisioner.provision({
      repoRootPath: ROOT,
      ticketId: TICKET_ID,
    });

    expect(outcome).toEqual({
      ok: true,
      worktreePath: WORKTREE_PATH,
      branchName: BRANCH_NAME,
      reused: false,
    });

    expect(
      calls.some(
        (call) =>
          call.args[2] === 'worktree'
          && call.args[3] === 'add'
          && call.args[4] === WORKTREE_PATH
          && call.args[5] === BRANCH_NAME,
      ),
    ).toBe(true);
    expect(calls.some((call) => call.args.includes('origin/main'))).toBe(true);
  });

  it('returns no-base-ref when origin/main cannot be resolved', async () => {
    const { runner, calls } = createFakeRunner({
      handler: async (_command, args) => {
        if (isWorktreeList(args)) {
          return { stdout: `worktree ${ROOT}\n`, stderr: '', exitCode: 0 };
        }
        if (isFetchOriginMain(args)) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (isRevParseOriginMain(args)) {
          return { stdout: '', stderr: 'missing', exitCode: 1 };
        }
        return { stdout: '', stderr: 'should not run', exitCode: 1 };
      },
    });

    const provisioner = createGitWorktreeProvisioner({ commandRunner: runner });
    const outcome = await provisioner.provision({
      repoRootPath: ROOT,
      ticketId: TICKET_ID,
    });

    expect(outcome).toEqual({
      ok: false,
      reason: 'no-base-ref',
      message: 'origin/main could not be resolved',
    });
    expect(calls.some((call) => call.args[2] === 'worktree' && call.args[3] === 'add')).toBe(
      false,
    );
  });

  it('fetches origin/main before resolving the base ref', async () => {
    const { runner, calls } = createFakeRunner({
      handler: async (_command, args) => {
        if (isWorktreeList(args)) {
          return { stdout: `worktree ${ROOT}\n`, stderr: '', exitCode: 0 };
        }
        if (isFetchOriginMain(args)) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (isRevParseOriginMain(args)) {
          return { stdout: 'abc123\n', stderr: '', exitCode: 0 };
        }
        if (args[2] === 'worktree' && args[3] === 'add' && args[4] === '-b') {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: 'unexpected', exitCode: 1 };
      },
    });

    const provisioner = createGitWorktreeProvisioner({ commandRunner: runner });
    await provisioner.provision({ repoRootPath: ROOT, ticketId: TICKET_ID });

    const fetchIndex = calls.findIndex((call) => isFetchOriginMain(call.args));
    const revParseIndex = calls.findIndex((call) => isRevParseOriginMain(call.args));
    expect(fetchIndex).toBeGreaterThanOrEqual(0);
    expect(revParseIndex).toBeGreaterThan(fetchIndex);
  });

  it('continues worktree creation when fetch fails', async () => {
    const { runner, calls } = createFakeRunner({
      handler: async (_command, args) => {
        if (args[2] === 'for-each-ref') {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (isWorktreeList(args)) {
          return { stdout: `worktree ${ROOT}\n`, stderr: '', exitCode: 0 };
        }
        if (isFetchOriginMain(args)) {
          return { stdout: '', stderr: 'network unreachable', exitCode: 128 };
        }
        if (isRevParseOriginMain(args)) {
          return { stdout: 'abc123\n', stderr: '', exitCode: 0 };
        }
        if (args[2] === 'worktree' && args[3] === 'add' && args[4] === '-b') {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: 'unexpected', exitCode: 1 };
      },
    });

    const provisioner = createGitWorktreeProvisioner({ commandRunner: runner });
    const outcome = await provisioner.provision({
      repoRootPath: ROOT,
      ticketId: TICKET_ID,
    });

    expect(outcome).toEqual({
      ok: true,
      worktreePath: WORKTREE_PATH,
      branchName: BRANCH_NAME,
      reused: false,
    });
    expect(calls.some((call) => isFetchOriginMain(call.args))).toBe(true);
  });

  it('rejects ticket ids that fail path traversal checks without throwing', async () => {
    const { runner, calls } = createFakeRunner();

    const provisioner = createGitWorktreeProvisioner({ commandRunner: runner });

    for (const ticketId of ['', 'nodash', 'x-a/b', 'x-a\\b', 'x-a..b', '-foo-1', '.foo-1']) {
      const outcome = await provisioner.provision({
        repoRootPath: ROOT,
        ticketId,
      });
      expect(outcome).toEqual({ ok: false, reason: 'invalid-ticket-id' });
    }

    expect(calls).toHaveLength(0);
  });

  it('rejects ticket ids that fail the worktree allowlist without throwing', async () => {
    const { runner, calls } = createFakeRunner();
    const provisioner = createGitWorktreeProvisioner({ commandRunner: runner });

    for (const ticketId of [
      'bdboard-a)b',
      'bdboard-a*b',
      'bdboard-a b',
      'bdboard-a/b',
      '.hidden',
      '-dash',
    ]) {
      const outcome = await provisioner.provision({
        repoRootPath: ROOT,
        ticketId,
      });
      expect(outcome).toEqual({ ok: false, reason: 'invalid-ticket-id' });
    }

    expect(calls).toHaveLength(0);
  });

  it('accepts ticket ids that pass the worktree allowlist', async () => {
    const { runner, calls } = createFakeRunner({
      handler: async (_command, args) => {
        if (args[2] === 'for-each-ref') {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (isWorktreeList(args)) {
          return { stdout: `worktree ${ROOT}\n`, stderr: '', exitCode: 0 };
        }
        if (isFetchOriginMain(args)) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (isRevParseOriginMain(args)) {
          return { stdout: 'abc123\n', stderr: '', exitCode: 0 };
        }
        if (args[2] === 'worktree' && args[3] === 'add' && args[4] === '-b') {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: 'unexpected', exitCode: 1 };
      },
    });

    const provisioner = createGitWorktreeProvisioner({ commandRunner: runner });

    for (const ticketId of ['bdboard-54be.1', 'bdboard-abc']) {
      const outcome = await provisioner.provision({
        repoRootPath: ROOT,
        ticketId,
      });
      expect(outcome.ok).toBe(true);
    }

    expect(calls.length).toBeGreaterThan(0);
  });

  it('detects existing worktrees through symlink-normalized paths', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdboard-wt-'));
    const linkPath = path.join(tmpDir, 'linked-worktree');
    fs.symlinkSync(tmpDir, linkPath);

    expect(normalizePathForComparison(linkPath)).toBe(normalizePathForComparison(tmpDir));

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('matches worktree list entries via realpath normalization', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdboard-wt-'));
    const linkedRoot = path.join(tmpDir, 'repo');
    const actualWorktree = path.join(linkedRoot, '.claude', 'worktrees', TICKET_ID);
    const linkedWorktree = path.join(tmpDir, 'linked-worktree');
    fs.mkdirSync(actualWorktree, { recursive: true });
    fs.symlinkSync(actualWorktree, linkedWorktree);

    const { runner } = createFakeRunner({
      handler: async (_command, args) => {
        if (isWorktreeList(args)) {
          return {
            stdout: `worktree ${linkedRoot}\n\nworktree ${linkedWorktree}\n`,
            stderr: '',
            exitCode: 0,
          };
        }
        if (isWorktreeStatus(linkedWorktree, args)) {
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (isWorktreeHeadBranch(linkedWorktree, args)) {
          return { stdout: `${BRANCH_NAME}\n`, stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: 'should not run', exitCode: 1 };
      },
    });

    const provisioner = createGitWorktreeProvisioner({ commandRunner: runner });
    const outcome = await provisioner.provision({
      repoRootPath: linkedRoot,
      ticketId: TICKET_ID,
    });

    expect(outcome).toEqual({
      ok: true,
      worktreePath: linkedWorktree,
      branchName: BRANCH_NAME,
      reused: true,
    });

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
