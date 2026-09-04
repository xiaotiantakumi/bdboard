import type { Context, MiddlewareHandler } from 'hono';
import { isLocalBasicAuthRequest } from './local-request.js';
import {
  evaluateWriteAccess,
  type WriteGuardDecision,
  type WriteGuardDeps,
} from './write-guard.js';

export interface AgentRunGuardDeps {
  readonly writeAccess?: WriteGuardDeps;
  /** 設定値。解決に失敗したら false 扱い（fail-closed） */
  readonly isRemoteAgentRunAllowed: () => Promise<boolean>;
}

function denyWriteAccessResponse(
  c: Context,
  decision: Extract<WriteGuardDecision, { kind: 'deny' }>,
): Response {
  if (decision.reason === 'csrf') {
    return c.json({ error: 'cross-site write blocked' }, 403);
  }
  return c.json({ error: 'local access only' }, 403);
}

export function createAgentRunGuardMiddleware(deps: AgentRunGuardDeps): MiddlewareHandler {
  return async (c, next) => {
    const decision = evaluateWriteAccess(c, deps.writeAccess ?? {});
    if (decision.kind === 'deny') {
      return denyWriteAccessResponse(c, decision);
    }

    if (isLocalBasicAuthRequest(c)) {
      await next();
      return;
    }

    try {
      const allowed = await deps.isRemoteAgentRunAllowed();
      if (!allowed) {
        return c.json({ error: 'remote agent runs are disabled' }, 403);
      }
    } catch (err) {
      console.warn('bdboard: failed to resolve remote agent run policy; denying request', err);
      return c.json({ error: 'remote agent runs are disabled' }, 403);
    }

    await next();
  };
}
