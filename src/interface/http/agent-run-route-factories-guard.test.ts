// bdboard-3knf: pin both the sole-importer rule and the type-level requirement that
// independently exported route factories need proof the guard was applied.
//
// bdboard-v0df (opus review of #704, 2026-09-24): the original AgentRunGuardToken proved
// only that mountAgentRunGuard() was called *somewhere*, not that it was called on the
// exact app instance the route factories end up mounted onto, or that the mount happens
// at an unprefixed path. Fixed by binding the token to the guarded app instance itself
// (guardedApp() in agent-run-guard.ts) — the factories now register their handlers
// directly onto that instance and return void, rather than returning an independently
// mountable Hono of their own (returning the same instance back was itself a footgun: a
// caller doing `app.route('/', createAgentRunCreateRoutes(...))` would self-mount `app`
// onto `app`, silently double-registering every route). This file pins the binding at
// runtime (a token minted for one app only ever lets a caller reach that same app via
// guardedApp(), and the guard travels with the routes even if that app is re-mounted
// elsewhere) in addition to the pre-existing compile-time checks.
//
// bdboard-f9x8 (opus review of #704, 2026-09-24): the original sole-importer check had
// several gaps:
//   - it only walked .ts files (missing .tsx/.mts/.cts, which tsconfig.json's
//     `include: ["src/**/*"]` would still pick up);
//   - the three route-factory checks matched by export-name substring across the whole
//     file, missing e.g. `import * as m from './agent-run-create-routes.js'` followed by
//     computed/dynamic access that never spells the factory name literally — fixed by
//     matching on import *specifier* instead (does any other file import from this exact
//     module at all — each factory file's only meaningful production export is the
//     factory itself, so any import from it outside agent-run-routes.ts is suspicious
//     regardless of which name gets bound, and this naturally also catches
//     namespace/aliased imports);
//   - mountAgentRunGuard wasn't checked at all, and a first attempt at that check (an
//     identifier-substring grep, guarded by a hand-rolled comment-stripper so the
//     identifier's own doc comments didn't self-trigger it) turned out to have two of its
//     own bugs on independent review: the comment-stripper's block-comment regex doesn't
//     understand string literals, so a string like `'/api/runs/*'` (which appears
//     literally in agent-run-guard.ts) gets misread as the start of a `/* */` comment and
//     silently deletes real code before the identifier scan ever runs; and an
//     identifier-substring check is namespace-evadable the same way the original
//     export-name check was (`import * as g from './agent-run-guard.js'; g['mount' +
//     'AgentRunGuard'](...)` never spells the identifier). Both are fixed the same way:
//     drop identifier/comment-based matching entirely and check by import *specifier*
//     instead — agent-run-guard.ts's only legitimate production importers are the
//     composition root and the three route factories (AGENT_RUN_GUARD_ALLOWED_IMPORTERS
//     below, confirmed against the current import graph), so any other production file
//     importing anything at all from it, for any reason, under any local binding name, is
//     suspicious.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createRunStore } from '../../application/runner/run-store.js';
import { createAgentRunnerRegistry } from '../../application/runner/runner-registry.js';
import { mountAgentRunGuard, guardedApp, type AgentRunGuardToken } from './agent-run-guard.js';
import { createAgentRunCancelRoutes } from './agent-run-cancel-routes.js';
import { createAgentRunCreateRoutes } from './agent-run-create-routes.js';
import { createAgentRunReadRoutes } from './agent-run-read-routes.js';
import { createFakeBoardCache } from './agent-run-routes-test-support/board-cache.js';
import { LOCAL_ENV } from './agent-run-routes-test-support/constants.js';
import { withRemoteTunnel } from './agent-run-routes-test-support/http-requests.js';
import { allowingWriteAccess, makeIssueWriter, makeProvisioner } from './agent-run-routes-test-support/run-deps.js';
import { readyHarnessStatus } from './agent-run-routes-test-support/harness-status.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SRC_DIR = path.join(REPO_ROOT, 'src');
const SOLE_IMPORTER = 'src/interface/http/agent-run-routes.ts';
const AGENT_RUN_GUARD_DEFINITION_FILE = 'src/interface/http/agent-run-guard.ts';

