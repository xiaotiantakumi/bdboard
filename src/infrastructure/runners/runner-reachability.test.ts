// Regression test: agent runs are reachable only through a single HTTP path that always
// passes agent-run-guard. The v1 read-only guarantee (no runner wiring) was withdrawn;
// this file replaces runners-are-disabled.test.ts with single-path + mandatory-gate checks.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveAllowRemoteAgentRuns } from '../../domain/agent-run-policy.js';
import { createClaudeResumeRunner } from './claude-resume-runner.js';
import { createClaudeSpawnRunner } from './claude-spawn-runner.js';
import { createDisabledRunner } from './disabled-runner.js';
import { createExperimentalSocketRunner } from './experimental/socket-runner.js';
import type { RunRequest } from '../../application/ports/agent-runner.js';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);

const SRC_DIR = path.join(REPO_ROOT, 'src');

const RUNNER_REFERENCE_TOKENS = [
  'dispatchRun',
  'application/runner',
  'infrastructure/runners',
  'AgentRunner',
  '.dispatch(',
] as const;

const RUNNER_REFERENCE_ALLOWLIST_FILES = [
  'src/interface/http/agent-run-routes.ts',
  // bdboard-sso1.27: agent-run-routes.ts (旧672行) はルート別の登録関数
  // (agent-run-create-routes.ts / agent-run-read-routes.ts /
  // agent-run-cancel-routes.ts) と共有ヘルパー (agent-run-shared.ts /
  // agent-run-dispatch-outcome.ts / agent-run-provision.ts) へ分割済み (move
  // only)。分割後もこれらは createAgentRunRoutes(agent-run-routes.ts) からのみ
  // マウントされる唯一の HTTP エントリの内側にとどまり、その手前で
  // agentRunGuard/agentRunBodyLimit/rateLimit が適用される「単一の守られた経路」
  // という不変条件は変わらない。分割前は 1 ファイルで足りていた許可リストを、
  // 分割後のファイル群へそのまま引き継ぐ。
  'src/interface/http/agent-run-create-routes.ts',
  'src/interface/http/agent-run-read-routes.ts',
  'src/interface/http/agent-run-cancel-routes.ts',
  'src/interface/http/agent-run-shared.ts',
  'src/interface/http/agent-run-dispatch-outcome.ts',
  'src/interface/http/agent-run-provision.ts',
  // bdboard-sso1.14: main.ts のエージェント実行 (agent-run) 領域配線は
  // src/bootstrap/wire-agent-run.ts へ切り出し済み (move only) で、main.ts 自体は
  // もう RUNNER_REFERENCE_TOKENS のどれも参照しない。許可リストを main.ts から
  // wire-agent-run.ts へ移し、ガードを緩めたままにしない。
  'src/bootstrap/wire-agent-run.ts',
  'src/application/ports/agent-runner.ts',
  // bdboard-sso1.36: agent-run-routes.test.ts (2007行) の move-only 分割で、
  // 複数のテストファイルから共有されるフェイク/ヘルパー置き場として
  // agent-run-routes-test-support.ts を新設した。中身は createRunStore /
  // createAgentRunnerRegistry のフェイクや AgentRunner 型を使うテスト用
  // フィクスチャのみで、実行時の dispatch 経路には一切関わらない。`.test.ts`
  // 拡張子ではないため collectSourceFiles のスキャン対象になるが、実体は
  // *.test.ts と同じテスト専用コードなのでここに明示的に許可する。
  'src/interface/http/agent-run-routes-test-support.ts',
] as const;

const RUNNER_REFERENCE_ALLOWLIST_PREFIXES = [
  'src/application/runner/',
  'src/infrastructure/runners/',
] as const;

const FORBIDDEN_SOURCE_PATTERNS = [
  'child_process',
  'node:child_process',
  'node:net',
  'spawn(',
  'execFile(',
] as const;

function makeRequest(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    ticketId: 'bd-1',
    projectId: 'proj-1',
    cwd: '/tmp/project',
    mode: 'spawn',
    ...overrides,
  };
}

function collectSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
      continue;
    }

    if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * リポジトリ相対パスを常に `/` 区切りで返す。
 *
 * `path.relative` は Windows で `src\application\runner\dispatch-run.ts` のように
 * `\` 区切りを返すため、`/` 区切りで書かれた allowlist と一致せず、正常な
 * ソースが丸ごと違反として報告される (verify-windows で実測。2026-09-04,
 * bdboard-54be.1)。allowlist の照合も違反メッセージも POSIX 形に揃える。
 */
function toPosixRelative(absolutePath: string): string {
  return path.relative(REPO_ROOT, absolutePath).split(path.sep).join('/');
}

function matchingRunnerReferenceTokens(source: string): string[] {
  return RUNNER_REFERENCE_TOKENS.filter((token) => source.includes(token));
}

function isRunnerReferenceAllowlisted(relativePath: string): boolean {
  if (
    RUNNER_REFERENCE_ALLOWLIST_FILES.includes(
      relativePath as (typeof RUNNER_REFERENCE_ALLOWLIST_FILES)[number],
    )
  ) {
    return true;
  }

  return RUNNER_REFERENCE_ALLOWLIST_PREFIXES.some((prefix) =>
    relativePath.startsWith(prefix),
  );
}

describe('runner reachability (single guarded path)', () => {
  it('only allowlisted src files may reference runner dispatch paths (interface/http entry is agent-run-routes.ts)', () => {
    const violations: Array<{ file: string; tokens: readonly string[] }> = [];

    for (const file of collectSourceFiles(SRC_DIR)) {
      const relativePath = toPosixRelative(file);
      if (isRunnerReferenceAllowlisted(relativePath)) {
        continue;
      }

      const hitTokens = matchingRunnerReferenceTokens(readFileSync(file, 'utf8'));
      if (hitTokens.length > 0) {
        violations.push({ file: relativePath, tokens: hitTokens });
      }
    }

    expect(
      violations,
      violations.length > 0
        ? `runner references outside allowlist: ${violations
            .map(({ file, tokens }) => `${file} (${tokens.join(', ')})`)
            .join('; ')}`
        : 'runner references must stay on the single guarded HTTP path',
    ).toEqual([]);
  });

  // main.ts の createAgentRunRoutes 配線を固定長スライス + 文字列包含で見るテストは削除した
  // (bdboard-54be.1)。`isRemoteAgentRunAllowed: async () => true` のような危険な配線でも緑になり、
  // 回帰を捕まえられなかった。実効的なゲート検証は agent-run-routes.test.ts の
  // 「blocks all /api/runs routes for remote requests when remote agent runs are disabled」
  // （全登録ルートが 403 を返す振る舞いテスト）が担い、main.ts の配線漏れは同ファイル冒頭の
  // ソース全体トークンスキャンが担う。誤った安心感を与えるだけなので削除。

  it('runner source files do not import process-launch primitives', () => {
    const dirs = [
      path.join(REPO_ROOT, 'src/application/runner'),
      path.join(REPO_ROOT, 'src/infrastructure/runners'),
    ];

    const violations: string[] = [];

    for (const dir of dirs) {
      for (const file of collectSourceFiles(dir)) {
        const source = readFileSync(file, 'utf8');
        for (const pattern of FORBIDDEN_SOURCE_PATTERNS) {
          if (source.includes(pattern)) {
            violations.push(`${toPosixRelative(file)}: ${pattern}`);
          }
        }
      }
    }

    expect(
      violations,
      `runner sources must not launch processes. Violations: ${violations.join('; ')}`,
    ).toEqual([]);
  });

  it('resolveAllowRemoteAgentRuns defaults to false when config is undefined', () => {
    expect(resolveAllowRemoteAgentRuns(undefined)).toBe(false);
  });

  it('createDisabledRunner and claude runner without streamingRunner return dispatch-disabled', async () => {
    const cases = [
      { runner: createDisabledRunner('disabled-test'), request: makeRequest() },
      {
        runner: createClaudeSpawnRunner(),
        request: makeRequest(),
      },
      {
        runner: createClaudeResumeRunner(),
        request: makeRequest({ mode: 'resume', sessionId: 'sess-1' }),
      },
      {
        runner: createExperimentalSocketRunner(),
        request: makeRequest({ mode: 'spawn' }),
      },
    ] as const;

    for (const { runner, request } of cases) {
      const outcome = await runner.dispatch(request);

      expect(outcome.ok, `${runner.id} must not succeed`).toBe(false);
      expect(
        outcome.failureKind,
        `${runner.id} must return dispatch-disabled`,
      ).toBe('dispatch-disabled');
    }
  });
});
