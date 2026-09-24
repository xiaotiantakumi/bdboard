// bdboard-3knf: pin both the sole-importer rule and the type-level requirement that
// independently exported route factories need proof the guard was applied.
//
// Scope note (opus review, 2026-09-24): this file pins two things — (1) each factory
// is imported by exactly one file (agent-run-routes.ts), by source-grep, matching the
// RUNNER_REFERENCE_ALLOWLIST_FILES style guard in runner-reachability.test.ts; (2) the
// compile-time proof itself, via @ts-expect-error assertions for all three factories
// (checked by `tsc --noEmit`, part of `npm run build`/`npm run verify`, not by vitest's
// esbuild transform — a regression here only surfaces when the full verify chain runs).
// It deliberately does NOT claim the token is bound to the specific app it guarded —
// see the scope note next to AGENT_RUN_GUARD_APPLIED in agent-run-guard.ts for that
// residual gap and the follow-up ticket tracking it.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createRunStore } from '../../application/runner/run-store.js';
import { createAgentRunnerRegistry } from '../../application/runner/runner-registry.js';
import { mountAgentRunGuard, type AgentRunGuardToken } from './agent-run-guard.js';
import { createAgentRunCancelRoutes } from './agent-run-cancel-routes.js';
import { createAgentRunCreateRoutes } from './agent-run-create-routes.js';
import { createAgentRunReadRoutes } from './agent-run-read-routes.js';
import { createFakeBoardCache } from './agent-run-routes-test-support/board-cache.js';
import { makeIssueWriter, makeProvisioner } from './agent-run-routes-test-support/run-deps.js';
import { readyHarnessStatus } from './agent-run-routes-test-support/harness-status.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SRC_DIR = path.join(REPO_ROOT, 'src');
const SOLE_IMPORTER = 'src/interface/http/agent-run-routes.ts';
const FACTORY_DEFINITION_FILES = {
  createAgentRunCreateRoutes: 'src/interface/http/agent-run-create-routes.ts',
  createAgentRunReadRoutes: 'src/interface/http/agent-run-read-routes.ts',
  createAgentRunCancelRoutes: 'src/interface/http/agent-run-cancel-routes.ts',
} as const;

function collectSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const fullPath = path.join(dir, entry);
    return statSync(fullPath).isDirectory()
      ? collectSourceFiles(fullPath)
      : entry.endsWith('.ts') && !entry.endsWith('.test.ts') ? [fullPath] : [];
  });
}

function toPosixRelative(absolutePath: string): string {
  return path.relative(REPO_ROOT, absolutePath).split(path.sep).join('/');
}

function buildRunStore() {
  return createRunStore({ now: () => new Date('2026-01-01T00:00:00Z') });
}

function buildCreateAndReadDeps(runStore: ReturnType<typeof buildRunStore>) {
  return {
    cache: createFakeBoardCache(),
    registry: createAgentRunnerRegistry(),
    runStore,
    worktreeProvisioner: makeProvisioner(),
    normalizePath: (value: string) => value,
    getHarnessStatus: async () => readyHarnessStatus(),
    issueWriter: makeIssueWriter(),
    now: () => new Date('2026-01-01T00:00:00Z'),
  };
}

describe('agent-run route factories stay behind the guard (bdboard-3knf)', () => {
  for (const [factoryName, definitionFile] of Object.entries(FACTORY_DEFINITION_FILES)) {
    it(`${factoryName} is imported only by ${SOLE_IMPORTER}`, () => {
      const references = collectSourceFiles(SRC_DIR)
        .filter((file) => readFileSync(file, 'utf8').includes(factoryName))
        .map(toPosixRelative)
        .sort();
      expect(references).toEqual([definitionFile, SOLE_IMPORTER].sort());
    });
  }

  it('mounting the guard on an app and threading the token through every factory produces real Hono apps', () => {
    const app = new Hono();
    const token: AgentRunGuardToken = mountAgentRunGuard(app, {
      isRemoteAgentRunAllowed: async () => true,
    });
    expect(token).toBeDefined();
    const runStore = buildRunStore();
    const deps = buildCreateAndReadDeps(runStore);
    expect(createAgentRunCreateRoutes(deps, token)).toBeInstanceOf(Hono);
    expect(createAgentRunReadRoutes(deps, token)).toBeInstanceOf(Hono);
    expect(createAgentRunCancelRoutes({ runStore }, token)).toBeInstanceOf(Hono);
  });

  it('rejects a missing guard token at compile time (createAgentRunCreateRoutes)', () => {
    const deps = buildCreateAndReadDeps(buildRunStore());
    // @ts-expect-error -- the guard token is a required second argument.
    createAgentRunCreateRoutes(deps);
  });

  it('rejects a missing guard token at compile time (createAgentRunReadRoutes)', () => {
    const deps = buildCreateAndReadDeps(buildRunStore());
    // @ts-expect-error -- the guard token is a required second argument.
    createAgentRunReadRoutes(deps);
  });

  it('rejects a missing guard token at compile time (createAgentRunCancelRoutes)', () => {
    const runStore = buildRunStore();
    // @ts-expect-error -- the guard token is a required second argument.
    createAgentRunCancelRoutes({ runStore });
  });

  it('rejects a hand-written object as an AgentRunGuardToken at compile time', () => {
    const runStore = buildRunStore();
    // @ts-expect-error -- the token brand uses an unexported unique symbol.
    createAgentRunCancelRoutes({ runStore }, {});
  });
});
