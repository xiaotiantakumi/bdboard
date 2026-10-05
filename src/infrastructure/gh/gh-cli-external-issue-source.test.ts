import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CommandResult,
  CommandRunOptions,
  CommandRunner,
} from '../../application/ports/command-runner.js';
import { createGhCliExternalIssueSource } from './gh-cli-external-issue-source.js';

// 本物の gh は呼ばない。CommandRunner を差し替え、呼び出し (command, args, options) を記録する。
interface Call {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: CommandRunOptions | undefined;
}

function createFakeRunner(responses: readonly CommandResult[]): {
  runner: CommandRunner;
  calls: Call[];
} {
  const calls: Call[] = [];
  const queue = [...responses];
  const runner: CommandRunner = {
    run(command, args, options) {
      calls.push({ command, args, options });
      return Promise.resolve(queue.shift() ?? { stdout: '', stderr: '', exitCode: 0 });
    },
  };
  return { runner, calls };
}

const ok = (stdout: string): CommandResult => ({ stdout, stderr: '', exitCode: 0 });
const failed = (stderr: string, exitCode = 1): CommandResult => ({ stdout: '', stderr, exitCode });

function issueLine(number: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    number,
    title: `issue ${number}`,
    body: 'body text',
    bodyLength: 9,
    updatedAt: '2026-10-05T00:00:00Z',
    author: 'someone',
    authorAssociation: 'NONE',
    pullRequest: false,
    ...extra,
  });
}

/** n 行 (番号 first から) の stdout。 */
function page(first: number, count: number, prNumbers: readonly number[] = []): string {
  const lines = Array.from({ length: count }, (_, index) =>
    issueLine(first + index, { pullRequest: prNumbers.includes(first + index) }),
  );
  return `${lines.join('\n')}\n`;
}

const EXPECTED_JQ =
  '.[] | {number, title, body: ((.body // "")[0:20001]), bodyLength: ((.body // "") | length), updatedAt: .updated_at, author: .user.login, authorAssociation: .author_association, pullRequest: has("pull_request")} | @json';

const expectedArgs = (pageNumber: number): string[] => [
  'api',
  '--method',
  'GET',
  `repos/xiaotiantakumi/bdboard/issues?state=open&per_page=100&page=${pageNumber}`,
  '--jq',
  EXPECTED_JQ,
];

const WRITE_FLAGS = ['-f', '-F', '--field', '--raw-field', '--input', '-X'];

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe('createGhCliExternalIssueSource: what it asks gh', () => {
  it('passes exactly the read-only GET arguments for every page', async () => {
    const { runner, calls } = createFakeRunner([ok(page(1, 100)), ok(page(101, 100)), ok(page(201, 5))]);

    await createGhCliExternalIssueSource(runner).listOpenIssues();

    expect(calls.map((call) => call.args)).toEqual([expectedArgs(1), expectedArgs(2), expectedArgs(3)]);
  });

  it('never carries a write argument and always names --method GET exactly once (R9)', async () => {
    const { runner, calls } = createFakeRunner([ok(page(1, 100)), ok(page(101, 100)), ok(page(201, 100))]);

    await createGhCliExternalIssueSource(runner).listOpenIssues();

    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.command).toBe('gh');
      expect(call.args[0]).toBe('api');
      for (const flag of WRITE_FLAGS) {
        expect(call.args).not.toContain(flag);
      }
      expect(call.args.some((arg) => /^(--field|--raw-field|--input)=/.test(arg))).toBe(false);
      expect(call.args.filter((arg) => arg === '--method')).toHaveLength(1);
      expect(call.args[call.args.indexOf('--method') + 1]).toBe('GET');
    }
  });

  it('uses the given gh path and slug', async () => {
    const { runner, calls } = createFakeRunner([ok('')]);

    await createGhCliExternalIssueSource(runner, {
      ghPath: '/opt/homebrew/bin/gh',
      repoSlug: 'owner/repo',
    }).listOpenIssues();

    expect(calls[0].command).toBe('/opt/homebrew/bin/gh');
    expect(calls[0].args[3]).toBe('repos/owner/repo/issues?state=open&per_page=100&page=1');
  });

  it('inherits the environment, adds the prompt / update-notifier switches, and times out at 20 seconds', async () => {
    const { runner, calls } = createFakeRunner([ok('')]);

    await createGhCliExternalIssueSource(runner, {
      baseEnv: { PATH: '/usr/bin', HOME: '/home/x', UNSET: undefined, GH_PROMPT_DISABLED: '0' },
    }).listOpenIssues();

    expect(calls[0].options).toEqual({
      timeoutMs: 20_000,
      env: {
        PATH: '/usr/bin',
        HOME: '/home/x',
        GH_PROMPT_DISABLED: '1',
        GH_NO_UPDATE_NOTIFIER: '1',
      },
    });
  });

  it('refuses an unsafe repository slug when it is created', () => {
    const { runner } = createFakeRunner([]);
    expect(() => createGhCliExternalIssueSource(runner, { repoSlug: '../bad' })).toThrow();
    expect(() => createGhCliExternalIssueSource(runner, { repoSlug: 'o/r?x=1' })).toThrow();
  });
});

