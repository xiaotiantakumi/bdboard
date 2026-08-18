import type { MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';
import type { TunnelAccessService } from '../../application/tunnel/tunnel-access.js';
import type { TunnelService, TunnelState } from '../../application/tunnel/tunnel-service.js';
import { isLocalControlRequest } from './local-request.js';

export interface TunnelRoutesDeps {
  readonly tunnelService: TunnelService;
  /** Public tunnels are allowed only while site-wide Basic Auth is enabled. */
  readonly authEnabled: boolean;
  readonly access?: TunnelAccessService;
}

const startBodySchema = z.object({
  password: z.string().min(2).max(64).optional(),
});

function toPublicState(
  state: TunnelState,
  available: boolean,
  authEnabled: boolean,
  writeAccess: boolean,
  interruptedAt: Date | null,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    state: state.kind,
    available,
    authEnabled,
  };

  if (state.kind === 'on') {
    base.url = state.url;
    base.startedAt = state.startedAt.toISOString();
    // 短いパスワードで起動したトンネルは読み取り専用になる(bdboard-9rz)。
    // スマホから書き込めない理由が UI 側で説明できるように状態として返す。
    base.writeAccess = writeAccess;
  } else if (state.kind === 'error') {
    base.message = state.message;
  }

  if (interruptedAt !== null && state.kind !== 'on') {
    base.interruptedAt = interruptedAt.toISOString();
  }

  return base;
}

export function createTunnelRoutes(deps: TunnelRoutesDeps): Hono {
  const app = new Hono();

  const localOnlyGuard: MiddlewareHandler = async (c, next) => {
    if (!isLocalControlRequest(c)) {
      return c.json({ error: 'tunnel control API is local-only' }, 403);
    }
    await next();
  };

  // Matched by prefix rather than by listing each route, so a tunnel endpoint
  // added later is guarded by default instead of silently shipping unprotected.
  // Hono needs both patterns: '/api/tunnel' alone does not match sub-paths, and
  // '/api/tunnel/*' alone does not match the bare collection path.
  app.use('/api/tunnel', localOnlyGuard);
  app.use('/api/tunnel/*', localOnlyGuard);

  app.get('/api/tunnel', (c) => {
    const available = deps.tunnelService.getAvailability();
    return c.json(
      toPublicState(
        deps.tunnelService.getState(),
        available,
        deps.authEnabled,
        deps.tunnelService.isWriteAllowed(),
        deps.tunnelService.getInterruptedAt(),
      ),
    );
  });

  app.post('/api/tunnel/start', async (c) => {
    if (!deps.authEnabled) {
      return c.json(
        { error: 'Basic Auth must be enabled before starting a tunnel' },
        409,
      );
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const parsed = startBodySchema.safeParse(body);
    if (!parsed.success) {
      const tooShort = parsed.error.issues.some(
        (issue) => issue.code === 'too_small' && issue.path[0] === 'password',
      );
      const tooLong = parsed.error.issues.some(
        (issue) => issue.code === 'too_big' && issue.path[0] === 'password',
      );

      if (tooShort || tooLong) {
        return c.json(
          {
            error:
              'password must be 2-64 characters (the tunnel URL is public)',
          },
          400,
        );
      }

      return c.json({ error: 'invalid request body' }, 400);
    }

    const startOptions =
      parsed.data.password !== undefined
        ? { password: parsed.data.password }
        : undefined;

    const state = await deps.tunnelService.start(startOptions);
    const available = deps.tunnelService.getAvailability();
    return c.json(
      toPublicState(
        state,
        available,
        deps.authEnabled,
        deps.tunnelService.isWriteAllowed(),
        deps.tunnelService.getInterruptedAt(),
      ),
    );
  });

  app.post('/api/tunnel/stop', async (c) => {
    const state = await deps.tunnelService.stop();
    const available = deps.tunnelService.getAvailability();
    return c.json(
      toPublicState(
        state,
        available,
        deps.authEnabled,
        deps.tunnelService.isWriteAllowed(),
        deps.tunnelService.getInterruptedAt(),
      ),
    );
  });

  app.post('/api/tunnel/interruption/dismiss', (c) => {
    deps.tunnelService.dismissInterruption();
    const available = deps.tunnelService.getAvailability();
    return c.json(
      toPublicState(
        deps.tunnelService.getState(),
        available,
        deps.authEnabled,
        deps.tunnelService.isWriteAllowed(),
        deps.tunnelService.getInterruptedAt(),
      ),
    );
  });

  app.post('/api/tunnel/access-token', (c) => {
    const state = deps.tunnelService.getState();
    if (state.kind !== 'on' || deps.access === undefined) {
      return c.json({ error: 'tunnel is not running' }, 409);
    }

    const issued = deps.access.issueToken();
    if (issued === null) {
      return c.json({ error: 'tunnel is not running' }, 409);
    }

    return c.json({
      token: issued.token,
      expiresAt: issued.expiresAt.toISOString(),
    });
  });

  return app;
}
