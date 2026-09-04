import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseJsonBody } from './request-body.js';
import type { AgentRunConfigPort } from '../../application/ports/agent-run-config.js';
import {
  DEFAULT_ALLOW_REMOTE_AGENT_RUNS,
  resolveAllowRemoteAgentRuns,
} from '../../domain/agent-run-policy.js';
import { isLocalBasicAuthRequest } from './local-request.js';
import {
  createWriteGuardMiddleware,
  type WriteGuardDeps,
} from './write-guard.js';

export interface AgentRunSettingsRoutesDeps {
  readonly store: AgentRunConfigPort;
  readonly writeAccess?: WriteGuardDeps;
}

const agentRunBodySchema = z.object({
  allowRemoteAgentRuns: z.boolean(),
  version: z.string().min(1).max(256),
});

export function computeAgentRunVersion(
  config: Awaited<ReturnType<AgentRunConfigPort['read']>>,
): string {
  const normalized = config ?? {};
  return createHash('sha256')
    .update(JSON.stringify({ allowRemoteAgentRuns: normalized.allowRemoteAgentRuns }))
    .digest('hex');
}

function toEffectiveDto(config: Awaited<ReturnType<AgentRunConfigPort['read']>>) {
  return {
    allowRemoteAgentRuns: resolveAllowRemoteAgentRuns(config),
    defaults: { allowRemoteAgentRuns: DEFAULT_ALLOW_REMOTE_AGENT_RUNS },
  };
}

export function createAgentRunSettingsRoutes(deps: AgentRunSettingsRoutesDeps): Hono {
  const app = new Hono();
  let mutex: Promise<unknown> = Promise.resolve();
  function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = mutex.then(fn, fn);
    mutex = result.catch(() => undefined);
    return result;
  }

  app.use('*', createWriteGuardMiddleware(deps.writeAccess ?? {}));

  app.get('/api/settings/agent-runs', async (c) => {
    const config = await deps.store.read();
    const effective = toEffectiveDto(config);
    return c.json({
      ...effective,
      version: computeAgentRunVersion(config),
    });
  });

  app.put('/api/settings/agent-runs', async (c) => {
    if (!isLocalBasicAuthRequest(c)) {
      return c.json({ error: 'local access only' }, 403);
    }

    const parsed = await parseJsonBody(c, agentRunBodySchema, {
      includeValidationDetails: true,
    });
    if (!parsed.ok) return parsed.response;

    return runExclusive(async () => {
      const currentConfig = await deps.store.read();
      const currentVersion = computeAgentRunVersion(currentConfig);
      if (parsed.data.version !== currentVersion) {
        return c.json(
          {
            error: 'agent run config changed since read',
            requestedVersion: parsed.data.version,
            currentVersion,
          },
          409,
        );
      }

      const nextConfig = {
        ...(currentConfig ?? {}),
        allowRemoteAgentRuns: parsed.data.allowRemoteAgentRuns,
      };

      try {
        await deps.store.write(nextConfig);
      } catch {
        return c.json({ error: 'failed to write agent run config' }, 500);
      }

      const effective = toEffectiveDto(nextConfig);
      return c.json({
        ...effective,
        version: computeAgentRunVersion(nextConfig),
      });
    });
  });

  return app;
}
