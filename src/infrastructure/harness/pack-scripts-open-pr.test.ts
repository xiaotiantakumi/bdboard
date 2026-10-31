import {
  chmodSync,
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
 * bdboard-harness パックの scripts/open-pr.py の統合テスト (bdboard-7yfj.4)。
 *
 * bd / gh / npm は PATH 先頭の stub (引数を記録する)。git は一時ディレクトリの本物の
 * リポジトリ (bare origin 付き) とそこから作った linked worktree。
 */

const PACKS_ROOT = fileURLToPath(new URL('../../../harness/packs/', import.meta.url));
const SCRIPT = path.join(PACKS_ROOT, 'bdboard-harness', 'scripts', 'open-pr.py');

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

interface Call {
  tool: string;
  args: string[];
}

describe.skipIf(process.platform === 'win32' || !HAS_TOOLS)(
  'bdboard-harness scripts/open-pr.py',
  () => {
    let tmpRoot: string;
    let repo: string;
    let wt: string;
    let env: Record<string, string>;
    let callsLog: string;

    async function git(cwd: string, ...args: string[]): Promise<CommandResult> {
      const r = await runner.run('git', args, { cwd, env, timeoutMs: 20_000 });
      expect(r.exitCode, `git ${args.join(' ')}: ${r.stderr}`).toBe(0);
      return r;
    }

    function stub(binDir: string, name: string, body: string[]): void {
      const file = path.join(binDir, name);
      writeFileSync(
        file,
        [
          '#!/usr/bin/env python3',
          'import json, sys',
          'a = sys.argv[1:]',
          `open(${JSON.stringify(callsLog)}, "a").write(json.dumps({"tool": ${JSON.stringify(name)}, "args": a}) + "\\n")`,
          ...body,
          '',
        ].join('\n'),
        'utf8',
      );
      chmodSync(file, 0o755);
    }

    beforeEach(async () => {
      tmpRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'bdboard-open-pr-')));
      const binDir = path.join(tmpRoot, 'bin');
      mkdirSync(binDir, { recursive: true });
      callsLog = path.join(tmpRoot, 'calls.jsonl');
      writeFileSync(callsLog, '', 'utf8');
      stub(binDir, 'bd', [
        'if a[:1] == ["show"]:',
        '    if a[1] == "proj-missing":',
        '        sys.stderr.write("not found\\n"); sys.exit(1)',
        '    st = "open" if a[1] == "proj-open" else "in_progress"',
        '    meta = {} if a[1] == "proj-nometa" else {"bdboard.complexity": "high" if a[1] == "proj-high" else "low"}',
        '    print(json.dumps([{"id": a[1], "status": st, "metadata": meta}]))',
      ]);
      stub(binDir, 'gh', [
        'if a[:2] == ["pr", "create"]:',
        '    print("https://github.com/example/repo/pull/7")',
      ]);
      stub(binDir, 'npm', ['if "check:commits" in a and "--bad" in open(' + JSON.stringify(path.join(tmpRoot, 'flags')) + ').read():', '    print("commit-parse: bad"); sys.exit(1)']);
      writeFileSync(path.join(tmpRoot, 'flags'), '', 'utf8');
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
      repo = path.join(tmpRoot, 'repo');
      mkdirSync(repo, { recursive: true });
      await git(repo, 'init', '-b', 'main');
      writeFileSync(path.join(repo, 'a.txt'), 'a\n', 'utf8');
      await git(repo, 'add', 'a.txt');
      await git(repo, 'commit', '-m', 'init');
      await git(repo, 'remote', 'add', 'origin', origin);
      await git(repo, 'push', '-u', 'origin', 'main');
      wt = path.join(tmpRoot, 'wt');
    });

    afterEach(() => {
      rmSync(tmpRoot, RM_OPTIONS);
    });

    /** linked worktree を bd/<ticket> で作り、先行コミットを 1 つ入れる。 */
    async function makeWorktree(ticket: string, files: Record<string, string> = { 'b.txt': 'b\n' }): Promise<void> {
      await git(repo, 'worktree', 'add', wt, '-b', `bd/${ticket}`, 'origin/main');
      for (const [name, content] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(wt, name)), { recursive: true });
        writeFileSync(path.join(wt, name), content, 'utf8');
      }
      await git(wt, 'add', '-A');
      await git(wt, 'commit', '-m', `feat(${ticket}): add b`);
    }

    const baseSpec = (ticket: string): Record<string, unknown> => ({
      ticket,
      title: `feat(${ticket}): add b`,
      summary: '1 行目の要約\n2 行目の要約',
      help_content_checked: true,
    });

    function writeSpec(spec: Record<string, unknown>): string {
      const p = path.join(tmpRoot, 'spec.json');
      writeFileSync(p, JSON.stringify(spec), 'utf8');
      return p;
    }

    function run(args: readonly string[], cwd: string = wt): Promise<CommandResult> {
      return runner.run('python3', [SCRIPT, ...args], { cwd, env, timeoutMs: 30_000 });
    }

    function calls(): Call[] {
      return readFileSync(callsLog, 'utf8')
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Call);
    }

    const sideEffects = (): Call[] =>
      calls().filter(
        (c) =>
          (c.tool === 'gh') ||
          (c.tool === 'bd' && c.args[0] === 'comment') ||
          (c.tool === 'npm' && c.args.includes('verify:quick')),
      );

    it('low: verify, push, gh pr create with Closes, bd comment PR:, then auto-merge; last stdout line is the URL', async () => {
      await makeWorktree('proj-low');
      const r = await run(['--spec', writeSpec({ ...baseSpec('proj-low'), complexity: 'low' })]);
      expect(r.exitCode, r.stderr).toBe(0);
      expect(r.stdout.trim().split('\n').pop()).toBe('https://github.com/example/repo/pull/7');
      const c = calls();
      expect(c.some((x) => x.tool === 'npm' && x.args.join(' ') === 'run verify:quick')).toBe(true);
      const create = c.find((x) => x.tool === 'gh' && x.args[1] === 'create');
      expect(create?.args[3]).toBe('feat(proj-low): add b');
      const body = create?.args[5] ?? '';
      expect(body.startsWith('Closes: proj-low\n\n1 行目の要約\n2 行目の要約\n\n')).toBe(true);
      expect(body).toContain('🤖 Generated with [Claude Code]');
      expect(c.some((x) => x.tool === 'bd' && x.args.join(' ') === 'comment proj-low PR: https://github.com/example/repo/pull/7')).toBe(true);
      const merge = c.find((x) => x.tool === 'gh' && x.args[1] === 'merge');
      expect(merge?.args).toEqual(['pr', 'merge', 'https://github.com/example/repo/pull/7', '--auto', '--squash', '--delete-branch']);
      // push は本物の origin に届いている
      const remote = await git(repo, 'ls-remote', '--heads', 'origin', 'bd/proj-low');
      expect(remote.stdout).toContain('refs/heads/bd/proj-low');
    });

    it('reads verifyQuick / commitCheck from .claude/bdboard-harness.json when the contract has them (bdboard-7yfj.6)', async () => {
      await makeWorktree('proj-low', {
        'b.txt': 'b\n',
        '.claude/bdboard-harness.json': JSON.stringify({
          version: 1,
          verify: 'make verify',
          prFlow: 'pr',
          verifyQuick: 'npm run my-quick',
          commitCheck: 'npm run my-commits -- --range {range}',
        }),
      });
      const r = await run(['--spec', writeSpec({ ...baseSpec('proj-low'), complexity: 'low' })]);
      expect(r.exitCode, r.stderr).toBe(0);
      const npm = calls().filter((x) => x.tool === 'npm').map((x) => x.args.join(' '));
      expect(npm).toContain('run my-quick');
      expect(npm).toContain('run my-commits -- --range origin/main..HEAD');
      expect(npm).not.toContain('run verify:quick');
      expect(npm.some((a) => a.includes('check:commits'))).toBe(false);
    });

    it('falls back to the npm script names when the contract is absent, unparsable or has no such keys', async () => {
      await makeWorktree('proj-low', {
        'b.txt': 'b\n',
        '.claude/bdboard-harness.json': '{not json',
      });
      const r = await run(['--spec', writeSpec({ ...baseSpec('proj-low'), complexity: 'low' }), '--dry-run']);
      expect(r.exitCode, r.stderr).toBe(0);
      expect(r.stdout).toContain('+ npm run verify:quick');
    });

    it('rejects a contract verifyQuick that is not a single-line string', async () => {
      await makeWorktree('proj-low', {
        'b.txt': 'b\n',
        '.claude/bdboard-harness.json': JSON.stringify({ version: 1, verify: 'x', prFlow: 'pr', verifyQuick: 'a\nb' }),
      });
      const r = await run(['--spec', writeSpec({ ...baseSpec('proj-low'), complexity: 'low' })]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('verifyQuick');
      expect(sideEffects()).toEqual([]);
    });

    it('high (from bd metadata): no auto-merge, says waiting for the chair', async () => {
      await makeWorktree('proj-high');
      const r = await run(['--spec', writeSpec(baseSpec('proj-high'))]);
      expect(r.exitCode, r.stderr).toBe(0);
      expect(r.stdout).toContain('議長のレビュー待ち');
      expect(r.stdout.trim().split('\n').pop()).toBe('https://github.com/example/repo/pull/7');
      expect(calls().some((x) => x.tool === 'gh' && x.args[1] === 'merge')).toBe(false);
      expect(calls().some((x) => x.tool === 'gh' && x.args[1] === 'create')).toBe(true);
    });

    it('--skip-verify leaves the reason as a bd comment and skips verify:quick', async () => {
      await makeWorktree('proj-low');
      const r = await run(['--spec', writeSpec({ ...baseSpec('proj-low'), complexity: 'med' }), '--skip-verify', 'docs のみ']);
      expect(r.exitCode, r.stderr).toBe(0);
      expect(calls().some((x) => x.tool === 'npm' && x.args.includes('verify:quick'))).toBe(false);
      expect(calls().some((x) => x.tool === 'bd' && x.args[0] === 'comment' && (x.args[2] ?? '').includes('docs のみ'))).toBe(true);
    });

    it('--dry-run prints the commands and runs none of the side effects', async () => {
      await makeWorktree('proj-low');
      const r = await run(['--spec', writeSpec({ ...baseSpec('proj-low'), complexity: 'low' }), '--dry-run']);
      expect(r.exitCode, r.stderr).toBe(0);
      expect(r.stdout).toContain('+ npm run verify:quick');
      expect(r.stdout).toContain('+ git push -u origin bd/proj-low');
      expect(r.stdout).toContain('Closes: proj-low');
      expect(r.stdout).toContain('gh pr merge');
      expect(sideEffects()).toEqual([]);
      const remote = await git(repo, 'ls-remote', '--heads', 'origin', 'bd/proj-low');
      expect(remote.stdout).toBe('');
    });

    it('rejects spec violations with all reasons and runs no push/gh', async () => {
      await makeWorktree('proj-low');
      const r = await run([
        '--spec',
        writeSpec({
          ticket: 'proj-low',
          title: 'no prefix',
          summary: 'one line only',
          complexity: 'huge',
          help_content_checked: false,
          extra: 1,
        }),
      ]);
      expect(r.exitCode).toBe(1);
      for (const key of ['spec.title', 'spec.summary', 'spec.complexity', 'spec.help_content_checked', 'spec.extra']) {
        expect(r.stderr).toContain(`ERROR: ${key}`);
      }
      expect(sideEffects()).toEqual([]);
      const remote = await git(repo, 'ls-remote', '--heads', 'origin', 'bd/proj-low');
      expect(remote.stdout).toBe('');
    });

    it('rejects a title whose ticket does not match, a non in_progress ticket and missing complexity', async () => {
      await makeWorktree('proj-open');
      const r = await run(['--spec', writeSpec({ ...baseSpec('proj-open'), title: 'feat(proj-other): add b' })]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('括弧の中が ticket と一致しません');
      expect(r.stderr).toContain('in_progress ではありません');
      expect(sideEffects()).toEqual([]);
    });

    it('rejects when complexity is neither in the spec nor in bd metadata', async () => {
      await makeWorktree('proj-nometa');
      const r = await run(['--spec', writeSpec(baseSpec('proj-nometa'))]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('spec.complexity');
      expect(sideEffects()).toEqual([]);
    });

    it('rejects a change under .beads/', async () => {
      await makeWorktree('proj-low', { 'b.txt': 'b\n', '.beads/x.jsonl': '{}\n' });
      const r = await run(['--spec', writeSpec(baseSpec('proj-low'))]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('.beads/');
      expect(sideEffects()).toEqual([]);
    });

    it('rejects uncommitted changes', async () => {
      await makeWorktree('proj-low');
      writeFileSync(path.join(wt, 'dirty.txt'), 'x\n', 'utf8');
      const r = await run(['--spec', writeSpec(baseSpec('proj-low'))]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('未コミット');
      expect(sideEffects()).toEqual([]);
    });

    it('rejects when there is no commit ahead of origin/main', async () => {
      await git(repo, 'worktree', 'add', wt, '-b', 'bd/proj-low', 'origin/main');
      const r = await run(['--spec', writeSpec(baseSpec('proj-low'))]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('先行するコミットがありません');
      expect(sideEffects()).toEqual([]);
    });

    it('rejects the main checkout and a wrong branch', async () => {
      const r = await run(['--spec', writeSpec(baseSpec('proj-low'))], repo);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('linked worktree ではありません');
      await git(repo, 'worktree', 'add', wt, '-b', 'bd/proj-other', 'origin/main');
      const r2 = await run(['--spec', writeSpec(baseSpec('proj-low'))]);
      expect(r2.exitCode).toBe(1);
      expect(r2.stderr).toContain('bd/proj-low ではありません');
      expect(sideEffects()).toEqual([]);
    });

    it('rejects when check:commits fails', async () => {
      await makeWorktree('proj-low');
      writeFileSync(path.join(tmpRoot, 'flags'), '--bad', 'utf8');
      const r = await run(['--spec', writeSpec(baseSpec('proj-low'))]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('check:commits');
      expect(sideEffects()).toEqual([]);
    });

    it('prints the schema-derived key list with --help', async () => {
      const r = await run(['--help'], repo);
      expect(r.exitCode).toBe(0);
      for (const key of ['ticket', 'title', 'summary', 'complexity', 'help_content_checked', '--skip-verify', '--dry-run']) {
        expect(r.stdout).toContain(key);
      }
    });
  },
);
