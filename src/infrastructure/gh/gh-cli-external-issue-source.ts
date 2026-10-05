import type { CommandResult, CommandRunner } from '../../application/ports/command-runner.js';
import type {
  ExternalIssue,
  ExternalIssueFailureKind,
  ExternalIssueListResult,
  ExternalIssueSourcePort,
} from '../../application/ports/external-issue-source.js';
import { parseRepoSlug } from '../../domain/github-issue-link.js';
import { GH_API_HOSTNAME, assertReadOnlyGhApiArgs } from './gh-api-readonly.js';
import {
  GH_EXIT_CODE_AUTH_REQUIRED,
  looksLikeGhUnauthenticated,
  looksLikeRateLimit,
} from './gh-cli-failure.js';
import { parseExternalIssueLines } from './gh-external-issue-lines.js';

const DEFAULT_GH_PATH = 'gh';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_PAGES = 3;
const DEFAULT_REPO_SLUG = 'xiaotiantakumi/bdboard';
const ISSUES_PER_PAGE = 100;
const DETAIL_MAX_CHARS = 300;
const TIMEOUT_DETAIL = 'gh timed out (no response within the time limit)';

/**
 * 本文は先頭 20,001 コードポイントで切る (第三者の文章の量を抑える。20,000 ちょうどと超過を
 * 区別するため 1 つ多く取り、切る前の長さは bodyLength で渡す)。jq の切り出しと length は
 * コードポイント単位で、JS の String.length (UTF-16 の単位) とは数が違いうる。PR は pullRequest で印を付けて
 * 後で除く。author は削除済みユーザーだと null になる。
 */
const OPEN_ISSUES_JQ =
  '.[] | {number, title, body: ((.body // "")[0:20001]), bodyLength: ((.body // "") | length), updatedAt: .updated_at, author: .user.login, authorAssociation: .author_association, pullRequest: has("pull_request")} | @json';

export interface GhCliExternalIssueSourceOptions {
  readonly ghPath?: string;
  readonly timeoutMs?: number;
  /** 読む対象のリポジトリ (`owner/repo`)。gh の URL パスに埋めるので生成時に検査する。 */
  readonly repoSlug?: string;
  readonly maxPages?: number;
  /** 子プロセスへ継ぐ環境 (既定は process.env。テスト用)。 */
  readonly baseEnv?: NodeJS.ProcessEnv;
}

/**
 * 画面に出しうる文字列なので、制御文字 (C0/C1 と、文字の向きを変える双方向制御文字
 * U+200E/200F/061C/202A–202E/2066–2069) を空白にして、300 コードポイントに切る。
 * UTF-16 の `slice` だとサロゲートの対を途中で割るので、コードポイントで切る。
 */
function toDetail(text: string): string {
  const trimmed = text.trim() === '' ? 'gh command failed' : text.trim();
  const cleaned = trimmed.replace(
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    ' ',
  );
  return Array.from(cleaned).slice(0, DETAIL_MAX_CHARS).join('');
}

function failure(kind: ExternalIssueFailureKind, text: string): ExternalIssueListResult {
  return { ok: false, kind, detail: toDetail(text) };
}

/**
 * 失敗の分類。見るのは終了状態と stderr だけ。成功したページの stdout は第三者の文章なので、
 * 失敗の判定には混ぜない。
 */
function classifyFailure(result: CommandResult): ExternalIssueListResult {
  if (result.failureKind === 'spawn-failed') {
    return failure('gh-missing', result.stderr);
  }
  if (result.failureKind === 'timeout') {
    return failure('failed', TIMEOUT_DETAIL);
  }
  if (result.exitCode === GH_EXIT_CODE_AUTH_REQUIRED) {
    return failure('gh-unauthenticated', result.stderr);
  }
  if (looksLikeRateLimit(result.stderr)) {
    return failure('rate-limited', result.stderr);
  }
  if (looksLikeGhUnauthenticated(result.stderr)) {
    return failure('gh-unauthenticated', result.stderr);
  }
  return failure('failed', result.stderr);
}

function buildChildEnv(baseEnv: NodeJS.ProcessEnv): Record<string, string> {
  // NodeCommandRunner の env は継承ではなく置き換えなので、継いだ環境を明示して渡す。
  const inherited: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value === 'string') {
      inherited[key] = value;
    }
  }
  return { ...inherited, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' };
}

function buildArgs(slug: string, page: number): string[] {
  return [
    'api',
    '--method',
    'GET',
    // 継いだ GH_HOST が GHE を指していても、github.com で組んだ url と食い違わないよう固定する。
    '--hostname',
    GH_API_HOSTNAME,
    `repos/${slug}/issues?state=open&per_page=${ISSUES_PER_PAGE}&page=${page}`,
    '--jq',
    OPEN_ISSUES_JQ,
  ];
}

/**
 * 公開リポジトリの open issue を `gh api --method GET` で読む (bdboard-4y8q.9.2)。
 * GitHub へは書き込まない。gh が無い・未ログインでも、認証無しの REST・fetch・curl には落ちず、
 * 失敗の種類を返すだけ (U7)。
 */
export function createGhCliExternalIssueSource(
  commandRunner: CommandRunner,
  options?: GhCliExternalIssueSourceOptions,
): ExternalIssueSourcePort {
  const ghPath = options?.ghPath ?? DEFAULT_GH_PATH;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const slug = parseRepoSlug(options?.repoSlug ?? DEFAULT_REPO_SLUG);
  const maxPages = options?.maxPages ?? DEFAULT_MAX_PAGES;
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new Error(`maxPages must be a positive integer: ${maxPages}`);
  }
  const env = buildChildEnv(options?.baseEnv ?? process.env);

  return {
    async listOpenIssues(): Promise<ExternalIssueListResult> {
      const issues: ExternalIssue[] = [];
      const seenNumbers = new Set<number>();
      let skippedLines = 0;
      let pagesFetched = 0;
      let truncatedByPageLimit = false;

      for (let page = 1; page <= maxPages; page += 1) {
        const args = buildArgs(slug, page);
        assertReadOnlyGhApiArgs(args);

        let commandResult: CommandResult;
        try {
          commandResult = await commandRunner.run(ghPath, args, { timeoutMs, env });
        } catch (error) {
          // CommandRunner は投げない契約 (spawn 失敗も結果で返す)。守られなくても外へは出さない。
          return failure('failed', error instanceof Error ? error.message : String(error));
        }
        // 1 ページでも読めなければ、途中までの結果は返さず failed にする。
        if (commandResult.exitCode !== 0) {
          return classifyFailure(commandResult);
        }

        pagesFetched += 1;
        const parsed = parseExternalIssueLines(commandResult.stdout, slug);
        if (parsed.allUnreadable) {
          return failure('failed', 'gh output format was not recognized');
        }
        // 1 ページ目と 2 ページ目の間に新しい issue ができると、押し出された同じ番号が両方の
        // ページに現れる。番号で重複を除く (先に読んだほうを残す)。
        for (const issue of parsed.issues) {
          if (!seenNumbers.has(issue.number)) {
            seenNumbers.add(issue.number);
            issues.push(issue);
          }
        }
        skippedLines += parsed.skippedLines;

        if (parsed.lineCount < ISSUES_PER_PAGE) {
          break;
        }
        if (page === maxPages) {
          truncatedByPageLimit = true;
        }
      }

      return { ok: true, issues, pagesFetched, truncatedByPageLimit, skippedLines };
    },
  };
}
