import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandResult } from '../../application/ports/command-runner.js';
import { NodeCommandRunner } from '../process/node-command-runner.js';
import { createFsPackRegistry } from './fs-pack-registry.js';

/**
 * bdboard-harness パックの scripts/aimix-run.sh の統合テスト (bdboard-cm2q.12)。
 *
 * 旧 pre-bash-guard.sh 規則 6 (コマンド文字列から aimix run の引数を推測する) を、
 * argv をそのまま受け取るラッパーに置き換えた。素の `aimix run` は permissions.deny
 * `Bash(aimix run *)` で止め、委譲はこのラッパー経由だけにする。
 *
 * 本物の aimix は呼ばない。PATH の先頭に「受け取った引数を印字するだけ」の stub を置き、
 * 通したときは stub の出力が、止めたときは exit 2 と stderr 3 行が出ることを見る。
 */

const PACKS_ROOT = fileURLToPath(new URL('../../../harness/packs/', import.meta.url));
const AIMIX_RUN = path.join(PACKS_ROOT, 'bdboard-harness', 'scripts', 'aimix-run.sh');
// macOS では PATH の bash (Homebrew 5.x) ではなく /bin/bash 3.2 で走らせ、3.2 互換を実際に確かめる。
const BASH = process.platform === 'darwin' ? '/bin/bash' : 'bash';

const ROUTES = {
  implement: {
    low: ['codex:gpt-5.6-luna'],
    med: ['codex:gpt-5.6-terra', 'cursor:composer-2.5'],
    high: ['codex:gpt-5.6-sol'],
  },
  refactor: { '*': ['codex:gpt-5.6-terra'] },
};

const runner = new NodeCommandRunner();

