// Regression test: agent runs are reachable only through a single HTTP path that always
// passes agent-run-guard. The v1 read-only guarantee (no runner wiring) was withdrawn;
// this file replaces runners-are-disabled.test.ts with single-path + mandatory-gate checks.
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, afterEach } from 'vitest';
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
  'src/main.ts',
  'src/application/ports/agent-runner.ts',
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
  const tempConfigDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempConfigDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTempClaudeConfigDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'bdboard-claude-config-'));
    tempConfigDirs.push(dir);
    return dir;
  }

  it('only allowlisted src files may reference runner dispatch paths (interface/http entry is agent-run-routes.ts)', () => {
    const violations: Array<{ file: string; tokens: readonly string[] }> = [];

    for (const file of collectSourceFiles(SRC_DIR)) {
      const relativePath = path.relative(REPO_ROOT, file);
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
            violations.push(`${path.relative(REPO_ROOT, file)}: ${pattern}`);
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
    const claudeConfigDir = makeTempClaudeConfigDir();
    const cases = [
      { runner: createDisabledRunner('disabled-test'), request: makeRequest() },
      {
        runner: createClaudeSpawnRunner({ claudeConfigDir }),
        request: makeRequest(),
      },
      {
        runner: createClaudeResumeRunner({ claudeConfigDir }),
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
