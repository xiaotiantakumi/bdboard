// Regression test: the composition root must not wire agent runners (v1 is read-only; PLAN.md safety guarantee).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createClaudeResumeRunner } from './claude-resume-runner.js';
import { createClaudeSpawnRunner } from './claude-spawn-runner.js';
import { createDisabledRunner } from './disabled-runner.js';
import { createExperimentalSocketRunner } from './experimental/socket-runner.js';
import type { RunRequest } from '../../application/ports/agent-runner.js';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);

const FORBIDDEN_MAIN_TOKENS = [
  'AgentRunner',
  'AgentRunnerRegistry',
  'dispatchRun',
  'createAgentRunnerRegistry',
  'createDisabledRunner',
  'createClaudeSpawnRunner',
  'createClaudeResumeRunner',
  'createExperimentalSocketRunner',
  'buildClaudeCommand',
  'infrastructure/runners',
  'application/runner',
  'RunRequest',
  'RunOutcome',
] as const;

const ALLOWED_RUNNER_IDENTIFIERS = [
  'NodeCommandRunner',
  'commandRunner',
  // bdboard-l1t.9: 逐次出力用の別ポート。CommandRunner と同じく agent runner
  // (PLAN.md の v1 read-only safety guarantee が禁じる対象)ではなく、
  // 単発コマンドの出力を逐次配信するだけの infrastructure/process 実装。
  'NodeStreamingCommandRunner',
  'streamingCommandRunner',
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

describe('runners are disabled (v1 safety guarantee)', () => {
  it('all infrastructure runners return dispatch-disabled from dispatch()', async () => {
    const runners = [
      createClaudeSpawnRunner(),
      createClaudeResumeRunner(),
      createExperimentalSocketRunner(),
      createDisabledRunner('x'),
    ];

    for (const runner of runners) {
      const outcome = await runner.dispatch(
        makeRequest({
          mode: runner.id.includes('resume') || runner.id.includes('socket')
            ? 'resume'
            : 'spawn',
          sessionId:
            runner.id.includes('resume') || runner.id.includes('socket')
              ? 'sess-1'
              : undefined,
        }),
      );

      expect(outcome.ok, `${runner.id} must not succeed`).toBe(false);
      expect(
        outcome.failureKind,
        `${runner.id} must return dispatch-disabled`,
      ).toBe('dispatch-disabled');
    }
  });

  it('src/main.ts does not wire agent runners', () => {
    const mainPath = path.join(REPO_ROOT, 'src/main.ts');
    const source = readFileSync(mainPath, 'utf8');

    const forbiddenFound = FORBIDDEN_MAIN_TOKENS.filter((token) =>
      source.includes(token),
    );
    expect(
      forbiddenFound,
      `src/main.ts must not wire agent runners (v1 is read-only; PLAN.md safety guarantee). Found: ${forbiddenFound.join(', ')}`,
    ).toEqual([]);

    const runnerIdentifiers = [
      ...source.matchAll(/[A-Za-z]*[Rr]unner[A-Za-z]*/g),
    ].map((match) => match[0]);
    const disallowed = [
      ...new Set(
        runnerIdentifiers.filter(
          (id) => !ALLOWED_RUNNER_IDENTIFIERS.includes(
            id as (typeof ALLOWED_RUNNER_IDENTIFIERS)[number],
          ),
        ),
      ),
    ];

    expect(
      disallowed,
      `src/main.ts must not wire agent runners (v1 is read-only; PLAN.md safety guarantee). Found: ${disallowed.join(', ')}`,
    ).toEqual([]);
  });

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
});
