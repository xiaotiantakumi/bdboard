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
  sanitizeTitle,
} from './check-gh-issues.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(DIR, 'check-gh-issues.mjs');
const FAKE_CLI = path.join(DIR, 'fake-cli.mjs');
// check-drift と同じ理由で、Windows の subprocess は余裕を持たせる。
const CLI_TEST_TIMEOUT_MS = process.platform === 'win32' ? 60_000 : 15_000;
const EXPECTED_GH_ARGS = [
  'api',
  '--paginate',
  'repos/xiaotiantakumi/bdboard/issues?state=open&per_page=100',
  '--jq',
  '.[] | {number, title, pull_request: (has("pull_request"))} | @json',
];
const EXPECTED_BD_ARGS = ['list', '--all', '--json', '--limit', '0', '--brief'];
// 端末制御文字 ESC を含むタイトル (外部入力のサニタイズ確認用)。
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function readArgs(file) {
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line !== '');
}

/**
 * gh と bd の両方を fake-cli に差し替えて本スクリプトを起動する。実 GitHub・実 bd には
 * 決して届かない。各スタブが受け取った argv は per-test の一時ディレクトリに記録する。
 */
function runCli({ ghSpec, bdSpec, extraEnv = {} }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'check-gh-issues-'));
  temporaryDirectories.push(directory);
  const ghArgsFile = path.join(directory, 'gh-args.txt');
  const bdArgsFile = path.join(directory, 'bd-args.txt');
  const ghSpecPath = path.join(directory, 'gh.json');
  const bdSpecPath = path.join(directory, 'bd.json');
  fs.writeFileSync(ghSpecPath, JSON.stringify({ ...ghSpec, argsFile: ghArgsFile }));
  fs.writeFileSync(bdSpecPath, JSON.stringify({ ...bdSpec, argsFile: bdArgsFile }));
  const result = spawnSync(process.execPath, [SCRIPT], {
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
  });
  return { result, ghArgs: () => readArgs(ghArgsFile), bdArgs: () => readArgs(bdArgsFile) };
}

const issueLine = (number, title, pullRequest = false) =>
  `${JSON.stringify({ number, title, pull_request: pullRequest })}\n`;

describe('check:gh-issues pure functions', () => {
  it('derives a slug from the repository URL', () => {
    expect(parseRepoSlug('git+https://github.com/xiaotiantakumi/bdboard.git')).toBe('xiaotiantakumi/bdboard');
  });

  it('removes pull requests from JSON Lines', () => {
    expect(parseIssueLines(`${issueLine(431, 'issue')}${issueLine(432, 'PR', true)}`))
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

  it('says there are no open issues instead of "all 0 linked"', () => {
    expect(formatReport([], 0)).toBe('check:gh-issues: OK — open な issue はありません。');
  });

  it('replaces control characters in externally written titles', () => {
    expect(sanitizeTitle(`evil${ESC}[2Jtitle${BEL}`)).toBe('evil [2Jtitle ');
  });
});

describe('check:gh-issues CLI', () => {
  it('prints only unlinked issues, excluding linked issues and pull requests', () => {
    const { result } = runCli({
      ghSpec: { stdout: `${issueLine(430, 'unlinked')}${issueLine(431, 'linked')}${issueLine(432, 'pull request', true)}` },
      bdSpec: { stdout: '[{"id":"closed-ticket","status":"closed","external_ref":"gh-431"}]' },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('#430 unlinked');
    expect(result.stdout).not.toContain('#431');
    expect(result.stdout).not.toContain('#432');
  }, CLI_TEST_TIMEOUT_MS);

  it('calls gh and bd with exactly the read-only REST / list arguments', () => {
    const { result, ghArgs, bdArgs } = runCli({
      ghSpec: { stdout: issueLine(431, 'linked') },
      bdSpec: { stdout: '[{"external_ref":"gh-431"}]' },
    });
    expect(result.status).toBe(0);
    // argv 全体を固定する: --paginate の脱落 (101 件目以降が黙って欠ける)、graphql、
    // -f / -X 等の書き込み系フラグの混入はすべてここで落ちる。
    expect(ghArgs()).toEqual(EXPECTED_GH_ARGS);
    expect(bdArgs()).toEqual(EXPECTED_BD_ARGS);
  }, CLI_TEST_TIMEOUT_MS);

  it('reports OK when every issue is linked', () => {
    const { result } = runCli({
      ghSpec: { stdout: issueLine(431, 'linked') },
      bdSpec: { stdout: '[{"external_ref":"gh-431"}]' },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('OK — open issue 1 件はすべて bd に紐付いています');
  }, CLI_TEST_TIMEOUT_MS);

  it('accepts an {issues: [...]} bd payload and URL-form external_refs', () => {
    const { result } = runCli({
      ghSpec: { stdout: `${issueLine(432, 'linked by url')}${issueLine(433, 'unlinked')}` },
      bdSpec: { stdout: JSON.stringify({ issues: [{ external_ref: 'https://github.com/xiaotiantakumi/bdboard/issues/432' }] }) },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('#433 unlinked');
    expect(result.stdout).not.toContain('#432');
  }, CLI_TEST_TIMEOUT_MS);

  it('strips terminal control characters from printed titles', () => {
    const { result } = runCli({
      ghSpec: { stdout: issueLine(430, `evil${ESC}[2Jtitle`) },
      bdSpec: { stdout: '[]' },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('#430 evil [2Jtitle');
    expect(result.stdout).not.toContain(ESC);
  }, CLI_TEST_TIMEOUT_MS);

  it('advises and exits zero when gh fails, without querying bd', () => {
    const { result, bdArgs } = runCli({
      ghSpec: { stderr: 'not logged in\nrun gh auth login\n', exitCode: 1 },
      bdSpec: { stdout: '[]' },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('GitHub の open issue を取得できませんでした');
    expect(result.stdout).toContain('not logged in');
    expect(bdArgs()).toBeNull();
  }, CLI_TEST_TIMEOUT_MS);

  it('advises and exits zero when gh output is not the expected JSON Lines', () => {
    const { result } = runCli({
      ghSpec: { stdout: '[{"number":1}]\n' },
      bdSpec: { stdout: '[]' },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('GitHub の open issue を取得できませんでした');
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
      ghSpec: { stdout: issueLine(430, 'issue') },
      bdSpec: { stderr: 'bd unavailable', exitCode: 1 },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('bd チケットを取得できませんでした');
    expect(result.stdout).toContain('bd unavailable');
  }, CLI_TEST_TIMEOUT_MS);

  it('advises and exits zero when bd output is not JSON', () => {
    const { result } = runCli({
      ghSpec: { stdout: issueLine(430, 'issue') },
      bdSpec: { stdout: 'not json' },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('bd の出力が JSON として解析できません');
  }, CLI_TEST_TIMEOUT_MS);

  it('advises and exits zero when bd is missing', () => {
    const { result } = runCli({
      ghSpec: { stdout: issueLine(430, 'issue') }, bdSpec: { stdout: '[]' },
      extraEnv: { BDBOARD_GH_ISSUES_BD: path.join(os.tmpdir(), 'missing-bd-command') },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('bd コマンドが見つかりません');
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
