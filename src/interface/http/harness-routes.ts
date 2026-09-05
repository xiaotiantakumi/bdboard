import { Hono } from 'hono';
import { z } from 'zod';
import { parseJsonBody } from './request-body.js';
import { getAllProjectsHarnessStatus } from '../../application/harness/get-all-projects-harness-status.js';
import {
  getProjectHarnessStatus,
  readProjectHarnessStatus,
  resolveProjectContractState,
} from '../../application/harness/get-project-harness-status.js';
import { injectHarnessPack } from '../../application/harness/inject-harness-pack.js';
import type { BoardCache } from '../../application/ports/board-cache.js';
import type { HarnessContractReaderPort } from '../../application/ports/harness-contract-reader.js';
import type { HarnessInjectorPort } from '../../application/ports/harness-injector.js';
import type { PackRegistryPort } from '../../application/ports/pack-registry.js';
import type { ContractState } from '../../domain/harness-contract.js';
import type { ProjectHarnessStatus } from '../../domain/harness-pack.js';
import {
  createWriteGuardMiddleware,
  type WriteGuardDeps,
} from './write-guard.js';

export interface HarnessRoutesDeps {
  readonly cache: BoardCache;
  readonly registry: PackRegistryPort;
  readonly injector: HarnessInjectorPort;
  readonly contractReader: HarnessContractReaderPort;
  readonly now?: () => Date;
  readonly writeAccess?: WriteGuardDeps;
}

const injectBodySchema = z.object({
  pack: z.string().min(1).max(200),
});

function decodeProjectIdParam(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function extractProjectIdFromHarnessPath(reqPath: string): string | undefined {
  const prefix = '/api/projects/';
  const harnessSuffix = '/harness';
  const injectSuffix = '/harness/inject';

  if (reqPath.endsWith(injectSuffix)) {
    const encoded = reqPath.slice(prefix.length, reqPath.length - injectSuffix.length);
    return encoded.length > 0 ? decodeProjectIdParam(encoded) : undefined;
  }

  if (reqPath.endsWith(harnessSuffix)) {
    const encoded = reqPath.slice(prefix.length, reqPath.length - harnessSuffix.length);
    return encoded.length > 0 ? decodeProjectIdParam(encoded) : undefined;
  }

  return undefined;
}

/**
 * ContractState をそのまま JSON に落とす。状態ごとに明示的に書き出すのは、
 * ドメイン側に内部向けフィールドが増えたときに黙って API へ漏れないようにするため。
 */
function toContractJson(contract: ContractState): Record<string, unknown> {
  switch (contract.state) {
    case 'ok':
      return {
        state: 'ok',
        verify: contract.verify,
        prFlow: contract.prFlow,
        mainBranch: contract.mainBranch,
        // 候補列そのものではなく要約 (工程名と段数) だけ。UI は段数しか使わず、
        // 注入先由来の文字列を API へ広げる理由が無い。
        models:
          contract.models === null
            ? null
            : contract.models.map((stage) => ({
                stage: stage.stage,
                tiers: stage.tiers,
              })),
      };
    case 'invalid':
      return { state: 'invalid', message: contract.message };
    case 'command-missing':
      return {
        state: 'command-missing',
        script: contract.script,
        verify: contract.verify,
      };
    case 'missing':
    case 'not-applicable':
      return { state: contract.state };
  }
}

function toHarnessStatusJson(status: ProjectHarnessStatus): Record<string, unknown> {
  return {
    packs: status.packs.map((entry) => ({
      name: entry.name,
      availableVersion: entry.availableVersion,
      installedVersion: entry.installedVersion,
      drift: entry.drift,
      hooksState: entry.hooksState,
      missingHooks: entry.missingHooks,
    })),
    contract: toContractJson(status.contract),
  };
}

async function resolveProjectHarnessStatus(
  deps: HarnessRoutesDeps,
  projectId: string,
): Promise<ProjectHarnessStatus | 'project-not-found'> {
  const cached = deps.cache.getProject(projectId);
  if (cached === undefined) {
    return 'project-not-found';
  }

  return readProjectHarnessStatus(deps, cached.project.rootPath);
}

export function createHarnessRoutes(deps: HarnessRoutesDeps): Hono {
  const app = new Hono();
  const now = deps.now ?? (() => new Date());

  app.use('*', createWriteGuardMiddleware(deps.writeAccess ?? {}));

  app.get('/api/harness/packs', async (c) => {
    const packs = await deps.registry.listPacks();
    return c.json(
      packs.map((pack) => ({
        name: pack.name,
        version: pack.version,
        description: pack.description,
      })),
    );
  });

  app.get('/api/harness/status', async (c) => {
    const projects = deps.cache.listProjects().map((entry) => entry.project);
    const statuses = await getAllProjectsHarnessStatus({
      registry: deps.registry,
      injector: deps.injector,
      contractReader: deps.contractReader,
      projects,
    });

    return c.json({
      projects: statuses.map(({ projectId, status }) => ({
        projectId,
        ...toHarnessStatusJson(status),
      })),
    });
  });

  app.get('/api/projects/*/harness', async (c) => {
    const projectId = extractProjectIdFromHarnessPath(c.req.path);
    if (projectId === undefined) {
      return c.notFound();
    }

    const status = await resolveProjectHarnessStatus(deps, projectId);
    if (status === 'project-not-found') {
      return c.json({ error: 'project not found' }, 404);
    }

    return c.json(toHarnessStatusJson(status));
  });

  app.post('/api/projects/*/harness/inject', async (c) => {
    const projectId = extractProjectIdFromHarnessPath(c.req.path);
    if (projectId === undefined) {
      return c.notFound();
    }

    const cached = deps.cache.getProject(projectId);
    if (cached === undefined) {
      return c.json({ error: 'project not found' }, 404);
    }

    const parsed = await parseJsonBody(c, injectBodySchema, {
      includeValidationDetails: true,
    });
    if (!parsed.ok) return parsed.response;

    const result = await injectHarnessPack(
      {
        registry: deps.registry,
        injector: deps.injector,
        now,
      },
      cached.project.rootPath,
      parsed.data.pack,
    );

    if (!result.ok) {
      if (result.failure.kind === 'pack-not-found') {
        return c.json({ error: 'pack not found' }, 404);
      }
      return c.json({ error: 'injection failed', detail: result.failure.detail }, 500);
    }

    // 注入は成功しているので、コントラクト評価の結果でレスポンスを止めない。
    // 「注入したがこのプロジェクトには検証ループが宣言されていない」を、注入直後に
    // その場で返すのがここの狙い (bdboard-pkr6.3)。
    const [contract, settingsJson] = await Promise.all([
      resolveProjectContractState(
        deps.contractReader,
        cached.project.rootPath,
        result.manifest,
      ),
      deps.injector.readSettings(cached.project.rootPath),
    ]);
    const status = await getProjectHarnessStatus(
      deps.registry,
      result.manifest,
      contract,
      settingsJson,
    );
    return c.json(toHarnessStatusJson(status));
  });

  return app;
}