describe('createGhCliExternalIssueSource: paging', () => {
  it('stops at the first page with fewer than 100 lines', async () => {
    const { runner, calls } = createFakeRunner([ok(page(1, 99)), ok(page(100, 100))]);

    const result = await createGhCliExternalIssueSource(runner).listOpenIssues();

    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ ok: true, pagesFetched: 1, truncatedByPageLimit: false, skippedLines: 0 });
    expect(result.ok && result.issues).toHaveLength(99);
  });

  it('reads the next page after a page of exactly 100 lines, and stops on an empty page', async () => {
    const { runner, calls } = createFakeRunner([ok(page(1, 100)), ok('')]);

    const result = await createGhCliExternalIssueSource(runner).listOpenIssues();

    expect(calls).toHaveLength(2);
    expect(result).toMatchObject({ ok: true, pagesFetched: 2, truncatedByPageLimit: false });
    expect(result.ok && result.issues).toHaveLength(100);
  });

  it('stops at the page limit (3 pages) and says there may be more', async () => {
    const { runner, calls } = createFakeRunner([
      ok(page(1, 100)),
      ok(page(101, 100)),
      ok(page(201, 100)),
      ok(page(301, 100)),
    ]);

    const result = await createGhCliExternalIssueSource(runner).listOpenIssues();

    expect(calls).toHaveLength(3);
    expect(result).toMatchObject({ ok: true, pagesFetched: 3, truncatedByPageLimit: true });
    expect(result.ok && result.issues).toHaveLength(300);
  });

  it('does not report truncation when the last page is short', async () => {
    const { runner } = createFakeRunner([ok(page(1, 100)), ok(page(101, 100)), ok(page(201, 7))]);

    const result = await createGhCliExternalIssueSource(runner).listOpenIssues();

    expect(result).toMatchObject({ ok: true, pagesFetched: 3, truncatedByPageLimit: false });
    expect(result.ok && result.issues).toHaveLength(207);
  });

  it('honours a smaller maxPages', async () => {
    const { runner, calls } = createFakeRunner([ok(page(1, 100)), ok(page(101, 100))]);

    const result = await createGhCliExternalIssueSource(runner, { maxPages: 1 }).listOpenIssues();

    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ ok: true, pagesFetched: 1, truncatedByPageLimit: true });
  });
});

describe('createGhCliExternalIssueSource: reading the lines', () => {
  it('excludes pull requests but still counts them toward the 100-line page size', async () => {
    // 100 行のうち 10 行は PR。PR を除いて 90 件になっても、ページは満杯なので次を読む。
    const prNumbers = Array.from({ length: 10 }, (_, index) => index + 1);
    const { runner, calls } = createFakeRunner([ok(page(1, 100, prNumbers)), ok(page(101, 3))]);

    const result = await createGhCliExternalIssueSource(runner).listOpenIssues();

    expect(calls).toHaveLength(2);
    expect(result.ok && result.issues).toHaveLength(93);
    expect(result.ok && result.issues.some((issue) => prNumbers.includes(issue.number))).toBe(false);
  });

  it('maps the fields and builds the url from the slug and number, not from gh', async () => {
    const line = issueLine(7, {
      title: 'Crash on start',
      body: 'x'.repeat(20_001),
      bodyLength: 54_321,
      updatedAt: '2026-10-04T12:34:56Z',
      author: null,
      authorAssociation: 'FIRST_TIME_CONTRIBUTOR',
      html_url: 'https://evil.example/phish',
      url: 'https://evil.example/api',
    });
    const { runner } = createFakeRunner([ok(`${line}\n`)]);

    const result = await createGhCliExternalIssueSource(runner, { repoSlug: 'owner/repo' }).listOpenIssues();

    expect(result).toEqual({
      ok: true,
      pagesFetched: 1,
      truncatedByPageLimit: false,
      skippedLines: 0,
      issues: [
        {
          number: 7,
          title: 'Crash on start',
          body: 'x'.repeat(20_001),
          bodyLength: 54_321,
          updatedAt: '2026-10-04T12:34:56Z',
          author: null,
          authorAssociation: 'FIRST_TIME_CONTRIBUTOR',
          url: 'https://github.com/owner/repo/issues/7',
        },
      ],
    });
  });

  it('counts lines it cannot read and drops them, keeping the rest', async () => {
    const missingTitle = JSON.stringify({ number: 2, body: '', bodyLength: 0 });
    const stdout = [issueLine(1), 'not json', missingTitle, '', issueLine(3), '[1,2]'].join('\n');
    const { runner } = createFakeRunner([ok(`${stdout}\n`)]);

    const result = await createGhCliExternalIssueSource(runner).listOpenIssues();

    expect(result).toMatchObject({ ok: true, skippedLines: 3 });
    expect(result.ok && result.issues.map((issue) => issue.number)).toEqual([1, 3]);
  });

  it('fails instead of reporting "no issues" when no line is readable', async () => {
    const { runner } = createFakeRunner([ok('<html>not what we asked for</html>\nnot json\n')]);

    const result = await createGhCliExternalIssueSource(runner).listOpenIssues();

    expect(result).toMatchObject({ ok: false, kind: 'failed' });
  });

  it('treats an empty stdout as zero issues', async () => {
    const { runner } = createFakeRunner([ok('')]);

    expect(await createGhCliExternalIssueSource(runner).listOpenIssues()).toEqual({
      ok: true,
      issues: [],
      pagesFetched: 1,
      truncatedByPageLimit: false,
      skippedLines: 0,
    });
  });
});

