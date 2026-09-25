import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandResult } from '../../application/ports/command-runner.js';
import { NodeCommandRunner } from '../process/node-command-runner.js';

/**
 * bdboard-harness パックの hooks/worktree-freshness.sh の統合テスト (bdboard-flpp)。
 *
 * pack-hooks.test.ts と同じく、Claude Code と同じ形 (bash で spawn し stdin に JSON) で叩く。
 * fixture は「bare の origin + main の clone + そこから切った worktree」で、origin を進めて
 * fetch し直すことで「hook の読み込み元の checkout が取り残された」状態を作る。
 * 本物のリポジトリや議長の worktree には一切触れない。
 */

const PACKS_ROOT = fileURLToPath(new URL('../../../harness/packs/', import.meta.url));
const SCRIPT = path.join(PACKS_ROOT, 'bdboard-harness', 'hooks', 'worktree-freshness.sh');

const HOOK_BODY = '.claude/skills/p/hooks/guard.sh';
const SETTINGS = {
  hooks: {
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [
          {
            type: 'command',
            command: `bash -c '[ -f "$0" ] || exit 0; exec bash "$0"' "$CLAUDE_PROJECT_DIR/${HOOK_BODY}"`,
          },
          { type: 'command', command: 'echo unrelated' },
        ],
      },
    ],
  },
};

const runner = new NodeCommandRunner();

interface HookOutput {
  readonly systemMessage: string;
  readonly hookSpecificOutput?: { readonly hookEventName: string; readonly additionalContext: string };
}

