import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandResult, CommandRunner } from '../../application/ports/command-runner.js';
import {
  DEPLOY_STATUS_TOOL_DEFINITION,
  DEPLOY_STATUS_TOOL_NAME,
  isDeployStatusToolName,
  runDeployStatusTool,
} from './deploy-status-tool.js';

const PROJECT_ROOT = '/tmp/bdboard-deploy-status-test';
const ORIGIN_MAIN_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BUILD_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

interface RunCall {
  readonly command: string;
  readonly args: readonly string[];
}

function createFakeRunner(
  handler: (command: string, args: readonly string[]) => CommandResult,
): { readonly runner: CommandRunner; readonly calls: RunCall[] } {
  const calls: RunCall[] = [];
  const runner: CommandRunner = {
    async run(command, args) {
      calls.push({ command, args });
      return handler(command, args);
    },
  };
  return { runner, calls };
}

function textOf(result: { content: ReadonlyArray<{ text: string }> }): string {
  return result.content[0]?.text ?? '';
}

describe('DEPLOY_STATUS_TOOL_DEFINITION', () => {
  it('is readonly', () => {
    expect(DEPLOY_STATUS_TOOL_DEFINITION.writes).toBe(false);
    expect(DEPLOY_STATUS_TOOL_DEFINITION.name).toBe('deploy_status');
  });
});

describe('isDeployStatusToolName', () => {
  it('matches only the exact tool name', () => {
    expect(isDeployStatusToolName(DEPLOY_STATUS_TOOL_NAME)).toBe(true);
    expect(isDeployStatusToolName('deploy_status_extra')).toBe(false);
    expect(isDeployStatusToolName('bd_show')).toBe(false);
  });
});

