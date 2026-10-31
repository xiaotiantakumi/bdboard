import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandResult } from '../../application/ports/command-runner.js';
import { NodeCommandRunner } from '../process/node-command-runner.js';
import { RM_OPTIONS, quietGitEnv } from '../../../scripts/test-support/quiet-git.mjs';

/**
 * bdboard-harness パックの scripts/close-ticket.py の統合テスト (bdboard-7yfj.5)。
 *
 * bd / gh / lsof は PATH 先頭の stub (bd は引数を記録し show に固定の status を返す。gh は state と
 * mergeCommit をファイルから返す。lsof はファイルの中身を出す)。git は一時ディレクトリの本物の
 * リポジトリ (bare origin と linked worktree 付き)。
 */

const PACKS_ROOT = fileURLToPath(new URL('../../../harness/packs/', import.meta.url));
const SCRIPT = path.join(PACKS_ROOT, 'bdboard-harness', 'scripts', 'close-ticket.py');
const PR_URL = 'https://github.com/example/repo/pull/42';

const runner = new NodeCommandRunner();

async function toolAvailable(cmd: string): Promise<boolean> {
  try {
    const r = await runner.run(cmd, ['--version'], { timeoutMs: 5_000 });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

const HAS_TOOLS = (await toolAvailable('python3')) && (await toolAvailable('git'));

describe.skipIf(process.platform === 'win32' || !HAS_TOOLS)(
  'bdboard-harness scripts/close-ticket.py',
  () => {
    let tmpRoot: string;
    let repo: string;
    let env: Record<string, string>;
    let callsLog: string;
    let mergedOid: string;

    async function git(cwd: string, ...args: string[]): Promise<CommandResult> {
      const r = await runner.run('git', args, { cwd, env, timeoutMs: 20_000 });
      expect(r.exitCode, `git ${args.join(' ')}: ${r.stderr}`).toBe(0);
      return r;
    }

    const wt = (): string => path.join(repo, '.claude', 'worktrees', 'proj-a1');

    function setGh(state: string, oid: string | null): void {
      writeFileSync(
        path.join(tmpRoot, 'gh.json'),
        JSON.stringify({ state, mergeCommit: oid ? { oid } : null }),
        'utf8',
      );
    }

    beforeEach(async () => {
      tmpRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'bdboard-close-ticket-')));
      const binDir = path.join(tmpRoot, 'bin');
      mkdirSync(binDir, { recursive: true });
      callsLog = path.join(tmpRoot, 'calls.jsonl');
      writeFileSync(callsLog, '', 'utf8');
      repo = path.join(tmpRoot, 'repo');

      const py = (name: string, lines: string[]): void => {
        const p = path.join(binDir, name);
        writeFileSync(p, ['#!/usr/bin/env python3', ...lines, ''].join('\n'), 'utf8');
        chmodSync(p, 0o755);
      };
      py('bd', [
        'import json, sys',
        'a = sys.argv[1:]',
        `open(${JSON.stringify(callsLog)}, "a").write(json.dumps(a) + "\\n")`,
        'if a[:1] == ["show"]:',
        '    if a[1] == "proj-missing":',
        '        sys.stderr.write("not found\\n"); sys.exit(1)',
        '    st = "closed" if a[1] == "proj-done" else "in_progress"',
        '    print(json.dumps([{"id": a[1], "status": st}]))',
      ]);
      py('gh', [
        'import sys',
        `sys.stdout.write(open(${JSON.stringify(path.join(tmpRoot, 'gh.json'))}).read())`,
      ]);
      py('lsof', [
        'import os, sys',
        `p = ${JSON.stringify(path.join(tmpRoot, 'lsof.txt'))}`,
        'if os.path.exists(p):',
        '    sys.stdout.write(open(p).read()); sys.exit(0)',
        'sys.exit(1)',
      ]);
      env = {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? '/usr/bin:/bin'}`,
        HOME: tmpRoot,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.com',
        // bdboard-5py8: git の自動保守を止める (後始末の rmSync と競わないように)
        ...quietGitEnv(tmpRoot),
        GIT_CONFIG_SYSTEM: '/dev/null',
      };
      const origin = path.join(tmpRoot, 'origin.git');
      mkdirSync(origin, { recursive: true });
      await git(origin, 'init', '--bare', '-b', 'main');
      mkdirSync(repo, { recursive: true });
      await git(repo, 'init', '-b', 'main');
      writeFileSync(path.join(repo, 'a.txt'), 'a\n', 'utf8');
      await git(repo, 'add', 'a.txt');
      await git(repo, 'commit', '-m', 'init');
      await git(repo, 'remote', 'add', 'origin', origin);
      await git(repo, 'push', '-u', 'origin', 'main');
      mergedOid = (await git(repo, 'rev-parse', 'HEAD')).stdout.trim();
      mkdirSync(path.join(repo, '.claude', 'worktrees'), { recursive: true });
      await git(repo, 'worktree', 'add', wt(), '-b', 'bd/proj-a1', 'origin/main');
      setGh('MERGED', mergedOid);
    });

    afterEach(() => {
      rmSync(tmpRoot, RM_OPTIONS);
    });

    function writeSpec(spec: Record<string, unknown>): string {
      const p = path.join(tmpRoot, 'spec.json');
      writeFileSync(p, JSON.stringify(spec), 'utf8');
      return p;
    }

    function run(args: readonly string[], cwd: string = repo): Promise<CommandResult> {
      return runner.run('python3', [SCRIPT, ...args], { cwd, env, timeoutMs: 30_000 });
    }

    function calls(): string[][] {
      return readFileSync(callsLog, 'utf8')
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as string[]);
    }

    const writes = (): string[][] => calls().filter((c) => c[0] !== 'show');
    const spec = { ticket: 'proj-a1', pr_url: PR_URL };

    it('comments, closes, removes the worktree and branch, prunes; last stdout line is the ticket id', async () => {
      const r = await run(['--spec', writeSpec(spec)]);
      expect(r.exitCode, r.stderr).toBe(0);
      expect(r.stdout.trim().split('\n').pop()).toBe('proj-a1');
      expect(writes()).toEqual([
        ['comment', 'proj-a1', `PR: ${PR_URL} merged (${mergedOid.slice(0, 9)})`],
        ['close', 'proj-a1'],
      ]);
      expect(existsSync(wt())).toBe(false);
      const branches = await git(repo, 'branch', '--list', 'bd/proj-a1');
      expect(branches.stdout.trim()).toBe('');
    });

    it('rejects an unmerged PR with the close-after-merge message and never calls bd write', async () => {
      setGh('OPEN', null);
      const r = await run(['--spec', writeSpec(spec)]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('close はマージ後だけ');
      expect(writes()).toEqual([]);
      expect(existsSync(wt())).toBe(true);
    });

    it('rejects when mergeCommit is not in origin/main', async () => {
      writeFileSync(path.join(wt(), 'b.txt'), 'b\n', 'utf8');
      await git(wt(), 'add', 'b.txt');
      await git(wt(), 'commit', '-m', 'unpushed');
      const local = (await git(wt(), 'rev-parse', 'HEAD')).stdout.trim();
      setGh('MERGED', local);
      const r = await run(['--spec', writeSpec(spec)]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('origin/main に含まれていません');
      expect(writes()).toEqual([]);
      expect(existsSync(wt())).toBe(true);
    });

    it('rejects when another process uses the worktree', async () => {
      writeFileSync(
        path.join(tmpRoot, 'lsof.txt'),
        `COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nclaude 123 me cwd DIR 1,1 1 1 ${wt()}\n`,
        'utf8',
      );
      const r = await run(['--spec', writeSpec(spec)]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('使用中');
      expect(r.stderr).toContain('claude 123');
      expect(writes()).toEqual([]);
      expect(existsSync(wt())).toBe(true);
    });

    it('--keep-worktree closes but leaves the worktree and branch', async () => {
      const r = await run(['--spec', writeSpec(spec), '--keep-worktree']);
      expect(r.exitCode, r.stderr).toBe(0);
      expect(writes().map((c) => c[0])).toEqual(['comment', 'close']);
      expect(existsSync(wt())).toBe(true);
      const branches = await git(repo, 'branch', '--list', 'bd/proj-a1');
      expect(branches.stdout).toContain('bd/proj-a1');
    });

    it('skips cleanup when the worktree does not exist', async () => {
      const r = await run(['--spec', writeSpec({ ...spec, worktree: path.join(repo, '.claude', 'worktrees', 'none') })]);
      expect(r.exitCode, r.stderr).toBe(0);
      expect(writes().map((c) => c[0])).toEqual(['comment', 'close']);
      expect(existsSync(wt())).toBe(true);
    });

    it('rejects spec violations with all reasons and calls nothing', async () => {
      const r = await run(['--spec', writeSpec({ ticket: 'bad ticket!', pr_url: 'http://x/pull/1', branch: 'feature/x', extra: 1 })]);
      expect(r.exitCode).toBe(1);
      for (const key of ['spec.ticket', 'spec.pr_url', 'spec.branch', 'spec.extra']) {
        expect(r.stderr).toContain(`ERROR: ${key}`);
      }
      expect(calls()).toEqual([]);
    });

    it('rejects a missing ticket, an already closed ticket, and runs from a linked worktree', async () => {
      const missing = await run(['--spec', writeSpec({ ...spec, ticket: 'proj-missing' })]);
      expect(missing.exitCode).toBe(1);
      const done = await run(['--spec', writeSpec({ ...spec, ticket: 'proj-done' })]);
      expect(done.exitCode).toBe(1);
      expect(done.stderr).toContain('closed');
      const inside = await run(['--spec', writeSpec(spec)], wt());
      expect(inside.exitCode).toBe(1);
      expect(inside.stderr).toContain('linked worktree');
      expect(writes()).toEqual([]);
    });

    it('--dry-run prints the commands and changes nothing', async () => {
      const r = await run(['--spec', writeSpec(spec), '--dry-run']);
      expect(r.exitCode, r.stderr).toBe(0);
      expect(r.stdout).toContain('bd close proj-a1');
      expect(r.stdout).toContain(`git worktree remove --force ${wt()}`);
      expect(r.stdout).toContain('git branch -D bd/proj-a1');
      expect(r.stdout).toContain('git remote prune origin');
      expect(writes()).toEqual([]);
      expect(existsSync(wt())).toBe(true);
    });

    it('--help lists the schema keys', async () => {
      const r = await run(['--help']);
      expect(r.exitCode).toBe(0);
      for (const key of ['ticket', 'pr_url', 'worktree', 'branch']) {
        expect(r.stdout).toContain(`  ${key} (`);
      }
      expect(r.stdout).toContain('close-ticket.schema.json');
    });
  },
);
