import { Hono } from 'hono';
import type { ExternalIssueService } from '../../application/issue-report/external-issue-service.js';
import { createMinGapGate } from '../../application/issue-report/min-gap-gate.js';
import { EXTERNAL_ISSUE_REFRESH_MIN_GAP_MS } from '../../domain/external-issue-poll-policy.js';
import { DISABLED_EXTERNAL_ISSUE_LIST_DTO, toExternalIssueListDto } from './external-issue-dto.js';
import { createPrivilegedApiGuardMiddleware } from './write-guard.js';

/**
 * 届いた issue (ほかの人が出した公開 issue) の読み取り API (bdboard-4y8q.9.4、docs/ISSUE-REPORTING.md 8節)。
 *
 * - `GET /api/issue-reports/external`: ほかの読み取り API と同じ (トンネルではトンネルの認証を通れば読める。U10)。
 *   サービスが持っている直近の一覧を返すだけで、gh も bd も呼ばない。
 * - `POST /api/issue-reports/external/refresh`: 今すぐ確かめる。ローカル直アクセスのみ (`createPrivilegedApiGuardMiddleware`
 *   にトンネル用の依存を渡さないので、書き込み許可つきのトンネルセッションでも 403)。60 秒に 1 回まで、超えたら 429。
 *
 * このルーターは GitHub へ書き込まない。
 */

export const EXTERNAL_ISSUES_PATH = '/api/issue-reports/external';
export const EXTERNAL_ISSUES_REFRESH_PATH = '/api/issue-reports/external/refresh';

/** 無効のとき (メンテナ環境でない、または BDBOARD_EXTERNAL_ISSUES_DISABLED) の refresh (404)。`code` は機械が読む固定の値。 */
const DISABLED_BODY = {
  error: 'incoming issues are not enabled in this environment',
  code: 'external-issues-disabled',
} as const;

export interface ExternalIssueRoutesDeps {
  /** undefined = 無効 (メンテナ環境ではない、または BDBOARD_EXTERNAL_ISSUES_DISABLED)。GET は `enabled: false` を返し、refresh は 404。gh も bd も呼ばない。 */
  readonly service: Pick<ExternalIssueService, 'getList' | 'poll'> | undefined;
  /** refresh の間隔を測る時計 (ミリ秒)。既定は単調な `performance.now()`。 */
  readonly now?: () => number;
  /** refresh の最短の間隔。既定は 60 秒。 */
  readonly refreshMinGapMs?: number;
}

export function createExternalIssueRoutes(deps: ExternalIssueRoutesDeps): Hono {
  const app = new Hono();
  const refreshGate = createMinGapGate({
    minGapMs: deps.refreshMinGapMs ?? EXTERNAL_ISSUE_REFRESH_MIN_GAP_MS,
    now: deps.now ?? (() => performance.now()),
  });
  const localOnlyGuard = createPrivilegedApiGuardMiddleware({});

  app.get(EXTERNAL_ISSUES_PATH, (c) => {
    if (deps.service === undefined) return c.json(DISABLED_EXTERNAL_ISSUE_LIST_DTO);
    return c.json(toExternalIssueListDto(deps.service.getList()));
  });

  app.post(EXTERNAL_ISSUES_REFRESH_PATH, localOnlyGuard, async (c) => {
    const { service } = deps;
    // 無効のときは間隔の枠を使わない (404 を返しても、枠が減らない)。
    if (service === undefined) return c.json(DISABLED_BODY, 404);

    // 枠は poll の前に同期で取る: 同時に 2 本来ても、2 本目は 429 になる。弾いた要求は poll も呼ばず、枠も進めない。
    const pass = refreshGate.tryPass();
    if (!pass.ok) {
      const retryAfterSeconds = Math.max(1, Math.ceil(pass.retryAfterMs / 1000));
      c.header('Retry-After', String(retryAfterSeconds));
      return c.json(
        { error: 'refresh is limited to once per minute', code: 'refresh-rate-limited', retryAfterSeconds },
        429,
      );
    }

    // poll は例外にせず、失敗は一覧の state: 'error' で返る。HTTP は 200 のまま (取れた一覧と止まった理由を一緒に返す)。
    return c.json(toExternalIssueListDto(await service.poll()));
  });

  return app;
}