// bdboard-f9x8: agent-run-guard.ts's only legitimate production importers, confirmed
// against the current import graph — the composition root (which calls
// mountAgentRunGuard()) and the three route factories (which call guardedApp()).
const AGENT_RUN_GUARD_ALLOWED_IMPORTERS = [
  'src/interface/http/agent-run-cancel-routes.ts',
  'src/interface/http/agent-run-create-routes.ts',
  'src/interface/http/agent-run-read-routes.ts',
  SOLE_IMPORTER,
].sort();

// bdboard-f9x8: widened from .ts-only so a future .tsx/.mts/.cts importer under src/
// (all valid per tsconfig.json's `include: ["src/**/*"]`) doesn't silently escape the scan.
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'] as const;
const TEST_FILE_SUFFIXES = ['.test.ts', '.test.tsx', '.test.mts', '.test.cts'] as const;

function isProductionSourceFile(name: string): boolean {
  return (
    SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext)) &&
    !TEST_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix))
  );
}

function collectSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const fullPath = path.join(dir, entry);
    return statSync(fullPath).isDirectory()
      ? collectSourceFiles(fullPath)
      : isProductionSourceFile(entry)
        ? [fullPath]
        : [];
  });
}

function toPosixRelative(absolutePath: string): string {
  return path.relative(REPO_ROOT, absolutePath).split(path.sep).join('/');
}

const PRODUCTION_SOURCE_FILES = collectSourceFiles(SRC_DIR).map(toPosixRelative);