describe.skipIf(process.platform === 'win32')('bdboard-harness scripts/aimix-run.sh', () => {
  let tmpRoot: string;
  let projectRoot: string;
  let env: Record<string, string>;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'bdboard-aimix-run-'));
    projectRoot = path.join(tmpRoot, 'project');
    mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });

    const binDir = path.join(tmpRoot, 'bin');
    mkdirSync(binDir, { recursive: true });
    const stub = path.join(binDir, 'aimix');
    writeFileSync(stub, '#!/bin/sh\nprintf "STUB %s\\n" "$*"\n', 'utf8');
    chmodSync(stub, 0o755);

    const home = path.join(tmpRoot, 'home');
    mkdirSync(home, { recursive: true });
    env = {
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: home,
    };

    const init = await runner.run('git', ['init', '-q'], { cwd: projectRoot, env, timeoutMs: 20_000 });
    if (init.exitCode !== 0) {
      throw new Error(`git init failed: ${init.stderr}`);
    }
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeContract(contract: Record<string, unknown>): void {
    writeFileSync(
      path.join(projectRoot, '.claude', 'bdboard-harness.json'),
      `${JSON.stringify(contract)}\n`,
      'utf8',
    );
  }

  async function aimixRun(
    args: readonly string[],
    options?: { readonly cwd?: string; readonly extraEnv?: Record<string, string> },
  ): Promise<CommandResult> {
    return runner.run(BASH, [AIMIX_RUN, ...args], {
      cwd: options?.cwd ?? projectRoot,
      env: { ...env, ...options?.extraEnv },
      timeoutMs: 20_000,
    });
  }

  function expectPassed(result: CommandResult, args: readonly string[]): void {
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`STUB run ${args.join(' ')}\n`);
  }

  function expectStopped(result: CommandResult, ...fragments: readonly string[]): void {
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    for (const fragment of fragments) {
      expect(result.stderr).toContain(fragment);
    }
    expect(result.stderr.trim().split('\n').length).toBeLessThanOrEqual(3);
  }

  it('is packaged as an injectable pack file', async () => {
    const registry = createFsPackRegistry(PACKS_ROOT);
    const pack = await registry.getPack('bdboard-harness');
    const relativePaths = (pack?.files ?? []).map((file) => file.relativePath);
    expect(relativePaths).toContain('scripts/aimix-run.sh');
  });

  it('runs aimix with the same argv when the member:model is a candidate of the cell', async () => {
    writeContract({ mainBranch: 'main', models: { routes: ROUTES } });
    const args = ['--mode', 'implement', '--member', 'codex', '--model', 'gpt-5.6-sol', '--complexity', 'high'];
    expectPassed(await aimixRun(args), args);
  });

  it('stops a model that is not in the cell and lists the candidates', async () => {
    writeContract({ mainBranch: 'main', models: { routes: ROUTES } });
    const result = await aimixRun([
      '--mode', 'implement', '--member', 'codex', '--model', 'gpt-5.6-luna', '--complexity', 'high',
    ]);
    expectStopped(result, 'codex:gpt-5.6-luna', 'implement/high', 'codex:gpt-5.6-sol');
  });

  it('allows the runner-up candidate and uses med when --complexity is omitted', async () => {
    writeContract({ mainBranch: 'main', models: { routes: ROUTES } });
    const args = ['--mode', 'implement', '--member', 'cursor', '--model', 'composer-2.5'];
    expectPassed(await aimixRun(args), args);

    const offCell = await aimixRun(['--mode', 'implement', '--member', 'codex', '--model', 'gpt-5.6-luna']);
    expectStopped(offCell, 'implement/med');
  });

  it('accepts --flag=value and argparse abbreviations', async () => {
    writeContract({ mainBranch: 'main', models: { routes: ROUTES } });
    const inline = ['--mode=implement', '--member=codex', '--model=gpt-5.6-sol', '--complexity=high'];
    expectPassed(await aimixRun(inline), inline);

    // --co は --complexity の一意な前方一致。
    const abbreviated = ['--mode', 'implement', '--member', 'codex', '--model', 'gpt-5.6-luna', '--co', 'high'];
    expectStopped(await aimixRun(abbreviated), 'implement/high');

    // --mod (--mode / --model) は曖昧。aimix 本体が argparse エラーで実行しないので、
    // ラッパーはその名前を無視し (mode は既定の consult のまま) 照合せずに渡す。
    const ambiguous = ['--mod', 'implement', '--member', 'codex', '--model', 'bogus'];
    expectPassed(await aimixRun(ambiguous), ambiguous);
  });

  it('uses the last occurrence of a repeated option', async () => {
    writeContract({ mainBranch: 'main', models: { routes: ROUTES } });
    const args = [
      '--mode', 'consult', '--mode', 'implement', '--member', 'codex',
      '--complexity', 'low', '--complexity', 'high', '--model', 'gpt-5.6-sol',
    ];
    expectPassed(await aimixRun(args), args);
  });

  it('reads the value of --task as a value even when it looks like flags', async () => {
    writeContract({ mainBranch: 'main', models: { routes: ROUTES } });
    const args = [
      '--mode', 'implement', '--task', '--member cursor --model bogus',
      '--member', 'codex', '--model', 'gpt-5.6-terra',
    ];
    expectPassed(await aimixRun(args), args);
  });

  it('does not check consult / review / debate', async () => {
    writeContract({ mainBranch: 'main', models: { routes: ROUTES } });
    for (const mode of ['consult', 'review', 'debate']) {
      const args = ['--mode', mode, '--member', 'codex', '--model', 'bogus'];
      expectPassed(await aimixRun(args), args);
    }
    const noMode = ['--member', 'codex', '--model', 'bogus'];
    expectPassed(await aimixRun(noMode), noMode);
  });

  it('checks refactor like implement', async () => {
    writeContract({ mainBranch: 'main', models: { routes: ROUTES } });
    expectStopped(
      await aimixRun(['--mode', 'refactor', '--member', 'codex', '--model', 'gpt-5.6-sol']),
      'refactor/med',
    );
  });

  it('requires --member and --model and rejects --members in a cell with candidates', async () => {
    writeContract({ mainBranch: 'main', models: { routes: ROUTES } });
    expectStopped(
      await aimixRun(['--mode', 'implement', '--model', 'gpt-5.6-sol', '--complexity', 'high']),
      '--member と --model の明示が必須',
    );
    expectStopped(
      await aimixRun(['--mode', 'implement', '--member', 'codex', '--complexity', 'high']),
      '--model の明示が必須',
    );
    expectStopped(
      await aimixRun([
        '--mode', 'implement', '--members', 'codex', '--model', 'gpt-5.6-sol', '--complexity', 'high',
      ]),
      '--members',
    );
  });

  it('lets a non-empty --member win over --members, as aimix does', async () => {
    writeContract({ mainBranch: 'main', models: { routes: ROUTES } });
    const memberFirst = [
      '--mode', 'implement', '--member', 'codex', '--members', 'cursor', '--model', 'gpt-5.6-sol', '--complexity', 'high',
    ];
    expectPassed(await aimixRun(memberFirst), memberFirst);
    const membersFirst = ['--mode', 'implement', '--members', 'codex', '--member', 'cursor', '--model', 'composer-2.5'];
    expectPassed(await aimixRun(membersFirst), membersFirst);
  });

  it('does not accept a --model that smuggles a candidate on another line', async () => {
    writeContract({ mainBranch: 'main', models: { routes: ROUTES } });
    const result = await aimixRun([
      '--mode', 'implement', '--member', 'codex', '--model', 'gpt-5.6-sol\nbogus', '--complexity', 'high',
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
  });

  it('passes an off-cell model when BDBOARD_ROUTE_OVERRIDE carries a reason, but not an empty one', async () => {
    writeContract({ mainBranch: 'main', models: { routes: ROUTES } });
    const args = ['--mode', 'implement', '--member', 'codex', '--model', 'bogus', '--complexity', 'high'];
    expectPassed(await aimixRun(args, { extraEnv: { BDBOARD_ROUTE_OVERRIDE: '枠逼迫' } }), args);
    expectStopped(await aimixRun(args, { extraEnv: { BDBOARD_ROUTE_OVERRIDE: '' } }), 'codex:bogus');
  });

  it('passes without output when the contract has no models table for the cell', async () => {
    writeContract({ mainBranch: 'main' });
    const args = ['--mode', 'implement', '--member', 'codex', '--model', 'bogus'];
    const result = await aimixRun(args);
    expectPassed(result, args);
    expect(result.stderr).toBe('');
  });

  it('stops only excluded or unnamed members in a cell emptied by models.exclude', async () => {
    writeContract({
      mainBranch: 'main',
      models: {
        routes: ROUTES,
        exclude: [{ member: 'codex', until: '2999-01-01' }],
      },
    });
    expectStopped(
      await aimixRun(['--mode', 'implement', '--member', 'codex', '--model', 'gpt-5.6-sol', '--complexity', 'high']),
      'models.exclude',
      'codex',
    );
    expectStopped(
      await aimixRun(['--mode', 'implement', '--complexity', 'high']),
      '--member の明示が必須',
    );
    const other = ['--mode', 'implement', '--member', 'cursor', '--model', 'composer-2.5', '--complexity', 'high'];
    expectPassed(await aimixRun(other), other);
    // --members の先頭の空でない member (空白・空要素を飛ばす) が除外中なら止める。
    expectStopped(
      await aimixRun(['--mode', 'implement', '--members', ' , codex', '--complexity', 'high']),
      'models.exclude',
    );
  });

  it('runs without checking, with one warning line, when route.sh rejects the contract', async () => {
    writeFileSync(path.join(projectRoot, '.claude', 'bdboard-harness.json'), '{not json\n', 'utf8');
    const args = ['--mode', 'implement', '--member', 'codex', '--model', 'bogus'];
    const result = await aimixRun(args);
    expectPassed(result, args);
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
  });

  it('runs without checking, with one warning line, outside a git repository', async () => {
    const outside = path.join(tmpRoot, 'outside');
    mkdirSync(outside, { recursive: true });
    const args = ['--mode', 'implement', '--member', 'codex', '--model', 'bogus'];
    const result = await aimixRun(args, { cwd: outside });
    expectPassed(result, args);
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
  });

  it('runs AIMIX_BIN instead of aimix on PATH when it is set', async () => {
    writeContract({ mainBranch: 'main', models: { routes: ROUTES } });
    const altBin = path.join(tmpRoot, 'alt-aimix');
    writeFileSync(altBin, '#!/bin/sh\nprintf "ALT %s\\n" "$*"\n', 'utf8');
    chmodSync(altBin, 0o755);
    const args = ['--mode', 'implement', '--member', 'codex', '--model', 'gpt-5.6-sol', '--complexity', 'high'];
    const result = await aimixRun(args, { extraEnv: { AIMIX_BIN: altBin } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`ALT run ${args.join(' ')}\n`);
  });

  it('reads the contract of the --cwd project', async () => {
    writeContract({ mainBranch: 'main', models: { routes: ROUTES } });
    const outside = path.join(tmpRoot, 'outside');
    mkdirSync(outside, { recursive: true });
    const result = await aimixRun(
      ['--mode', 'implement', '--cwd', projectRoot, '--member', 'codex', '--model', 'bogus'],
      { cwd: outside },
    );
    expectStopped(result, 'codex:bogus');
  });

  it('falls back to the calling project when --cwd is outside any git repository', async () => {
    writeContract({ mainBranch: 'main', models: { routes: ROUTES } });
    const outside = path.join(tmpRoot, 'outside');
    mkdirSync(outside, { recursive: true });
    const result = await aimixRun(['--mode', 'implement', '--cwd', outside, '--member', 'codex', '--model', 'bogus']);
    expectStopped(result, 'codex:bogus');
  });
});
