import type { Context, Hono, MiddlewareHandler } from 'hono';
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


// bdboard-3knf: unexported unique symbol brand. No file outside this module can write a
// literal object with this exact computed key, so `AgentRunGuardToken` cannot be
// structurally satisfied except by calling `mountAgentRunGuard()` below (or an explicit
// `as unknown as AgentRunGuardToken` escape hatch, same as any TS nominal-typing brand).
const AGENT_RUN_GUARD_APPLIED: unique symbol = Symbol('agent-run-guard-applied');

/**
 * Proof that `mountAgentRunGuard()` has applied `agentRunGuard` to an app's
 * `/api/runs` and `/api/runs/*` patterns. The route factories require this as a
 * mandatory second argument, preventing mounting them without first applying the guard.
 */
export interface AgentRunGuardToken {
  readonly [AGENT_RUN_GUARD_APPLIED]: true;
}

/** Applies the guard to both run patterns and returns proof of the application. */
export function mountAgentRunGuard(app: Hono, deps: AgentRunGuardDeps): AgentRunGuardToken {
  const agentRunGuard = createAgentRunGuardMiddleware(deps);
  for (const pattern of ['/api/runs', '/api/runs/*']) {
    app.use(pattern, agentRunGuard);
  }
  return { [AGENT_RUN_GUARD_APPLIED]: true };
}
