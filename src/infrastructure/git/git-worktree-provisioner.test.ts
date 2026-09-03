import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CommandResult, CommandRunner } from '../../application/ports/command-runner.js';
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

describe('createGitWorktreeProvisioner', () => {
  it('creates a new worktree from origin/main when available', async () => {
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
