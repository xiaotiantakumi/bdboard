import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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

    /**
     * pack.json の hooks[] は P1b (bdboard-pkr6.2) が settings.json へ書き写す契約。
     * script が実在しない・注入ファイルに含まれない・timeout が抜けている、といった
     * 破れは P1b 側では気付けない (注入した後で hook が動かないだけ) のでここで守る。
     */
    it('declares hooks that point at injectable scripts with an event and a timeout', async () => {
      const manifest = JSON.parse(
        readFileSync(path.join(PACKS_ROOT, 'bdboard-harness', 'pack.json'), 'utf8'),
      ) as { readonly hooks?: ReadonlyArray<Record<string, unknown>> };

      const registry = createFsPackRegistry(PACKS_ROOT);
      const pack = await registry.getPack('bdboard-harness');
      const packFiles = (pack?.files ?? []).map((file) => file.relativePath);

      const hooks = manifest.hooks ?? [];
      expect(hooks.length).toBeGreaterThan(0);

      for (const hook of hooks) {
        expect(['PreToolUse', 'Stop']).toContain(hook.event);
        expect(typeof hook.script).toBe('string');

        const script = hook.script as string;
        expect(existsSync(path.join(PACKS_ROOT, 'bdboard-harness', script))).toBe(true);
        expect(packFiles).toContain(script);

        expect(Number.isInteger(hook.timeout)).toBe(true);
        expect(hook.timeout as number).toBeGreaterThan(0);
      }
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
        // 先頭が許可される形でも、後ろのコマンドは独立に見る。
        name: 'git stash pop after an allowed git stash list',
        payload: { tool_name: 'Bash', tool_input: { command: 'git stash list; git stash pop' } },
        stderrIncludes: 'git stash push -u -m',
      },
      {
        name: 'git stash pop on a later line of a multi-line command',
        payload: {
          tool_name: 'Bash',
          tool_input: { command: 'set -e\ngit stash list\ngit stash pop\n' },
        },
        stderrIncludes: 'git stash push -u -m',
      },
      {
        name: 'git stash push without a message',
        payload: { tool_name: 'Bash', tool_input: { command: 'git stash push -u' } },
        stderrIncludes: 'git stash push -u -m',
      },
      {
        name: 'bare bd dolt push after one with --remote',
        payload: {
          tool_name: 'Bash',
          tool_input: { command: 'bd dolt push --remote legacy; bd dolt push' },
        },
        stderrIncludes: '--remote',
      },
      {
        // --remote が別コマンド (git push) の引数でも、bd dolt push は素通しにしない。
        name: 'bare bd dolt push after an unrelated --remote',
        payload: {
          tool_name: 'Bash',
          tool_input: { command: 'git push --remote x; bd dolt push' },
        },
        stderrIncludes: '--remote',
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
        // 短オプションの束 (-um) も「メッセージ指定あり」として扱う。
        name: 'git stash push -um',
        payload: { tool_name: 'Bash', tool_input: { command: 'git stash push -um tag' } },
      },
      {
        name: 'git stash push --message=',
        payload: { tool_name: 'Bash', tool_input: { command: 'git stash push --message="tag"' } },
      },
      {
        name: 'git stash list',
        payload: { tool_name: 'Bash', tool_input: { command: 'git stash list' } },
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

    it('flattens a multi-line contract message into one attributed stderr line', async () => {
      const projectRoot = path.join(tmpRoot, 'project');
      mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
      const env = isolatedEnv();
      await initGitRepo(projectRoot, 'main', env);
      writeFileSync(
        path.join(projectRoot, '.claude', 'bdboard-harness.json'),
        `${JSON.stringify({
          hooks: {
            denyBashPatterns: ['npm run verify:steps'],
            denyBashMessages: ['一行目\n二行目\n三行目\n四行目'],
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
      expect(denied.stderr.trim().split('\n').length).toBeLessThanOrEqual(3);
      expect(denied.stderr).toContain('(project contract)');
      expect(denied.stderr).toContain('一行目 二行目 三行目 四行目');
    });
  });

  /**
   * 規則 6 (bdboard-p5l.15): aimix run のモデル指定を、検証コントラクトの
   * models 表のセル所属で照合する。候補の抽出は scripts/route.sh に一本化されて
   * いるので、ここでは「hook が route.sh をどう使い、どこで fail-open するか」を固定する。
   */
  describe('pre-bash-guard.sh rule 6 (model routing)', () => {
    const ROUTES = {
      implement: {
        low: ['codex:gpt-5.6-luna'],
        med: ['codex:gpt-5.6-terra', 'cursor:composer-2.5'],
        high: ['codex:gpt-5.6-sol'],
      },
    };

    let projectRoot: string;
    let env: Record<string, string>;

    beforeEach(async () => {
      projectRoot = path.join(tmpRoot, 'project');
      mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
      env = isolatedEnv();
      await initGitRepo(projectRoot, 'main', env);
    });

    function writeContract(contract: Record<string, unknown>): void {
      writeFileSync(
        path.join(projectRoot, '.claude', 'bdboard-harness.json'),
        `${JSON.stringify(contract)}\n`,
        'utf8',
      );
    }

    async function guard(
      command: string,
      extraEnv?: Record<string, string>,
    ): Promise<CommandResult> {
      return runHook(
        PRE_BASH_GUARD,
        { tool_name: 'Bash', cwd: projectRoot, tool_input: { command } },
        { cwd: projectRoot, env: { ...env, ...extraEnv } },
      );
    }

    for (const mode of ['implement', 'refactor']) {
      it(`denies --mode ${mode} without --model`, async () => {
        writeContract({ mainBranch: 'main', models: { routes: ROUTES } });

        const result = await guard(
          `aimix run --mode ${mode} --member codex --complexity high`,
        );

        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain('--model の明示が必須');
        expect(result.stderr.trim().split('\n').length).toBeLessThanOrEqual(3);
      });
    }

    it('denies a model that is not in the cell', async () => {
      writeContract({ mainBranch: 'main', models: { routes: ROUTES } });

      const result = await guard(
        'aimix run --mode implement --member codex --model gpt-5.6-luna --complexity high',
      );

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('codex:gpt-5.6-luna');
      expect(result.stderr).toContain('implement/high');
      expect(result.stderr).toContain('codex:gpt-5.6-sol');
      expect(result.stderr.trim().split('\n').length).toBeLessThanOrEqual(3);
    });

    /**
     * セルの 2 番手が通ることを固定する回帰テスト。vendor 名 (codex/cursor/claude) で
     * 弾く実装にすると、正当な 2 番手である cursor:... が道連れで死ぬ。
     */
    it('allows the runner-up candidate of the same cell', async () => {
      writeContract({ mainBranch: 'main', models: { routes: ROUTES } });

      const result = await guard(
        'aimix run --mode implement --member cursor --model composer-2.5 --complexity med',
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
    });

    it('accepts --flag=value as well as --flag value', async () => {
      writeContract({ mainBranch: 'main', models: { routes: ROUTES } });

      const result = await guard(
        'aimix run --mode=implement --member=codex --model=gpt-5.6-sol --complexity=high',
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
    });

    it('allows an off-cell model when BDBOARD_ROUTE_OVERRIDE carries a reason', async () => {
      writeContract({ mainBranch: 'main', models: { routes: ROUTES } });
      const offCell =
        'aimix run --mode implement --member codex --model gpt-5.6-luna --complexity high';

      const inline = await guard(`BDBOARD_ROUTE_OVERRIDE="枠逼迫" ${offCell}`);
      expect(inline.exitCode).toBe(0);
      expect(inline.stderr).toBe('');

      const fromEnv = await guard(offCell, { BDBOARD_ROUTE_OVERRIDE: '枠逼迫' });
      expect(fromEnv.exitCode).toBe(0);
      expect(fromEnv.stderr).toBe('');
    });

    for (const empty of ['BDBOARD_ROUTE_OVERRIDE=', 'BDBOARD_ROUTE_OVERRIDE=""']) {
      it(`still denies when the override reason is empty (${empty})`, async () => {
        writeContract({ mainBranch: 'main', models: { routes: ROUTES } });

        const result = await guard(
          `${empty} aimix run --mode implement --member codex --model gpt-5.6-luna --complexity high`,
        );

        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain('候補');
      });
    }

    for (const mode of ['consult', 'review', 'debate']) {
      it(`ignores --mode ${mode}`, async () => {
        writeContract({ mainBranch: 'main', models: { routes: ROUTES } });

        const result = await guard(`aimix run --mode ${mode} --member codex`);

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe('');
      });
    }

    /**
     * deny してよいのは「セルの候補を実際に取れて、そこに無かった」ときだけ。
     * 判定材料が欠けているケースはすべて素通りさせる (fail-open)。
     */
    const failOpenCases: ReadonlyArray<{
      readonly name: string;
      readonly contract?: Record<string, unknown>;
      readonly command: string;
    }> = [
      {
        name: 'no contract file at all',
        command:
          'aimix run --mode implement --member codex --model gpt-5.6-luna --complexity high',
      },
      {
        name: 'a contract without a models section',
        contract: { mainBranch: 'main' },
        command:
          'aimix run --mode implement --member codex --model gpt-5.6-luna --complexity high',
      },
      {
        name: 'a contract whose models table lacks the stage',
        contract: { mainBranch: 'main', models: { routes: { review: ROUTES.implement } } },
        command:
          'aimix run --mode implement --member codex --model gpt-5.6-luna --complexity high',
      },
      {
        name: 'a contract whose stage lacks the cell',
        contract: {
          mainBranch: 'main',
          models: { routes: { implement: { low: ROUTES.implement.low } } },
        },
        command:
          'aimix run --mode implement --member codex --model gpt-5.6-luna --complexity high',
      },
      {
        name: 'a models table that route.sh rejects as invalid',
        contract: { mainBranch: 'main', models: { routes: { implement: { high: [] } } } },
        command:
          'aimix run --mode implement --member codex --model gpt-5.6-luna --complexity high',
      },
      {
        name: 'a call without --complexity',
        contract: { mainBranch: 'main', models: { routes: ROUTES } },
        command: 'aimix run --mode implement --member codex --model gpt-5.6-luna',
      },
      {
        name: 'a call without --member',
        contract: { mainBranch: 'main', models: { routes: ROUTES } },
        command: 'aimix run --mode implement --model gpt-5.6-luna --complexity high',
      },
    ];

    for (const failOpen of failOpenCases) {
      it(`does not deny with ${failOpen.name}`, async () => {
        if (failOpen.contract !== undefined) {
          writeContract(failOpen.contract);
        }

        const result = await guard(failOpen.command);

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe('');
      });
    }

    it('does not deny when neither jq nor python3 is available', async () => {
      writeContract({ mainBranch: 'main', models: { routes: ROUTES } });

      const result = await runHook(
        PRE_BASH_GUARD,
        {
          tool_name: 'Bash',
          cwd: projectRoot,
          tool_input: {
            command:
              'aimix run --mode implement --member codex --model gpt-5.6-luna --complexity high',
          },
        },
        { cwd: projectRoot, env: minimalEnv() },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('jq/python3 not found');
    });

    /**
     * 規則 6 の位置の回帰テスト。規則 5 の後ろに置くと、その直前の
     * 「denyBashPatterns が 1 件も無ければ exit 0」に食われて規則 6 が丸ごと死ぬ。
     */
    it('still runs when the contract declares no denyBashPatterns', async () => {
      writeContract({ mainBranch: 'main', models: { routes: ROUTES } });

      const result = await guard(
        'aimix run --mode implement --member codex --model gpt-5.6-luna --complexity high',
      );

      expect(result.exitCode).toBe(2);
    });

    /**
     * 規則 2・3 と同じく、コマンド列は「コマンド 1 個」へ割ってから判定する。
     * 列全体を 1 つとして見ると「先頭だけ行儀の良い」列が素通りする。
     */
    it('judges each command of a sequence separately', async () => {
      writeContract({ mainBranch: 'main', models: { routes: ROUTES } });

      const result = await guard(
        'aimix run --mode implement --member codex --model gpt-5.6-sol --complexity high; ' +
          'aimix run --mode implement --member codex --model gpt-5.6-luna --complexity high',
      );

      expect(result.exitCode).toBe(2);
    });
  });

  describe('degraded mode (no jq, no python3)', () => {
    /**
     * jq も python3 も無い環境では、生の JSON へ正規表現を当てる縮退判定はせず、
     * 警告 1 行だけを出して素通しする (fail-open)。判定材料が無いのに deny すると
     * `git stash list` のような無害なコマンドまで止まってしまうため。
     */
    const WARNING = 'jq/python3 not found';

    it('lets pre-bash-guard.sh pass with a single warning line', async () => {
      const env = minimalEnv();

      const result = await runHook(
        PRE_BASH_GUARD,
        { tool_name: 'Bash', cwd: tmpRoot, tool_input: { command: 'git stash list' } },
        { cwd: tmpRoot, env },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain(WARNING);
      expect(result.stderr.trim().split('\n')).toHaveLength(1);
    });

    it('lets pre-edit-guard.sh pass with a single warning line', async () => {
      const env = minimalEnv();
      const target = path.join(tmpRoot, '.claude', 'skills', 'bdboard-harness', 'SKILL.md');

      const result = await runHook(
        PRE_EDIT_GUARD,
        { tool_name: 'Edit', cwd: tmpRoot, tool_input: { file_path: target } },
        { cwd: tmpRoot, env },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain(WARNING);
      expect(result.stderr.trim().split('\n')).toHaveLength(1);
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
    }): Promise<{ repo: string; env: Record<string, string>; argsLog: string }> {
      const binDir = path.join(tmpRoot, 'bin');
      mkdirSync(binDir, { recursive: true });
      const argsLog = path.join(tmpRoot, 'bd-args.log');
      const fakeBd = path.join(binDir, 'bd');
      writeFileSync(
        fakeBd,
        [
          '#!/bin/sh',
          `echo "$*" >> '${argsLog}'`,
          '# hook は必ず -C <cwd> を先頭に付けて呼ぶ。本物と同じくそれを取り除いて解釈する。',
          'if [ "${1:-}" = "-C" ]; then',
          '  shift 2',
          'fi',
          'case "${1:-}" in',
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

      return { repo, env, argsLog };
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
      const { repo, env, argsLog } = await setupTicketWorktree({
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

      // bd は hook の cwd を明示して呼ぶ (別チェックアウトの .beads/ を読まないため)。
      const bdCalls = readFileSync(argsLog, 'utf8').trim().split('\n');
      expect(bdCalls.length).toBeGreaterThan(0);
      for (const call of bdCalls) {
        expect(call.startsWith(`-C ${repo} `)).toBe(true);
      }
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

  /**
   * jq も python3 も引けない PATH を作る。hook が必要とする最低限のコマンドだけを
   * symlink した専用ディレクトリを PATH 全体にする (`jq`/`python3` は張らない)。
   * PATH から名前で消す方式にしないのは、消し漏れた別の場所から拾われうるため。
   */
  function minimalEnv(): Record<string, string> {
    const binDir = path.join(tmpRoot, 'minimal-bin');
    mkdirSync(binDir, { recursive: true });
    const searchDirs = (process.env.PATH ?? '/usr/bin:/bin').split(path.delimiter);

    for (const name of ['bash', 'cat', 'grep', 'sed', 'tr', 'git']) {
      for (const dir of searchDirs) {
        const candidate = path.join(dir, name);
        try {
          accessSync(candidate, fsConstants.X_OK);
        } catch {
          continue;
        }
        symlinkSync(candidate, path.join(binDir, name));
        break;
      }
    }

    const home = path.join(tmpRoot, 'home');
    mkdirSync(home, { recursive: true });
    return { PATH: binDir, HOME: home };
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