describe('createGhCliExternalIssueSource: failures', () => {
  it.each<[string, CommandResult, string]>([
    ['gh cannot be spawned', { stdout: '', stderr: '', exitCode: -1, failureKind: 'spawn-failed' }, 'gh-missing'],
    ['gh exits 4', failed('', 4), 'gh-unauthenticated'],
    ['gh says it is not logged in', failed('To get started with GitHub CLI, please run:  gh auth login'), 'gh-unauthenticated'],
    ['gh reports a rate limit', failed('gh: API rate limit exceeded for user ID 1. (HTTP 403)'), 'rate-limited'],
    ['gh reports HTTP 429', failed('gh: HTTP 429'), 'rate-limited'],
    ['gh fails for another reason', failed('gh: Server Error (HTTP 500)'), 'failed'],
    ['gh times out', { stdout: '', stderr: '', exitCode: -1, failureKind: 'timeout' }, 'failed'],
  ])('classifies %s', async (_name, response, kind) => {
    const { runner } = createFakeRunner([response]);

    const result = await createGhCliExternalIssueSource(runner).listOpenIssues();

    expect(result).toMatchObject({ ok: false, kind });
  });

  it('classifies from stderr only: text on stdout never turns a failure into another kind', async () => {
    const { runner } = createFakeRunner([
      { stdout: 'API rate limit exceeded. gh auth login', stderr: 'gh: Server Error (HTTP 500)', exitCode: 1 },
    ]);

    expect(await createGhCliExternalIssueSource(runner).listOpenIssues()).toMatchObject({
      ok: false,
      kind: 'failed',
    });
  });

  it('does not treat a successful page as a failure because its text mentions a rate limit', async () => {
    const line = issueLine(1, { title: 'API rate limit exceeded, please run gh auth login', body: 'HTTP 429' });
    const { runner } = createFakeRunner([ok(`${line}\n`)]);

    expect(await createGhCliExternalIssueSource(runner).listOpenIssues()).toMatchObject({
      ok: true,
      issues: [{ number: 1 }],
    });
  });

  it('returns a failure, not the pages read so far, when a later page fails', async () => {
    const { runner, calls } = createFakeRunner([ok(page(1, 100)), failed('gh: API rate limit exceeded')]);

    const result = await createGhCliExternalIssueSource(runner).listOpenIssues();

    expect(calls).toHaveLength(2);
    expect(result).toMatchObject({ ok: false, kind: 'rate-limited' });
    expect(result).not.toHaveProperty('issues');
  });

  it('returns a failure when the runner throws (it should not, but must not escape)', async () => {
    const rateLimited: CommandRunner = {
      run: () => Promise.reject(new Error('API rate limit exceeded')),
    };
    const broken: CommandRunner = { run: () => Promise.reject(new Error('boom')) };

    expect(await createGhCliExternalIssueSource(rateLimited).listOpenIssues()).toMatchObject({
      ok: false,
      kind: 'rate-limited',
    });
    expect(await createGhCliExternalIssueSource(broken).listOpenIssues()).toMatchObject({
      ok: false,
      kind: 'failed',
    });
  });

  it('keeps detail short and free of control characters', async () => {
    const stderr = `gh: bad\u001b[2J thing\u0007${'x'.repeat(1_000)}`;
    const { runner } = createFakeRunner([failed(stderr)]);

    const result = await createGhCliExternalIssueSource(runner).listOpenIssues();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail.length).toBeLessThanOrEqual(300);
      // eslint-disable-next-line no-control-regex
      expect(/[\u0000-\u001f\u007f-\u009f]/.test(result.detail)).toBe(false);
      expect(result.detail.startsWith('gh: bad [2J thing ')).toBe(true);
    }
  });

  it('gives a fixed message when stderr is empty', async () => {
    const { runner } = createFakeRunner([failed('', 1)]);

    expect(await createGhCliExternalIssueSource(runner).listOpenIssues()).toMatchObject({
      ok: false,
      detail: 'gh command failed',
    });
  });
});

describe('createGhCliExternalIssueSource: no fall back to an unauthenticated route', () => {
  it('only ever runs the gh command and never calls fetch, even when gh is missing or unauthenticated', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const responses: CommandResult[] = [
      { stdout: '', stderr: '', exitCode: -1, failureKind: 'spawn-failed' },
      failed('', 4),
      failed('gh: API rate limit exceeded'),
    ];
    for (const response of responses) {
      const { runner, calls } = createFakeRunner([response]);
      await createGhCliExternalIssueSource(runner, { ghPath: 'gh' }).listOpenIssues();
      expect(calls).toHaveLength(1);
      expect(calls.every((call) => call.command === 'gh')).toBe(true);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