// 1 ケースで git を 10〜20 回起こすので、verify の並列負荷下では既定の 5 秒に収まらない。
describe.skipIf(process.platform === 'win32')('bdboard-harness worktree-freshness.sh', { timeout: 60_000 }, () => {
  let tmpRoot: string;
  let mainClone: string;
  let worktree: string;
  let env: Record<string, string>;

  beforeEach(async () => {
    // git の --show-toplevel は symlink を解決した実パスを返す (macOS の /var → /private/var)。
    tmpRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'bdboard-freshness-')));
    mkdirSync(path.join(tmpRoot, 'home'), { recursive: true });
    mkdirSync(path.join(tmpRoot, 'tmp'), { recursive: true });
    env = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: path.join(tmpRoot, 'home'),
      TMPDIR: path.join(tmpRoot, 'tmp'),
      GIT_CONFIG_NOSYSTEM: '1',
    };

    const bare = path.join(tmpRoot, 'origin.git');
    mainClone = path.join(tmpRoot, 'main');
    worktree = path.join(tmpRoot, 'wt');
    await git(tmpRoot, ['init', '-q', '--bare', bare]);
    mkdirSync(mainClone, { recursive: true });
    await git(mainClone, ['init', '-q']);
    await git(mainClone, ['checkout', '-q', '-b', 'main']);
    writeRepoFile(mainClone, '.claude/settings.json', `${JSON.stringify(SETTINGS, null, 2)}\n`);
    writeRepoFile(mainClone, HOOK_BODY, '#!/usr/bin/env bash\nexit 0\n');
    await commitAll(mainClone, 'init');
    await git(mainClone, ['remote', 'add', 'origin', bare]);
    await git(mainClone, ['push', '-q', 'origin', 'main']);
    await git(mainClone, ['fetch', '-q', 'origin']);
    await git(mainClone, ['worktree', 'add', '-q', '-b', 'feature/x', worktree, 'origin/main']);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  /** origin/main を 1 コミット進める (main の clone で書いて push → fetch)。 */
  async function advanceOrigin(relPath: string, content: string): Promise<void> {
    writeRepoFile(mainClone, relPath, content);
    await commitAll(mainClone, `touch ${relPath}`);
    await git(mainClone, ['push', '-q', 'origin', 'main']);
    await git(mainClone, ['fetch', '-q', 'origin']);
  }

  async function runFreshness(
    payload: Record<string, unknown>,
    options?: { readonly projectDir?: string | null; readonly env?: Record<string, string> },
  ): Promise<CommandResult> {
    const projectDir = options?.projectDir === undefined ? worktree : options.projectDir;
    const baseEnv = options?.env ?? env;
    return runner.run('bash', [SCRIPT], {
      input: JSON.stringify({ session_id: 's1', cwd: worktree, ...payload }),
      cwd: tmpRoot,
      timeoutMs: 20_000,
      env: projectDir === null ? baseEnv : { ...baseEnv, CLAUDE_PROJECT_DIR: projectDir },
    });
  }

  function parse(result: CommandResult): HookOutput {
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).not.toBe('');
    return JSON.parse(result.stdout) as HookOutput;
  }

  function expectSilent(result: CommandResult): void {
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  }

  const SESSION_START = { hook_event_name: 'SessionStart', source: 'startup' };

  it('stays silent when the checkout is up to date', async () => {
    expectSilent(await runFreshness(SESSION_START));
  });

  it('warns after a single upstream commit that touches the hook registration', async () => {
    await advanceOrigin('.claude/settings.json', `${JSON.stringify(SETTINGS)}\n`);

    const output = parse(await runFreshness(SESSION_START));
    expect(output.systemMessage).toContain('hook 関連 1');
    expect(output.hookSpecificOutput?.hookEventName).toBe('SessionStart');
    const context = output.hookSpecificOutput?.additionalContext ?? '';
    expect(context).toContain(`git -C '${worktree}' merge --ff-only origin/main`);
    expect(context).toContain('/hooks');
    expect(context).toContain('自動では checkout / merge しません');
  });

  it('warns after one upstream commit to a hook script, without the registration note', async () => {
    await advanceOrigin('.claude/skills/p/hooks/other.sh', 'exit 0\n');

    const context = parse(await runFreshness(SESSION_START)).hookSpecificOutput?.additionalContext ?? '';
    expect(context).toContain('merge --ff-only origin/main');
    expect(context).not.toContain('/hooks');
  });

  it('needs three upstream commits for non-hook harness files, and ignores other paths', async () => {
    for (let i = 0; i < 5; i += 1) {
      await advanceOrigin(`src/file-${i}.ts`, `export const x = ${i};\n`);
    }
    await advanceOrigin('.claude/skills/p/references/a.md', 'a\n');
    await advanceOrigin('harness/packs/p/SKILL.md', 'b\n');
    expectSilent(await runFreshness(SESSION_START));

    await advanceOrigin('.claude/skills/p/references/c.md', 'c\n');
    const output = parse(await runFreshness(SESSION_START));
    expect(output.systemMessage).toContain('hook 関連 0 / ハーネス 3 / 全体 8');
  });

  it('asks for a merge (not ff, not rebase) when the checkout has its own commits', async () => {
    writeRepoFile(worktree, 'mine.txt', 'mine\n');
    await commitAll(worktree, 'own work');
    await advanceOrigin('.claude/settings.json', '{}\n');

    const context = parse(await runFreshness(SESSION_START)).hookSpecificOutput?.additionalContext ?? '';
    expect(context).toContain(`git -C '${worktree}' merge origin/main`);
    expect(context).toContain('ユーザーに確認のうえ');
    expect(context).not.toContain('--ff-only');
    expect(context).toContain('rebase ではなく merge');
  });

  it('does not count its own hook commits as lag (a PR that edits hooks)', async () => {
    writeRepoFile(worktree, '.claude/settings.json', '{}\n');
    writeRepoFile(worktree, HOOK_BODY, 'exit 0 # changed\n');
    await commitAll(worktree, 'edit hooks on the branch');

    expectSilent(await runFreshness(SESSION_START));
  });

  it('asks to commit first when tracked files are dirty', async () => {
    await advanceOrigin('.claude/settings.json', '{}\n');
    writeRepoFile(worktree, HOOK_BODY, 'exit 0 # wip\n');

    const context = parse(await runFreshness(SESSION_START)).hookSpecificOutput?.additionalContext ?? '';
    expect(context).toContain('未コミットの変更が 1 ファイル');
    expect(context).not.toContain('--ff-only');
  });

  it('offers no command while HEAD is detached', async () => {
    await git(worktree, ['checkout', '-q', '--detach']);
    await advanceOrigin('.claude/settings.json', '{}\n');

    const output = parse(await runFreshness(SESSION_START));
    expect(output.systemMessage).toContain('detached HEAD');
    expect(output.hookSpecificOutput?.additionalContext).not.toMatch(/git -C \S+ merge/);
  });

  it('offers no command while a merge is in progress', async () => {
    await advanceOrigin('.claude/settings.json', '{}\n');
    const gitDir = (await gitOut(worktree, ['rev-parse', '--absolute-git-dir'])).trim();
    writeFileSync(path.join(gitDir, 'MERGE_HEAD'), `${(await gitOut(worktree, ['rev-parse', 'HEAD'])).trim()}\n`);

    const context = parse(await runFreshness(SESSION_START)).hookSpecificOutput?.additionalContext ?? '';
    expect(context).toContain('途中なので');
    expect(context).not.toMatch(/git -C \S+ merge/);
  });

  it('tells a checkout with no common ancestor to start over from a new worktree', async () => {
    const orphan = path.join(tmpRoot, 'orphan');
    await git(mainClone, ['worktree', 'add', '-q', '--detach', orphan]);
    await git(orphan, ['checkout', '-q', '--orphan', 'old-history']);
    await commitAll(orphan, 'rewritten history');

    const output = parse(await runFreshness(SESSION_START, { projectDir: orphan }));
    expect(output.systemMessage).toContain('共通の祖先がありません');
    const context = output.hookSpecificOutput?.additionalContext ?? '';
    expect(context).toContain('新しい worktree');
    expect(context).not.toMatch(/git -C \S+ merge/);
  });

  it.each(['jq', 'python3'] as const)(
    'reports registered hook bodies that are missing, in every placeholder form (%s)',
    async (jsonTool) => {
      const settings = {
        hooks: {
          SessionStart: [
            { hooks: [{ type: 'command', command: 'node "${CLAUDE_PROJECT_DIR:-.}/scripts/prime.mjs"' }] },
          ],
          Stop: [
            { hooks: [{ type: 'command', command: 'bash "${CLAUDE_PROJECT_DIR}/.claude/skills/p/hooks/stop.sh"' }] },
          ],
        },
      };
      writeRepoFile(worktree, '.claude/settings.local.json', JSON.stringify(settings));
      rmSync(path.join(worktree, HOOK_BODY));
      await commitAll(worktree, 'drop the guard body');

      const output = parse(
        await runFreshness(SESSION_START, jsonTool === 'python3' ? { env: await pythonOnlyEnv() } : {}),
      );
      expect(output.systemMessage).toContain('登録済みの hook 本体が 3 件見つかりません');
      const context = output.hookSpecificOutput?.additionalContext ?? '';
      expect(context).toContain(HOOK_BODY);
      expect(context).toContain('scripts/prime.mjs');
      expect(context).toContain('.claude/skills/p/hooks/stop.sh');
      expect(context).not.toContain('unrelated');
    },
  );

  it('stays silent inside a subagent (agent_id present)', async () => {
    await advanceOrigin('.claude/settings.json', '{}\n');
    expectSilent(await runFreshness({ ...SESSION_START, agent_id: 'agent-1' }));
  });

  it('looks at $CLAUDE_PROJECT_DIR, not cwd, and falls back to cwd without it', async () => {
    await advanceOrigin('.claude/settings.json', '{}\n');
    const freshWorktree = path.join(tmpRoot, 'fresh');
    await git(mainClone, ['worktree', 'add', '-q', '-b', 'feature/fresh', freshWorktree, 'origin/main']);

    parse(await runFreshness({ ...SESSION_START, cwd: freshWorktree }));
    expectSilent(await runFreshness({ ...SESSION_START, cwd: freshWorktree }, { projectDir: freshWorktree }));
    parse(await runFreshness({ ...SESSION_START, cwd: worktree }, { projectDir: null }));
    expectSilent(await runFreshness({ ...SESSION_START, cwd: freshWorktree }, { projectDir: null }));
  });

  it('fails open without an origin ref, and follows the contract mainBranch', async () => {
    await advanceOrigin('.claude/settings.json', '{}\n');
    const contract = JSON.stringify({ mainBranch: 'trunk' });
    writeRepoFile(worktree, '.claude/bdboard-harness.json', contract);
    await commitAll(worktree, 'contract says trunk');
    expectSilent(await runFreshness(SESSION_START));

    await git(mainClone, ['push', '-q', 'origin', 'main:trunk']);
    await git(mainClone, ['fetch', '-q', 'origin']);
    const output = parse(await runFreshness(SESSION_START));
    expect(output.systemMessage).toContain('origin/trunk');
  });

  it('fails open outside a git repository', async () => {
    const plain = path.join(tmpRoot, 'plain');
    mkdirSync(plain);
    expectSilent(await runFreshness({ ...SESSION_START, cwd: plain }, { projectDir: plain }));
  });

  it('points the main checkout at the restart script instead of a merge command', async () => {
    writeRepoFile(
      mainClone,
      '.claude/bdboard-harness.json',
      JSON.stringify({ alwaysOnServer: { port: 1, restartScript: 'scripts/restart.sh' } }),
    );
    await commitAll(mainClone, 'contract');
    await git(mainClone, ['push', '-q', 'origin', 'main']);
    await git(mainClone, ['fetch', '-q', 'origin']);
    // origin だけを進める (main の clone は追従しないまま取り残す)。
    await git(worktree, ['merge', '-q', '--ff-only', 'origin/main']);
    writeRepoFile(worktree, '.claude/settings.json', '{"hooks":{}}\n');
    await commitAll(worktree, 'upstream hook change');
    await git(worktree, ['push', '-q', 'origin', 'HEAD:main']);
    await git(worktree, ['fetch', '-q', 'origin']);

    const context =
      parse(await runFreshness(SESSION_START, { projectDir: mainClone })).hookSpecificOutput
        ?.additionalContext ?? '';
    expect(context).toContain('main checkout');
    expect(context).toContain('scripts/restart.sh');
    expect(context).not.toMatch(/git -C \S+ merge/);
  });

  it('still offers the merge command to a worktree when the contract has a restart script', async () => {
    const contract = JSON.stringify({ alwaysOnServer: { port: 1, restartScript: 'scripts/restart.sh' } });
    await advanceOrigin('.claude/bdboard-harness.json', contract);
    await git(worktree, ['merge', '-q', '--ff-only', 'origin/main']);
    await advanceOrigin('.claude/settings.json', '{}\n');

    const context = parse(await runFreshness(SESSION_START)).hookSpecificOutput?.additionalContext ?? '';
    expect(context).toContain(`git -C '${worktree}' merge --ff-only origin/main`);
    expect(context).not.toContain('scripts/restart.sh');
  });

  it('adds an npm install note when upstream changed a lockfile', async () => {
    await advanceOrigin('.claude/settings.json', '{}\n');
    expect(parse(await runFreshness(SESSION_START)).hookSpecificOutput?.additionalContext).not.toContain(
      'npm install',
    );

    await advanceOrigin('web/package-lock.json', '{}\n');
    const context = parse(await runFreshness(SESSION_START)).hookSpecificOutput?.additionalContext ?? '';
    expect(context).toContain('npm install');
  });

  it('quotes the checkout path in the command when it contains spaces', async () => {
    const spaced = path.join(tmpRoot, 'dir with space');
    await git(mainClone, ['worktree', 'add', '-q', '-b', 'feature/spaced', spaced, 'origin/main']);
    await advanceOrigin('.claude/settings.json', '{}\n');

    const context =
      parse(await runFreshness(SESSION_START, { projectDir: spaced })).hookSpecificOutput
        ?.additionalContext ?? '';
    expect(context).toContain(`git -C '${spaced}' merge --ff-only origin/main`);
  });

  it('reminds again once the reminder interval has passed', async () => {
    await advanceOrigin('.claude/settings.json', '{}\n');
    const prompt = { hook_event_name: 'UserPromptSubmit' };
    parse(await runFreshness(prompt));
    expectSilent(await runFreshness(prompt));

    const stateDir = path.join(tmpRoot, 'tmp', 'bdboard-harness-freshness');
    const [stateFile] = readdirSync(stateDir);
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(path.join(stateDir, stateFile ?? ''), twoHoursAgo, twoHoursAgo);
    parse(await runFreshness(prompt));
  });

  it('reminds once per state and session, but always on SessionStart', async () => {
    await advanceOrigin('.claude/settings.json', '{}\n');
    const prompt = { hook_event_name: 'UserPromptSubmit', prompt: 'hi' };

    expect(parse(await runFreshness(prompt)).hookSpecificOutput?.hookEventName).toBe('UserPromptSubmit');
    expectSilent(await runFreshness(prompt));
    parse(await runFreshness(SESSION_START));
    parse(await runFreshness({ ...prompt, session_id: 's2' }));

    await advanceOrigin('.claude/settings.json', '{"x":1}\n');
    parse(await runFreshness(prompt));
    expectSilent(await runFreshness(prompt));
  });

  it('answers PostToolUse(Agent) with a matching hookEventName, and unknown events with systemMessage only', async () => {
    await advanceOrigin('.claude/settings.json', '{}\n');

    const post = parse(await runFreshness({ hook_event_name: 'PostToolUse', tool_name: 'Agent' }));
    expect(post.hookSpecificOutput?.hookEventName).toBe('PostToolUse');

    const other = parse(await runFreshness({ hook_event_name: 'Notification', session_id: 's3' }));
    expect(other.systemMessage).not.toBe('');
    expect(other.hookSpecificOutput).toBeUndefined();
  });

  it('keeps its state outside the checkout', async () => {
    await advanceOrigin('.claude/settings.json', '{}\n');
    parse(await runFreshness({ hook_event_name: 'UserPromptSubmit' }));

    expect(await gitOut(worktree, ['status', '--porcelain'])).toBe('');
    expect(readdirSync(path.join(tmpRoot, 'tmp', 'bdboard-harness-freshness'))).toHaveLength(1);
  });

  it('produces the same answer through python3 when jq is unavailable', async () => {
    await advanceOrigin('.claude/settings.json', '{}\n');
    const pythonEnv = await pythonOnlyEnv();

    const output = parse(await runFreshness(SESSION_START, { env: pythonEnv }));
    expect(output.systemMessage).toContain('hook 関連 1');
    expect(output.hookSpecificOutput?.additionalContext).toContain('merge --ff-only origin/main');
    expectSilent(await runFreshness({ ...SESSION_START, agent_id: 'a' }, { env: pythonEnv }));
  });

  it('passes with a single warning line when neither jq nor python3 exists', async () => {
    await advanceOrigin('.claude/settings.json', '{}\n');
    const bin = linkCommands('bare-bin', ['bash', 'cat', 'git']);

    const result = await runFreshness(SESSION_START, { env: { ...env, PATH: bin } });
    expectSilent(result);
    expect(result.stderr.trim().split('\n')).toEqual([
      'bdboard-harness hook: jq/python3 not found; skipping all checks (fail-open)',
    ]);
  });

  // --- helpers ---

  function writeRepoFile(root: string, relPath: string, content: string): void {
    const target = path.join(root, relPath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }

  async function gitOut(cwd: string, args: readonly string[]): Promise<string> {
    const result = await runner.run('git', args, { cwd, env, timeoutMs: 20_000 });
    if (result.exitCode !== 0) {
      throw new Error(`git ${args.join(' ')} failed (${result.exitCode}): ${result.stderr}`);
    }
    return result.stdout;
  }

  async function git(cwd: string, args: readonly string[]): Promise<void> {
    await gitOut(cwd, args);
  }

  async function commitAll(cwd: string, message: string): Promise<void> {
    await git(cwd, ['add', '-A']);
    await git(cwd, [
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
      message,
    ]);
  }

  /** 名前を指定して実 PATH から symlink した専用ディレクトリを作る (jq を引かせないため)。 */
  function linkCommands(dirName: string, names: readonly string[]): string {
    const binDir = path.join(tmpRoot, dirName);
    mkdirSync(binDir, { recursive: true });
    const searchDirs = (process.env.PATH ?? '/usr/bin:/bin').split(path.delimiter);
    for (const name of names) {
      const target = searchDirs
        .map((dir) => path.join(dir, name))
        .find((candidate) => {
          try {
            accessSync(candidate, fsConstants.X_OK);
            return true;
          } catch {
            return false;
          }
        });
      if (target === undefined) {
        throw new Error(`linkCommands: required command not found on PATH: ${name}`);
      }
      symlinkSync(target, path.join(binDir, name));
    }
    return binDir;
  }

  /** jq を引けず python3 だけを引ける env (python3 は実体へ張る。pyenv の shim 対策)。 */
  async function pythonOnlyEnv(): Promise<Record<string, string>> {
    const binDir = linkCommands('python-bin', [
      'bash', 'cat', 'git', 'grep', 'sed', 'sort', 'tr', 'cut', 'wc', 'find', 'cksum', 'mkdir',
    ]);
    const probe = await runner.run('python3', ['-c', 'import sys; print(sys.executable)'], {
      timeoutMs: 20_000,
    });
    const python = probe.stdout.trim();
    if (probe.exitCode !== 0 || python === '' || !existsSync(python)) {
      throw new Error(`pythonOnlyEnv: cannot resolve python3: ${probe.stderr}`);
    }
    symlinkSync(python, path.join(binDir, 'python3'));
    return { ...env, PATH: binDir };
  }
});
