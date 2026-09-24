import { Hono } from 'hono';
import { z } from 'zod';
import { parseJsonBody } from './request-body.js';
import {
  PriorityConflictError,
  StatusConflictError,
} from '../../application/ports/issue-writer.js';
import { respondBdError } from './bd-error-response.js';
import {
  findProjectRootPathForTicket,
  createRefreshAfterWrite,
} from './ticket-write-shared.js';
import type { ApiDeps } from './api-deps.js';

const quickActionBodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('claim') }),
  z.object({
    action: z.literal('close'),
    reason: z.string().min(1).max(2000).optional(),
  }),
  z.object({ action: z.literal('defer'), untilDate: z.string() }),
  z.object({ action: z.literal('undefer') }),
  z.object({
    action: z.literal('priority'),
    priority: z.number().int().min(0).max(4),
  }),
]);

// クイックアクションの逆操作(undo)。claim/close/defer は逆操作の形が一意に決まるため
// (unclaim/reopen/undefer)追加の入力は不要。priority と undefer は「元の値へ戻す」という
// 操作の性質上、呼び出し元(フロント)がアクション実行前に保持していた値を渡す必要がある。
// expectedCurrentPriority は「クイックアクション実行直後にセットした値」で、CAS チェック
// (bdboard-3tw.82)に使う。previousPriority(戻し先)とは別物。
const quickActionUndoBodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('claim') }),
  z.object({ action: z.literal('close') }),
  z.object({ action: z.literal('defer') }),
  z.object({ action: z.literal('undefer'), untilDate: z.string().min(1) }),
  z.object({
    action: z.literal('priority'),
    previousPriority: z.number().int().min(0).max(4),
    expectedCurrentPriority: z.number().int().min(0).max(4),
  }),
]);

export function createTicketQuickActionRoutes(deps: ApiDeps): Hono {
  const app = new Hono();
  const refreshAfterWrite = createRefreshAfterWrite(deps);

  app.post('/api/tickets/:id/quick-action', async (c) => {
    if (deps.issueWriter === undefined) {
      return c.json({ error: 'quick actions not available' }, 501);
    }

    const id = c.req.param('id');

    const parsed = await parseJsonBody(c, quickActionBodySchema);
    if (!parsed.ok) return parsed.response;

    const rootPath = findProjectRootPathForTicket(deps.cache, id);
    if (rootPath === undefined) {
      return c.json({ error: 'ticket not found', id }, 404);
    }

    try {
      switch (parsed.data.action) {
        case 'claim':
          await deps.issueWriter.claim(rootPath, id);
          break;
        case 'close':
          await deps.issueWriter.close(
            rootPath,
            id,
            parsed.data.reason,
          );
          break;
        case 'defer':
          await deps.issueWriter.defer(rootPath, id, parsed.data.untilDate);
          break;
        case 'undefer':
          await deps.issueWriter.undefer(rootPath, id);
          break;
        case 'priority':
          await deps.issueWriter.setPriority(
            rootPath,
            id,
            parsed.data.priority,
          );
          break;
      }

      await refreshAfterWrite(rootPath);
      return c.json({ ok: true });
    } catch (error: unknown) {
      if (error instanceof StatusConflictError) {
        // bdboard-3tw.93: `bd undefer`/`bd reopen` は前提を満たさなくても exit 0 で
        // no-op する。issueWriter 側の read-then-write CAS が StatusConflictError を
        // 投げるので、それを 502 の汎用エラーに潰さず 409 として返す。502 だと UI が
        // 『サーバー障害』と見分けられず、偽の成功表示や不適切なリトライにつながる。
        return c.json(
          {
            error: 'status changed since quick action',
            detail: error.message,
            expectedStatus: error.expectedStatus,
            currentStatus: error.actualStatus,
          },
          409,
        );
      }

      return respondBdError(c, 'failed to run quick action', error);
    }
  });

  app.post('/api/tickets/:id/quick-action/undo', async (c) => {
    if (deps.issueWriter === undefined) {
      return c.json({ error: 'quick actions not available' }, 501);
    }

    const id = c.req.param('id');

    const parsed = await parseJsonBody(c, quickActionUndoBodySchema);
    if (!parsed.ok) return parsed.response;

    const rootPath = findProjectRootPathForTicket(deps.cache, id);
    if (rootPath === undefined) {
      return c.json({ error: 'ticket not found', id }, 404);
    }

    try {
      switch (parsed.data.action) {
        case 'claim':
          await deps.issueWriter.unclaim(rootPath, id);
          break;
        case 'close':
          await deps.issueWriter.reopen(rootPath, id);
          break;
        case 'defer':
          await deps.issueWriter.undefer(rootPath, id);
          break;
        case 'undefer':
          // action:'defer' の undo が undefer() を呼ぶのと対になる。undefer の逆操作は
          // 『元の defer 日付へ戻す』なので、priority と同様に呼び出し元が実行前の値
          // (untilDate)を渡す必要がある。
          await deps.issueWriter.defer(rootPath, id, parsed.data.untilDate);
          break;
        case 'priority':
          await deps.issueWriter.undoPriority(
            rootPath,
            id,
            parsed.data.expectedCurrentPriority,
            parsed.data.previousPriority,
          );
          break;
      }

      await refreshAfterWrite(rootPath);
      return c.json({ ok: true });
    } catch (error: unknown) {
      if (error instanceof PriorityConflictError) {
        // bdboard-3tw.82: Undo を押すまでの間に別セッションが優先度を変えていた。
        // 上書きせずに 409 を返す — UI 側はこれを「他のセッションが変更しました」として
        // 表示する(web/src/components/UndoSnackbar.tsx の describeUndoError)。
        return c.json(
          {
            error: 'priority changed since quick action',
            detail: error.message,
            expectedPriority: error.expectedPriority,
            currentPriority: error.actualPriority,
          },
          409,
        );
      }

      if (error instanceof StatusConflictError) {
        // bdboard-3tw.93: close/defer の Undo(reopen/undefer)を押すまでの間に別
        // セッションがステータスを変えていた(あるいは bd reopen/undefer が前提を
        // 満たさず exit 0 で no-op しただけだった)。上書きせず 409 を返す — UI 側は
        // これも PriorityConflictError と同じ 409 分岐で「他のセッションが変更しました」
        // として表示する(web/src/components/UndoSnackbar.tsx の describeUndoError)。
        return c.json(
          {
            error: 'status changed since quick action',
            detail: error.message,
            expectedStatus: error.expectedStatus,
            currentStatus: error.actualStatus,
          },
          409,
        );
      }

      return respondBdError(c, 'failed to undo quick action', error);
    }
  });

  return app;
}
