import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHILD_OPTIONS = {
  cwd: REPO_ROOT,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  timeout: 60_000,
  maxBuffer: 10 * 1024 * 1024,
};

/** package.json の GitHub URL または owner/repo から API 用 slug を取り出す。 */
export function parseRepoSlug(value) {
  if (typeof value !== 'string') {
    throw new Error('GitHub repository URL is missing');
  }
  const input = value.trim().replace(/^git\+/, '').replace(/\.git$/, '');
  const sshMatch = /^git@github\.com:([^/\s]+)\/([^/\s]+)$/i.exec(input);
  const urlMatch = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)$/i.exec(input);
  const bareMatch = /^([^/\s]+)\/([^/\s]+)$/.exec(input);
  const match = sshMatch ?? urlMatch ?? bareMatch;
  if (!match) {
    throw new Error(`GitHub repository URL is invalid: ${value}`);
  }
  return `${match[1]}/${match[2]}`;
}

/** gh api の JSON Lines を、PR を含めず issue だけに正規化する。 */
export function parseIssueLines(output) {
  const issues = [];
  for (const line of output.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      throw new Error('gh の出力が JSON Lines として解析できません');
    }
    if (!Number.isInteger(item?.number) || typeof item.title !== 'string' || typeof item.pull_request !== 'boolean') {
      throw new Error('gh の出力形式が想定と異なります');
    }
    if (!item.pull_request) issues.push({ number: item.number, title: item.title });
  }
  return issues;
}

/** external_ref のうち、このリポジトリの GitHub issue を指す番号を返す。 */
export function linkedIssueNumbers(externalRefs, slug) {
  const linked = new Set();
  const escapedSlug = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const issueUrl = new RegExp(`^https?://github\\.com/${escapedSlug}/issues/(\\d+)$`, 'i');
  for (const ref of externalRefs) {
    if (typeof ref !== 'string') continue;
    const normalized = ref.trim();
    const shortRef = /^gh-(\d+)$/i.exec(normalized);
    const urlRef = issueUrl.exec(normalized);
    const number = shortRef?.[1] ?? urlRef?.[1];
    if (number) linked.add(Number(number));
  }
  return linked;
}

export function findUnlinkedIssues(issues, linkedNumbers) {
  return issues.filter((issue) => !linkedNumbers.has(issue.number));
}

export function formatReport(unlinked, checkedCount) {
  if (unlinked.length === 0) {
    return `check:gh-issues: OK — open issue ${checkedCount} 件はすべて bd に紐付いています。`;
  }
  return [
    `check:gh-issues: bd の external_ref に未紐付けの open issue が ${unlinked.length} 件あります:`,
    ...unlinked.map((issue) => `#${issue.number} ${issue.title}`),
    'check:gh-issues: bd create ... --external-ref gh-<番号>、または既存チケットに bd update <id> --external-ref gh-<番号> を実行してください。',
  ].join('\n');
}

function invocation(name) {
  const bin = process.env[`BDBOARD_GH_ISSUES_${name}`] || name.toLowerCase();
  const rawArgs = process.env[`BDBOARD_GH_ISSUES_${name}_ARGS`];
  if (!rawArgs) return { bin, prefixArgs: [] };
  let prefixArgs;
  try {
    prefixArgs = JSON.parse(rawArgs);
  } catch {
    throw new Error(`BDBOARD_GH_ISSUES_${name}_ARGS is not a JSON array`);
  }
  if (!Array.isArray(prefixArgs)) {
    throw new Error(`BDBOARD_GH_ISSUES_${name}_ARGS is not a JSON array`);
  }
  return { bin, prefixArgs };
}

function failureReason(error, command) {
  if (error?.code === 'ENOENT') return `${command} コマンドが見つかりません`;
  const stderr = String(error?.stderr ?? '').trim();
  if (stderr) return stderr.split(/\r?\n/).slice(0, 3).join(' ').trim();
  return String(error?.message ?? error).replace(/\s+/g, ' ').trim();
}

function run(bin, args) {
  return execFileSync(bin, args, CHILD_OPTIONS);
}

function externalRefsFromBd(output) {
  let tickets;
  try {
    tickets = JSON.parse(output);
  } catch {
    throw new Error('bd の出力が JSON として解析できません');
  }
  const entries = Array.isArray(tickets) ? tickets : tickets?.issues;
  if (!Array.isArray(entries)) throw new Error('bd の出力形式が想定と異なります');
  return entries.map((ticket) => ticket?.external_ref).filter((ref) => typeof ref === 'string');
}

function repositorySlug() {
  const override = process.env.BDBOARD_GH_ISSUES_REPO;
  if (override) return parseRepoSlug(override);
  const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  return parseRepoSlug(packageJson?.repository?.url);
}

function main() {
  // 注入設定の壊れ方はテスト/呼び出し側のプログラミングエラーなので、skip にしない。
  const gh = invocation('GH');
  const bd = invocation('BD');
  const slug = repositorySlug();
  let issues;
  try {
    const output = run(gh.bin, [
      ...gh.prefixArgs,
      'api', '--paginate',
      `repos/${slug}/issues?state=open&per_page=100`,
      '--jq', '.[] | {number, title, pull_request: (has("pull_request"))} | @json',
    ]);
    issues = parseIssueLines(output);
  } catch (error) {
    console.log(`check:gh-issues: GitHub の open issue を取得できませんでした (${failureReason(error, 'gh')})。スキップします。`);
    return;
  }
  let externalRefs;
  try {
    externalRefs = externalRefsFromBd(run(bd.bin, [...bd.prefixArgs, 'list', '--all', '--json', '--limit', '0']));
  } catch (error) {
    console.log(`check:gh-issues: bd チケットを取得できませんでした (${failureReason(error, 'bd')})。スキップします。`);
    return;
  }
  console.log(formatReport(findUnlinkedIssues(issues, linkedIssueNumbers(externalRefs, slug)), issues.length));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
