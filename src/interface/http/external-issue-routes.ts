import { Hono } from 'hono';
import type { ExternalIssueService } from '../../application/issue-report/external-issue-service.js';
import { createMinGapGate } from '../../application/issue-report/min-gap-gate.js';
import { EXTERNAL_ISSUE_REFRESH_MIN_GAP_MS } from '../../domain/external-issue-poll-policy.js';
import { createPrivilegedApiGuardMiddleware } from './write-guard.js';
import { DISABLED_EXTERNAL_ISSUE_LIST_DTO, toExternalIssueListDto } from './external-issue-dto.js';

export const EXTERNAL_ISSUES_PATH = '/api/issue-reports/external';
export const EXTERNAL_ISSUES_REFRESH_PATH = '/api/issue-reports/external/refresh';

export interface ExternalIssueRoutesDeps {
  readonly service: Pick<ExternalIssueService, 'getList' | 'poll'> | undefined;
  readonly now?: () => number;
  readonly refreshMinGapMs?: number;
}

export function createExternalIssueRoutes(deps: ExternalIssueRoutesDeps): Hono {
  const app = new Hono();
  const gate = createMinGapGate({
    minGapMs: deps.refreshMinGapMs ?? EXTERNAL_ISSUE_REFRESH_MIN_GAP_MS,
    now: deps.now ?? (() => performance.now()),
  });
  app.get(EXTERNAL_ISSUES_PATH, (c) => c.json(
    deps.service === undefined ? DISABLED_EXTERNAL_ISSUE_LIST_DTO : toExternalIssueListDto(deps.service.getList()),
  ));
  app.post(EXTERNAL_ISSUES_REFRESH_PATH, createPrivilegedApiGuardMiddleware({}), async (c) => {
    if (deps.service === undefined) {
      return c.json({ error: 'incoming issues are not enabled in this environment', code: 'external-issues-disabled' }, 404);
    }
    const admission = gate.tryPass();
    if (!admission.ok) {
      const retryAfterSeconds = Math.max(1, Math.ceil(admission.retryAfterMs / 1000));
      c.header('Retry-After', String(retryAfterSeconds));
      return c.json({ error: 'refresh is limited to once per minute', code: 'refresh-rate-limited', retryAfterSeconds }, 429);
    }
    return c.json(toExternalIssueListDto(await deps.service.poll()));
  });
  return app;
}