function readSource(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

/**
 * bdboard-f9x8: sole-caller check for a module by import *specifier*, matched against the
 * raw (unstripped) source. `moduleStemPattern` must match the module's filename with its
 * extension stripped (e.g. `agent-run-create-routes`) so it can't accidentally match a
 * differently-named sibling module (e.g. an `agent-run-create-routes-test-support`
 * directory) — the pattern requires an optional `.js` and then the closing quote to
 * follow immediately, so a longer stem like `agent-run-create-routes-test-support` can
 * never satisfy it. Matching on the raw source (rather than a comment-stripped copy) is a
 * deliberate simplification versus the identifier-based check this replaces: a production
 * file would need a comment containing a literal `from '...agent-run-guard...'`-shaped
 * string for that to false-positive here, which is not a pattern used anywhere in this
 * codebase today.
 */
function findModuleSpecifierImporters(moduleStemPattern: string, definitionFile: string): string[] {
  const specifierPattern = new RegExp(String.raw`from\s+['"][^'"]*${moduleStemPattern}(\.js)?['"]`);
  return PRODUCTION_SOURCE_FILES.filter((relativePath) => relativePath !== definitionFile)
    .filter((relativePath) => specifierPattern.test(readSource(relativePath)))
    .sort();
}

const FACTORY_MODULES = [
  {
    factoryName: 'createAgentRunCreateRoutes',
    moduleStemPattern: 'agent-run-create-routes',
    definitionFile: 'src/interface/http/agent-run-create-routes.ts',
  },
  {
    factoryName: 'createAgentRunReadRoutes',
    moduleStemPattern: 'agent-run-read-routes',
    definitionFile: 'src/interface/http/agent-run-read-routes.ts',
  },
  {
    factoryName: 'createAgentRunCancelRoutes',
    moduleStemPattern: 'agent-run-cancel-routes',
    definitionFile: 'src/interface/http/agent-run-cancel-routes.ts',
  },
] as const;

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
  describe('sole-importer checks (bdboard-f9x8)', () => {
    for (const { factoryName, moduleStemPattern, definitionFile } of FACTORY_MODULES) {
      it(`${factoryName}'s module is imported (by specifier) only by ${SOLE_IMPORTER}`, () => {
        expect(findModuleSpecifierImporters(moduleStemPattern, definitionFile)).toEqual([
          SOLE_IMPORTER,
        ]);
      });
    }

    it('agent-run-guard.ts is imported (by specifier) only by its known allowlist', () => {
      expect(
        findModuleSpecifierImporters('agent-run-guard', AGENT_RUN_GUARD_DEFINITION_FILE),
      ).toEqual(AGENT_RUN_GUARD_ALLOWED_IMPORTERS);
    });
  });

  describe('the guard token is bound to the exact guarded app instance (bdboard-v0df)', () => {
    it('guardedApp() returns the same instance mountAgentRunGuard() was applied to, not a copy', () => {
      const app = new Hono();
      const token: AgentRunGuardToken = mountAgentRunGuard(app, {
        isRemoteAgentRunAllowed: async () => true,
      });
      expect(guardedApp(token)).toBe(app);
    });

    it('each route factory registers its handlers directly on the guarded app instance reachable via guardedApp(), rather than building an independently mountable Hono of its own', () => {
      const app = new Hono();
      const token = mountAgentRunGuard(app, { isRemoteAgentRunAllowed: async () => true });
      const runStore = buildRunStore();
      const deps = buildCreateAndReadDeps(runStore);

      // The factories return void (bdboard-v0df finding #6) — a caller has no return
      // value to mount elsewhere, only guardedApp(token), which always resolves to `app`.
      expect(createAgentRunCreateRoutes(deps, token)).toBeUndefined();
      expect(createAgentRunReadRoutes(deps, token)).toBeUndefined();
      expect(createAgentRunCancelRoutes({ runStore }, token)).toBeUndefined();
      expect(guardedApp(token)).toBe(app);
    });

    it('a token minted for one app cannot be used to register guarded routes on a different, untrusted app (the exploit bdboard-v0df was filed against)', async () => {
      // Mirrors the PoC in the ticket: mount the guard on a "real" app with remote runs
      // denied, then try to smuggle the routes onto a second, unguarded parent under an
      // unrelated path prefix ('/v2') that the guard's own '/api/runs' + '/api/runs/*'
      // patterns don't literally spell out. The factory has no return value to redirect —
      // the only way to reach an app at all is guardedApp(token), which always hands back
      // the *original* guarded app, and the guard is part of that app's own routing table,
      // so re-mounting it elsewhere carries the guard along instead of leaving it behind.
      const guardedInstance = new Hono();
      const token = mountAgentRunGuard(guardedInstance, {
        writeAccess: allowingWriteAccess(),
        isRemoteAgentRunAllowed: async () => false,
      });
      const runStore = buildRunStore();
      runStore.start({
        id: 'run-active',
        ticketId: 'bdboard-active',
        runner: 'claude-spawn',
        mode: 'spawn',
        cwd: '/tmp/active',
      });

      createAgentRunCancelRoutes({ runStore }, token);
      const reachableApp = guardedApp(token);
      expect(reachableApp).toBe(guardedInstance);

      const untrustedParent = new Hono();
      untrustedParent.route('/v2', reachableApp);

      const response = await untrustedParent.request(
        '/v2/api/runs/run-active/cancel',
        withRemoteTunnel({ method: 'POST' }),
        LOCAL_ENV,
      );

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'remote agent runs are disabled' });
    });
  });

  describe('compile-time enforcement', () => {
    // The @ts-expect-error directives below are only checked by `tsc --noEmit` (vitest's
    // esbuild transform doesn't type-check), so `npm run verify` / `npm run build` must
    // catch a stale or missing directive here — the runtime .toThrow() assertions alone
    // only prove that a bypassed call fails at runtime, not that TypeScript still rejects
    // it at compile time.
    it('rejects a missing guard token at compile time, and throws if bypassed at runtime (createAgentRunCreateRoutes)', () => {
      const deps = buildCreateAndReadDeps(buildRunStore());
      expect(() => {
        // @ts-expect-error -- the guard token is a required second argument.
        createAgentRunCreateRoutes(deps);
      }).toThrow();
    });

    it('rejects a missing guard token at compile time, and throws if bypassed at runtime (createAgentRunReadRoutes)', () => {
      const deps = buildCreateAndReadDeps(buildRunStore());
      expect(() => {
        // @ts-expect-error -- the guard token is a required second argument.
        createAgentRunReadRoutes(deps);
      }).toThrow();
    });

    it('rejects a missing guard token at compile time, and throws if bypassed at runtime (createAgentRunCancelRoutes)', () => {
      const runStore = buildRunStore();
      expect(() => {
        // @ts-expect-error -- the guard token is a required second argument.
        createAgentRunCancelRoutes({ runStore });
      }).toThrow();
    });

    it('rejects a hand-written object as an AgentRunGuardToken at compile time, and throws if bypassed at runtime', () => {
      const runStore = buildRunStore();
      expect(() => {
        // @ts-expect-error -- the token brand uses an unexported unique symbol.
        createAgentRunCancelRoutes({ runStore }, {});
      }).toThrow();
    });
  });
});
