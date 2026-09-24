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
// structurally satisfied except by calling `mountAgentRunGuard()` below. This is a
// compile-time guarantee only, with the same two escape hatches as any TS nominal-typing
// brand: an explicit `as unknown as AgentRunGuardToken` cast (not silent — a visible
// `as`/`any` in the diff), and reflection at runtime — but only starting from a token you
// already hold. `Object.getOwnPropertySymbols()` on a real token recovers the symbol
// value, and from there code can mint further tokens or mutate the existing one (it isn't
// frozen); it cannot conjure a token out of a plain `{}`, since the symbol itself is
// never exported and nothing else in this module leaks it. Neither escape hatch is
// something this token, or any unique-symbol brand, can close off — the property here is
// proof against accidental misuse and structural typing, not a security boundary against
// a determined bypass written in the same process with access to a real token.
//
// bdboard-v0df: the token literally carries the exact `Hono` instance `mountAgentRunGuard()`
// applied the guard to (not just a boolean flag). The route factories no longer accept or
// return an independently mountable `Hono` — `guardedApp()` is the only way to get an app
// out of a token, and it always hands back that same guarded instance, onto which the
// factories register their handlers directly (see agent-run-create-routes.ts etc.). So
// there is no app-shaped value in between that a caller could redirect onto a different,
// unguarded app, and no "mount under an unprefixed path" step left to skip the guard's
// '/api/runs' + '/api/runs/*' patterns — the routes are always registered at those exact
// paths on the exact app the guard was applied to. A token minted via
// `mountAgentRunGuard(otherApp, ...)` still only ever yields `otherApp` back, guard and
// all; it cannot be used to smuggle routes onto a third app the guard never touched.
// What remains conventional (not type-enforced) is that only `agent-run-routes.ts` calls
// `mountAgentRunGuard()`/the factories at all — that is pinned by
// agent-run-route-factories-guard.test.ts's sole-importer check, and the exact route table
// is pinned by agent-run-route-order.test.ts's EXPECTED_ROUTES.
const AGENT_RUN_GUARD_APPLIED: unique symbol = Symbol('agent-run-guard-applied');

/**
 * Proof that `mountAgentRunGuard()` applied the guard to a specific `Hono` instance. The
 * route factories require this as a mandatory second argument and use `guardedApp()` (not
 * a caller-supplied app) to find out where to register their routes — see the scope note
 * above for exactly what this does and does not guarantee.
 */
export interface AgentRunGuardToken {
  readonly [AGENT_RUN_GUARD_APPLIED]: Hono;
}

/** Applies the guard to both run patterns on `app` and returns proof of the application. */
export function mountAgentRunGuard(app: Hono, deps: AgentRunGuardDeps): AgentRunGuardToken {
  const agentRunGuard = createAgentRunGuardMiddleware(deps);
  for (const pattern of ['/api/runs', '/api/runs/*']) {
    app.use(pattern, agentRunGuard);
  }
  return { [AGENT_RUN_GUARD_APPLIED]: app };
}

/**
 * Returns the exact `Hono` instance a token proves was guarded (bdboard-v0df). Route
 * factories call this — instead of accepting or returning an independently mountable
 * `Hono` of their own — so their handlers always land on the app the guard was actually
 * applied to.
 */
export function guardedApp(token: AgentRunGuardToken): Hono {
  return token[AGENT_RUN_GUARD_APPLIED];
}
