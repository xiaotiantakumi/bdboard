// bdboard-3knf: pin both the sole-importer rule and the type-level requirement that
// independently exported route factories need proof the guard was applied.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createRunStore } from '../../application/runner/run-store.js';
import { mountAgentRunGuard, type AgentRunGuardToken } from './agent-run-guard.js';
import { createAgentRunCancelRoutes } from './agent-run-cancel-routes.js';
import { createAgentRunCreateRoutes } from './agent-run-create-routes.js';
import { createAgentRunReadRoutes } from './agent-run-read-routes.js';
import { makeRoutes } from './agent-run-routes-test-support/routes.js';
import { createFakeBoardCache } from './agent-run-routes-test-support/board-cache.js';
import { makeIssueWriter, makeProvisioner } from './agent-run-routes-test-support/run-deps.js';
import { readyHarnessStatus } from './agent-run-routes-test-support/harness-status.js';
import { createAgentRunnerRegistry } from '../../application/runner/runner-registry.js';

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

  it('mounts the guard and passes the resulting token to every route factory', () => {
    const { app, runStore } = makeRoutes();
    const token: AgentRunGuardToken = mountAgentRunGuard(new Hono(), {
      isRemoteAgentRunAllowed: async () => true,
    });
    expect(token).toBeDefined();
    const deps = {
      cache: createFakeBoardCache(),
      registry: createAgentRunnerRegistry(),
      runStore,
      worktreeProvisioner: makeProvisioner(),
      normalizePath: (value: string) => value,
      getHarnessStatus: async () => readyHarnessStatus(),
      issueWriter: makeIssueWriter(),
      now: () => new Date('2026-01-01T00:00:00Z'),
    };
    expect(createAgentRunCreateRoutes(deps, token)).toBeInstanceOf(Hono);
    expect(createAgentRunReadRoutes(deps, token)).toBeInstanceOf(Hono);
    expect(createAgentRunCancelRoutes({ runStore }, token)).toBeInstanceOf(Hono);
    expect(app).toBeInstanceOf(Hono);
  });

  it('rejects a missing guard token at compile time', () => {
    const runStore = createRunStore({ now: () => new Date() });
    // @ts-expect-error -- the guard token is a required second argument.
    createAgentRunCancelRoutes({ runStore });
  });

  it('rejects a hand-written object as an AgentRunGuardToken at compile time', () => {
    const runStore = createRunStore({ now: () => new Date() });
    // @ts-expect-error -- the token brand uses an unexported unique symbol.
    createAgentRunCancelRoutes({ runStore }, {});
  });
});