describe('runDeployStatusTool', () => {
  let webDistDir: string;

  beforeEach(() => {
    webDistDir = mkdtempSync(path.join(os.tmpdir(), 'bdboard-deploy-status-'));
  });

  afterEach(() => {
    rmSync(webDistDir, { recursive: true, force: true });
  });

  it('reports web/dist not found without running git', async () => {
    rmSync(webDistDir, { recursive: true, force: true });
    const { runner, calls } = createFakeRunner(() => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
    }));

    const result = await runDeployStatusTool({
      commandRunner: runner,
      projectRootPath: PROJECT_ROOT,
      gitPath: 'git',
      timeoutMs: 1000,
      webDistDir,
    });

    expect(calls).toHaveLength(0);
    expect(result.isError).toBe(false);
    expect(textOf(result)).toContain('web/dist not found');
  });

  it('reports commitsBehind=unknown when build-meta.json is missing', async () => {
    const { runner, calls } = createFakeRunner((_command, args) => {
      expect(args).toContain('rev-parse');
      return { stdout: `${ORIGIN_MAIN_SHA}\n`, stderr: '', exitCode: 0 };
    });

    const result = await runDeployStatusTool({
      commandRunner: runner,
      projectRootPath: PROJECT_ROOT,
      gitPath: 'git',
      timeoutMs: 1000,
      webDistDir,
    });

    expect(calls).toHaveLength(1);
    expect(result.isError).toBe(false);
    const text = textOf(result);
    expect(text).toContain('buildSha=unknown');
    expect(text).toContain(`originMainSha=${ORIGIN_MAIN_SHA}`);
    expect(text).toContain('commitsBehind=unknown');
  });

  it('computes commitsBehind from build-meta.json and git rev-list', async () => {
    writeFileSync(
      path.join(webDistDir, 'build-meta.json'),
      JSON.stringify({ sha: BUILD_SHA, builtAt: '2026-08-20T00:00:00.000Z' }),
    );

    const { runner, calls } = createFakeRunner((_command, args) => {
      if (args.includes('rev-parse')) {
        return { stdout: `${ORIGIN_MAIN_SHA}\n`, stderr: '', exitCode: 0 };
      }
      if (args.includes('rev-list')) {
        expect(args).toContain(`${BUILD_SHA}...${ORIGIN_MAIN_SHA}`);
        return { stdout: '0\t3\n', stderr: '', exitCode: 0 };
      }
      throw new Error(`unexpected args: ${args.join(' ')}`);
    });

    const result = await runDeployStatusTool({
      commandRunner: runner,
      projectRootPath: PROJECT_ROOT,
      gitPath: 'git',
      timeoutMs: 1000,
      webDistDir,
    });

    expect(calls).toHaveLength(2);
    expect(result.isError).toBe(false);
    const text = textOf(result);
    expect(text).toContain(`buildSha=${BUILD_SHA}`);
    expect(text).toContain('builtAt=2026-08-20T00:00:00.000Z');
    expect(text).toContain('commitsBehind=3');
    expect(text).not.toContain('commitsAheadOfMain');
  });

  it('flags divergence when the build sha has commits not reachable from origin/main', async () => {
    writeFileSync(
      path.join(webDistDir, 'build-meta.json'),
      JSON.stringify({ sha: BUILD_SHA, builtAt: '2026-08-20T00:00:00.000Z' }),
    );

    const { runner } = createFakeRunner((_command, args) => {
      if (args.includes('rev-parse')) {
        return { stdout: `${ORIGIN_MAIN_SHA}\n`, stderr: '', exitCode: 0 };
      }
      if (args.includes('rev-list')) {
        return { stdout: '2\t3\n', stderr: '', exitCode: 0 };
      }
      throw new Error(`unexpected args: ${args.join(' ')}`);
    });

    const result = await runDeployStatusTool({
      commandRunner: runner,
      projectRootPath: PROJECT_ROOT,
      gitPath: 'git',
      timeoutMs: 1000,
      webDistDir,
    });

    expect(result.isError).toBe(false);
    const text = textOf(result);
    expect(text).toContain('commitsBehind=3');
    expect(text).toContain('commitsAheadOfMain=2');
  });

  it('returns isError when origin/main cannot be resolved', async () => {
    const { runner } = createFakeRunner(() => ({
      stdout: '',
      stderr: "fatal: ambiguous argument 'origin/main': unknown revision",
      exitCode: 128,
    }));

    const result = await runDeployStatusTool({
      commandRunner: runner,
      projectRootPath: PROJECT_ROOT,
      gitPath: 'git',
      timeoutMs: 1000,
      webDistDir,
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('origin/main の解決に失敗');
  });

  it('reports commitsBehind=unknown when rev-list fails (e.g. buildSha unreachable)', async () => {
    writeFileSync(
      path.join(webDistDir, 'build-meta.json'),
      JSON.stringify({ sha: BUILD_SHA, builtAt: '2026-08-20T00:00:00.000Z' }),
    );

    const { runner } = createFakeRunner((_command, args) => {
      if (args.includes('rev-parse')) {
        return { stdout: `${ORIGIN_MAIN_SHA}\n`, stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: 'fatal: bad revision', exitCode: 128 };
    });

    const result = await runDeployStatusTool({
      commandRunner: runner,
      projectRootPath: PROJECT_ROOT,
      gitPath: 'git',
      timeoutMs: 1000,
      webDistDir,
    });

    expect(result.isError).toBe(false);
    expect(textOf(result)).toContain('commitsBehind=unknown');
  });

  it('defaults webDistDir to <projectRootPath>/web/dist when not overridden', async () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'bdboard-deploy-status-root-'));
    try {
      mkdirSync(path.join(tempRoot, 'web', 'dist'), { recursive: true });
      const { runner } = createFakeRunner(() => ({
        stdout: `${ORIGIN_MAIN_SHA}\n`,
        stderr: '',
        exitCode: 0,
      }));

      const result = await runDeployStatusTool({
        commandRunner: runner,
        projectRootPath: tempRoot,
        gitPath: 'git',
        timeoutMs: 1000,
      });

      expect(result.isError).toBe(false);
      expect(textOf(result)).toContain('buildSha=unknown');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
