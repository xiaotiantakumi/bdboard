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
 * bdboard-harness パックの scripts/start-ticket.py の統合テスト (bdboard-7yfj.3)。
 *
 * bd は PATH 先頭の stub (引数を記録し、show には固定の status を返し、--claim の時点で
 * worktree が存在したかを記録する)。git は一時ディレクトリの本物のリポジトリ (bare origin 付き)。
 */

const PACKS_ROOT = fileURLToPath(new URL('../../../harness/packs/', import.meta.url));
const SCRIPT = path.join(PACKS_ROOT, 'bdboard-harness', 'scripts', 'start-ticket.py');

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
  'bdboard-harness scripts/start-ticket.py',
  () => {
    let tmpRoot: string;
    let repo: string;
    let env: Record<string, string>;
    let callsLog: string;

    async function git(cwd: string, ...args: string[]): Promise<CommandResult> {
      const r = await runner.run('git', args, { cwd, env, timeoutMs: 20_000 });
      expect(r.exitCode, `git ${args.join(' ')}: ${r.stderr}`).toBe(0);
      return r;
    }

    beforeEach(async () => {
      tmpRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'bdboard-start-ticket-')));
      const binDir = path.join(tmpRoot, 'bin');
      mkdirSync(binDir, { recursive: true });
      callsLog = path.join(tmpRoot, 'calls.jsonl');
      writeFileSync(callsLog, '', 'utf8');
      repo = path.join(tmpRoot, 'repo');
      const wtPath = path.join(repo, '.claude', 'worktrees', 'proj-a1');
      const stub = path.join(binDir, 'bd');
      writeFileSync(
        stub,
        [
          '#!/usr/bin/env python3',
          'import json, os, sys',
          'a = sys.argv[1:]',
          'entry = {"args": a}',
          'if "--claim" in a:',
          `    entry["worktree_existed"] = os.path.isdir(${JSON.stringify(wtPath)})`,
          `open(${JSON.stringify(callsLog)}, "a").write(json.dumps(entry) + "\\n")`,
          'if a[:1] == ["show"]:',
          '    if a[1] == "proj-missing":',
          '        sys.stderr.write("not found\\n"); sys.exit(1)',
          '    st = "in_progress" if a[1] == "proj-busy" else "open"',
          '    print(json.dumps([{"id": a[1], "status": st}]))',
          '',
        ].join('\n'),
        'utf8',
      );
      chmodSync(stub, 0o755);
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
      mkdirSync(path.join(repo, '.claude', 'worktrees'), { recursive: true });
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

    function calls(): { args: string[]; worktree_existed?: boolean }[] {
      return readFileSync(callsLog, 'utf8')
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as { args: string[]; worktree_existed?: boolean });
    }

    const wt = (): string => path.join(repo, '.claude', 'worktrees', 'proj-a1');
    const spec = { ticket: 'proj-a1', complexity: 'med' };

    it('creates the worktree and branch, then claims, records complexity; last stdout line is the path', async () => {
      const r = await run(['--spec', writeSpec(spec)]);
      expect(r.exitCode, r.stderr).toBe(0);
      expect(r.stdout.trim().split('\n').pop()).toBe(wt());
      expect(existsSync(path.join(wt(), 'a.txt'))).toBe(true);
      const head = await git(wt(), 'branch', '--show-current');
      expect(head.stdout.trim()).toBe('bd/proj-a1');
      const writes = calls().filter((c) => c.args[0] === 'update');
      expect(writes.map((c) => c.args)).toEqual([
        ['update', 'proj-a1', '--claim'],
        ['update', 'proj-a1', '--set-metadata', 'bdboard.complexity=med'],
      ]);
      expect(writes[0]?.worktree_existed).toBe(true);
    });

    it('honors explicit branch and worktree', async () => {
      const custom = path.join(repo, '.claude', 'worktrees', 'custom');
      const r = await run([
        '--spec',
        writeSpec({ ...spec, branch: 'bd/proj-a1-retry', worktree: custom, base: 'origin/main' }),
      ]);
      expect(r.exitCode, r.stderr).toBe(0);
      expect(r.stdout.trim().split('\n').pop()).toBe(custom);
      const head = await git(custom, 'branch', '--show-current');
      expect(head.stdout.trim()).toBe('bd/proj-a1-retry');
    });

    it('loses when the worktree already exists: exits non-zero, no claim', async () => {
      mkdirSync(wt(), { recursive: true });
      const r = await run(['--spec', writeSpec(spec)]);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain('ほかのセッションが保持');
      expect(calls().filter((c) => c.args[0] === 'update')).toEqual([]);
    });

    it('loses when the branch already exists: exits non-zero, no claim, no worktree', async () => {
      await git(repo, 'branch', 'bd/proj-a1');
      const r = await run(['--spec', writeSpec(spec)]);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain('ほかのセッションが保持');
      expect(existsSync(wt())).toBe(false);
      expect(calls().filter((c) => c.args[0] === 'update')).toEqual([]);
    });

    it('rejects spec violations with all reasons and touches neither git nor bd', async () => {
      const r = await run([
        '--spec',
        writeSpec({
          ticket: 'bad ticket!',
          branch: 'feature/x',
          worktree: path.join(tmpRoot, 'no-such-dir', 'wt'),
          complexity: 'huge',
          extra: 1,
        }),
      ]);
      expect(r.exitCode).toBe(1);
      for (const key of ['spec.ticket', 'spec.branch', 'spec.worktree', 'spec.complexity', 'spec.extra']) {
        expect(r.stderr).toContain(`ERROR: ${key}`);
      }
      expect(calls()).toEqual([]);
      expect(existsSync(wt())).toBe(false);
    });

    it('rejects a missing required key', async () => {
      const r = await run(['--spec', writeSpec({ ticket: 'proj-a1' })]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('必須キー complexity');
      expect(calls()).toEqual([]);
    });

    it('rejects a ticket that does not exist or is not open/ready, without writing', async () => {
      const missing = await run(['--spec', writeSpec({ ...spec, ticket: 'proj-missing' })]);
      expect(missing.exitCode).toBe(1);
      const busy = await run(['--spec', writeSpec({ ...spec, ticket: 'proj-busy' })]);
      expect(busy.exitCode).toBe(1);
      expect(busy.stderr).toContain('in_progress');
      expect(calls().every((c) => c.args[0] === 'show')).toBe(true);
      expect(existsSync(path.join(repo, '.claude', 'worktrees', 'proj-busy'))).toBe(false);
    });

    it('--dry-run prints the commands and changes nothing', async () => {
      const r = await run(['--spec', writeSpec(spec), '--dry-run']);
      expect(r.exitCode, r.stderr).toBe(0);
      expect(r.stdout).toContain(`git worktree add ${wt()} -b bd/proj-a1 origin/main`);
      expect(r.stdout).toContain('bd update proj-a1 --claim');
      expect(existsSync(wt())).toBe(false);
      expect(calls().filter((c) => c.args[0] === 'update')).toEqual([]);
    });

    it('--help lists the schema keys', async () => {
      const r = await run(['--help']);
      expect(r.exitCode).toBe(0);
      for (const key of ['ticket', 'branch', 'worktree', 'base', 'complexity']) {
        expect(r.stdout).toContain(`  ${key} (`);
      }
      expect(r.stdout).toContain('start-ticket.schema.json');
    });
  },
);
