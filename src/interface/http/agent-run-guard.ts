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
// `as unknown as AgentRunGuardToken` escape hatch, same as any TS nominal-typing brand —
// not a silent one, it's a visible `as`/`any` in the diff).
//
// Scope of the guarantee (opus review of this PR, 2026-09-24): the token proves
// `mountAgentRunGuard()` was called *somewhere*, not that it was called on the exact
// `app` instance the route factories end up mounted onto, or that the mount happens at
// an unprefixed path. Calling one of the route factories with a token minted via
// `mountAgentRunGuard(otherApp, ...)` and mounting the result onto a third, unguarded
// app still typechecks. What closes that residual gap
// today is convention plus two other regression tests, not this type alone:
// agent-run-routes.ts is the only file allowed to reference these factories
// (agent-run-route-factories-guard.test.ts's sole-importer check), and its exact route
// table is pinned (agent-run-route-order.test.ts's EXPECTED_ROUTES). Binding the token to
// the specific guarded app (e.g. by having the factories register directly onto a
// branded app handle instead of returning an independent Hono) is tracked as a follow-up
// (see bd, discovered-from bdboard-3knf) rather than done here.
const AGENT_RUN_GUARD_APPLIED: unique symbol = Symbol('agent-run-guard-applied');

/**
 * Proof that `mountAgentRunGuard()` was called. The route factories require this as a
 * mandatory second argument, so a file cannot call them without first obtaining a token
 * from `mountAgentRunGuard()` — see the scope note above for what this does and does not
 * guarantee.
 */
export interface AgentRunGuardToken {
  readonly [AGENT_RUN_GUARD_APPLIED]: true;
}

/** Applies the guard to both run patterns on `app` and returns proof of the application. */
export function mountAgentRunGuard(app: Hono, deps: AgentRunGuardDeps): AgentRunGuardToken {
  const agentRunGuard = createAgentRunGuardMiddleware(deps);
  for (const pattern of ['/api/runs', '/api/runs/*']) {
    app.use(pattern, agentRunGuard);
  }
  return { [AGENT_RUN_GUARD_APPLIED]: true };
}
