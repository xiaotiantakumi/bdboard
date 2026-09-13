import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findUnlinkedIssues,
  formatReport,
  linkedIssueNumbers,
  parseIssueLines,
  parseRepoSlug,
} from './check-gh-issues.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(DIR, 'check-gh-issues.mjs');
const FAKE_CLI = path.join(DIR, 'fake-cli.mjs');
// check-drift と同じ理由で、Windows の subprocess は余裕を持たせる。
const CLI_TEST_TIMEOUT_MS = process.platform === 'win32' ? 60_000 : 15_000;
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function spec(directory, name, value) {
  const file = path.join(directory, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

function runCli({ ghSpec, bdSpec, extraEnv = {} }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'check-gh-issues-'));
  temporaryDirectories.push(directory);
  const ghSpecPath = spec(directory, 'gh', ghSpec);
  const bdSpecPath = spec(directory, 'bd', bdSpec);
  return {
    result: spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      timeout: CLI_TEST_TIMEOUT_MS,
      env: {
        ...process.env,
        BDBOARD_GH_ISSUES_REPO: 'xiaotiantakumi/bdboard',
        BDBOARD_GH_ISSUES_GH: process.execPath,
        BDBOARD_GH_ISSUES_GH_ARGS: JSON.stringify([FAKE_CLI, ghSpecPath]),
        BDBOARD_GH_ISSUES_BD: process.execPath,
        BDBOARD_GH_ISSUES_BD_ARGS: JSON.stringify([FAKE_CLI, bdSpecPath]),
        ...extraEnv,
      },
    }),
    directory,
  };
}

describe('check:gh-issues pure functions', () => {
  it('derives a slug from the repository URL', () => {
    expect(parseRepoSlug('git+https://github.com/xiaotiantakumi/bdboard.git')).toBe('xiaotiantakumi/bdboard');
  });

  it('removes pull requests from JSON Lines', () => {
    expect(parseIssueLines('{"number":431,"title":"issue","pull_request":false}\n{"number":432,"title":"PR","pull_request":true}\n'))
      .toEqual([{ number: 431, title: 'issue' }]);
  });

  it('recognizes short refs and this repository issue URLs case-insensitively', () => {
    expect([...linkedIssueNumbers(['GH-431', 'https://github.com/xiaotiantakumi/bdboard/issues/432', 'https://github.com/elsewhere/bdboard/issues/433'], 'xiaotiantakumi/bdboard')])
      .toEqual([431, 432]);
  });

  it('finds only issues without a link and formats an actionable report', () => {
    const unlinked = findUnlinkedIssues([{ number: 1, title: 'one' }, { number: 2, title: 'two' }], new Set([2]));
    expect(unlinked).toEqual([{ number: 1, title: 'one' }]);
    expect(formatReport(unlinked, 2)).toContain('#1 one');
  });
});

describe('check:gh-issues CLI', () => {
  it('prints only unlinked issues, excluding linked issues and pull requests', () => {
    const { result } = runCli({
      ghSpec: { stdout: '{"number":430,"title":"unlinked","pull_request":false}\n{"number":431,"title":"linked","pull_request":false}\n{"number":432,"title":"pull request","pull_request":true}\n' },
      bdSpec: { stdout: '[{"id":"closed-ticket","status":"closed","external_ref":"gh-431"}]' },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('#430 unlinked');
    expect(result.stdout).not.toContain('#431 linked');
    expect(result.stdout).not.toContain('#432 pull request');
  }, CLI_TEST_TIMEOUT_MS);

  it('uses REST issue arguments and never GraphQL', () => {
    // 引数の記録先は afterEach で消える per-test の一時ディレクトリに置く。
    const argsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'check-gh-issues-args-'));
    temporaryDirectories.push(argsDirectory);
    const argsFile = path.join(argsDirectory, 'gh-args.txt');
    const { result } = runCli({
      ghSpec: { stdout: '', argsFile },
      bdSpec: { stdout: '[]' },
    });
    const args = fs.readFileSync(argsFile, 'utf8');
    expect(result.status).toBe(0);
    expect(args).toContain('api');
    expect(args).toContain('repos/xiaotiantakumi/bdboard/issues?state=open&per_page=100');
    expect(args.toLowerCase()).not.toContain('graphql');
  }, CLI_TEST_TIMEOUT_MS);

  it('reports OK when every issue is linked', () => {
    const { result } = runCli({
      ghSpec: { stdout: '{"number":431,"title":"linked","pull_request":false}\n' },
      bdSpec: { stdout: '[{"external_ref":"gh-431"}]' },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('OK');
  }, CLI_TEST_TIMEOUT_MS);

  it('advises and exits zero when gh fails', () => {
    const { result } = runCli({
      ghSpec: { stderr: 'not logged in\nrun gh auth login\n', exitCode: 1 },
      bdSpec: { stdout: '[]' },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('取得できませんでした');
    expect(result.stdout).toContain('not logged in');
  }, CLI_TEST_TIMEOUT_MS);

  it('advises and exits zero when gh is missing', () => {
    const { result } = runCli({
      ghSpec: { stdout: '' }, bdSpec: { stdout: '[]' },
      extraEnv: { BDBOARD_GH_ISSUES_GH: path.join(os.tmpdir(), 'missing-gh-command') },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('gh コマンドが見つかりません');
  }, CLI_TEST_TIMEOUT_MS);

  it('advises and exits zero when bd fails', () => {
    const { result } = runCli({
      ghSpec: { stdout: '{"number":430,"title":"issue","pull_request":false}\n' },
      bdSpec: { stderr: 'bd unavailable', exitCode: 1 },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('bd チケットを取得できませんでした');
    expect(result.stdout).toContain('bd unavailable');
  }, CLI_TEST_TIMEOUT_MS);

  it('fails loudly for malformed executable injection arguments', () => {
    const { result } = runCli({
      ghSpec: { stdout: '' }, bdSpec: { stdout: '[]' },
      extraEnv: { BDBOARD_GH_ISSUES_GH_ARGS: '{not-json' },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('BDBOARD_GH_ISSUES_GH_ARGS is not a JSON array');
  }, CLI_TEST_TIMEOUT_MS);
});
