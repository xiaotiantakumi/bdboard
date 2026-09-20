import { Hono } from 'hono';
import { z } from 'zod';
import { parseJsonBody } from './request-body.js';
import { isSafeCliArgument } from '../../domain/chat.js';
import type { BoardCache } from '../../application/ports/board-cache.js';
import type { Ticket } from '../../domain/ticket.js';
import {
  ContentConflictError,
  PriorityConflictError,
  StatusConflictError,
} from '../../application/ports/issue-writer.js';
import { respondBdError } from './bd-error-response.js';
import type { ApiDeps } from './routes.js';

// 上限は下の commentBodySchema と揃える。どちらの値も最終的に bd の argv に載るので、
// 無制限だと spawn が E2BIG で落ち、exitCode:-1 が classifyBdError に bd-not-found と
// 誤分類される (bdboard-xgvh レビュー指摘)。
const decisionBodySchema = z.object({
  choice: z.string().min(1).max(2000).optional(),
  freeform: z.string().min(1).max(2000).optional(),
});

const commentBodySchema = z.object({
  text: z.string().min(1).max(2000),
});

const dependencyBodySchema = z.object({
  dependsOnId: z.string().min(1).max(200),
});

const updateTitleBodySchema = z.object({
  title: z
    .string()
    .min(1)
    .max(200)
    .refine(isSafeCliArgument, { message: 'unsafe title' }),
  expectedCurrentTitle: z.string().max(200),
});

const updateDescriptionBodySchema = z.object({
  description: z.string().max(4000),
  expectedCurrentDescription: z.string().max(4000),
});

const sessionLinkBodySchema = z.object({
  sessionId: z.string().min(1).max(200),
});

const labelBodySchema = z.object({
  label: z
    .string()
    .min(1)
    .max(200)
    .refine(isSafeCliArgument, { message: 'unsafe label' }),
});

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

function findProjectRootPathForTicket(
  cache: BoardCache,
  ticketId: string,
): string | undefined {
  for (const entry of cache.listProjects()) {
    if (entry.tickets.some((ticket) => ticket.id === ticketId)) {
      return entry.project.rootPath;
    }
  }
  return undefined;
}

function findCachedTicket(
  cache: BoardCache,
  ticketId: string,
): { readonly rootPath: string; readonly ticket: Ticket } | undefined {
  for (const entry of cache.listProjects()) {
    const ticket = entry.tickets.find((candidate) => candidate.id === ticketId);
    if (ticket !== undefined) {
      return { rootPath: entry.project.rootPath, ticket };
    }
  }
  return undefined;
}

export function createTicketWriteRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  // 書き込み成功後、そのプロジェクトだけを強制リフレッシュしてから応答する。
  // これが無いと UI が応答直後に再取得しても書き込み前のキャッシュが返り、
  // 「操作が効いていない」ように見える(bdboard-6qs6)。
  // リフレッシュの失敗で書き込み自体を失敗扱いにはしない — bd への書き込みは
  // 既に成功しているので、ここで 5xx を返すと利用者が二重に操作しかねない。
  const refreshAfterWrite = async (rootPath: string): Promise<void> => {
    if (deps.refreshProjectByRootPath === undefined) {
      return;
    }
    try {
      await deps.refreshProjectByRootPath(rootPath);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`post-write refresh failed (rootPath=${rootPath}): ${detail}`);
    }
  };

  app.post('/api/tickets/:id/decision', async (c) => {
    if (deps.humanDecisions === undefined) {
      return c.json({ error: 'pending decisions not available' }, 501);
    }

    const id = c.req.param('id');

    const parsed = await parseJsonBody(c, decisionBodySchema);
    if (!parsed.ok) return parsed.response;

    const trimmedFreeform = parsed.data.freeform?.trim();
    const responseText =
      trimmedFreeform !== undefined && trimmedFreeform.length > 0
        ? trimmedFreeform
        : parsed.data.choice;

    if (responseText === undefined || responseText.length === 0) {
      return c.json({ error: 'choice or freeform is required' }, 400);
    }

    const rootPath = findProjectRootPathForTicket(deps.cache, id);
    if (rootPath === undefined) {
      return c.json({ error: 'ticket not found', id }, 404);
    }

    try {
      const outcome = await deps.humanDecisions.respond(rootPath, id, responseText);
      await refreshAfterWrite(rootPath);
      return c.json({
        ok: true,
        outcome: {
          kind: outcome.kind,
          closed: outcome.closed,
          ...(outcome.resolvedGateIds !== undefined
            ? { resolvedGateIds: outcome.resolvedGateIds }
            : {}),
          ...(outcome.clearedHumanLabelTicketIds !== undefined
            ? { clearedHumanLabelTicketIds: outcome.clearedHumanLabelTicketIds }
            : {}),
          ...(outcome.ambiguousGateIds !== undefined
            ? { ambiguousGateIds: outcome.ambiguousGateIds }
            : {}),
        },
      });
    } catch (error: unknown) {
      return respondBdError(c, 'failed to respond', error);
    }
  });

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

  app.post('/api/tickets/:id/dependencies', async (c) => {
    if (deps.dependencyWriter === undefined) {
      return c.json({ error: 'dependency editing not available' }, 501);
    }

    const id = c.req.param('id');

    const parsed = await parseJsonBody(c, dependencyBodySchema);
    if (!parsed.ok) return parsed.response;

    const { dependsOnId } = parsed.data;

    if (dependsOnId === id) {
      return c.json({ error: 'cannot depend on itself' }, 400);
    }

    const rootPath = findProjectRootPathForTicket(deps.cache, id);
    if (rootPath === undefined) {
      return c.json({ error: 'ticket not found', id }, 404);
    }

    const dependsOnRootPath = findProjectRootPathForTicket(
      deps.cache,
      dependsOnId,
    );
    if (dependsOnRootPath === undefined || dependsOnRootPath !== rootPath) {
      return c.json(
        { error: 'dependency target must be in the same project' },
        400,
      );
    }

    try {
      await deps.dependencyWriter.addDependency(rootPath, id, dependsOnId);
      await refreshAfterWrite(rootPath);
      return c.json({ ok: true });
    } catch (error: unknown) {
      return respondBdError(c, 'failed to add dependency', error);
    }
  });

  app.delete('/api/tickets/:id/dependencies/:dependsOnId{.+}', async (c) => {
    if (deps.dependencyWriter === undefined) {
      return c.json({ error: 'dependency editing not available' }, 501);
    }

    const id = c.req.param('id');
    const dependsOnId = c.req.param('dependsOnId');

    const cached = findCachedTicket(deps.cache, id);
    if (cached === undefined) {
      return c.json({ error: 'ticket not found', id }, 404);
    }

    const edge = cached.ticket.dependencies.find(
      (dependency) => dependency.dependsOnId === dependsOnId,
    );
    // キャッシュに無いエッジは bd に投げずにここで弾く。削除ボタンはキャッシュ上の
    // blocks エッジにしか出ないので、見つからない = クライアントが古い、ということ。
    // そのまま bd dep remove へ流すと、キャッシュが stale な間に parent-child を
    // 消してしまいうる(kind を判定できないため)。破壊的操作なので fail-closed にする。
    if (edge === undefined) {
      return c.json(
        { error: 'dependency not found on this ticket', id, dependsOnId },
        409,
      );
    }
    if (edge.kind !== 'blocks') {
      return c.json(
        { error: 'only blocks dependencies can be removed', kind: edge.kind },
        400,
      );
    }

    try {
      await deps.dependencyWriter.removeDependency(
        cached.rootPath,
        id,
        dependsOnId,
      );
      await refreshAfterWrite(cached.rootPath);
      return c.json({ ok: true });
    } catch (error: unknown) {
      return respondBdError(c, 'failed to remove dependency', error);
    }
  });

  app.patch('/api/tickets/:id/title', async (c) => {
    if (deps.issueWriter === undefined) {
      return c.json({ error: 'ticket content editing not available' }, 501);
    }

    const id = c.req.param('id');

    const parsed = await parseJsonBody(c, updateTitleBodySchema);
    if (!parsed.ok) return parsed.response;

    const rootPath = findProjectRootPathForTicket(deps.cache, id);
    if (rootPath === undefined) {
      return c.json({ error: 'ticket not found', id }, 404);
    }

    try {
      await deps.issueWriter.updateTitle(
        rootPath,
        id,
        parsed.data.title,
        parsed.data.expectedCurrentTitle,
      );
      await refreshAfterWrite(rootPath);
      return c.json({ ok: true });
    } catch (error: unknown) {
      if (error instanceof ContentConflictError) {
        return c.json(
          {
            error: 'title changed since loaded',
            detail: error.message,
            expectedTitle: error.expectedValue,
            currentTitle: error.actualValue,
          },
          409,
        );
      }

      return respondBdError(c, 'failed to update title', error);
    }
  });

  app.patch('/api/tickets/:id/description', async (c) => {
    if (deps.issueWriter === undefined) {
      return c.json({ error: 'ticket content editing not available' }, 501);
    }

    const id = c.req.param('id');

    const parsed = await parseJsonBody(c, updateDescriptionBodySchema);
    if (!parsed.ok) return parsed.response;

    const rootPath = findProjectRootPathForTicket(deps.cache, id);
    if (rootPath === undefined) {
      return c.json({ error: 'ticket not found', id }, 404);
    }

    try {
      await deps.issueWriter.updateDescription(
        rootPath,
        id,
        parsed.data.description,
        parsed.data.expectedCurrentDescription,
      );
      await refreshAfterWrite(rootPath);
      return c.json({ ok: true });
    } catch (error: unknown) {
      if (error instanceof ContentConflictError) {
        return c.json(
          {
            error: 'description changed since loaded',
            detail: error.message,
            expectedDescription: error.expectedValue,
            currentDescription: error.actualValue,
          },
          409,
        );
      }

      return respondBdError(c, 'failed to update description', error);
    }
  });

  app.post('/api/tickets/:id/labels', async (c) => {
    if (deps.issueWriter === undefined) {
      return c.json({ error: 'label editing not available' }, 501);
    }

    const id = c.req.param('id');

    const parsed = await parseJsonBody(c, labelBodySchema);
    if (!parsed.ok) return parsed.response;

    const rootPath = findProjectRootPathForTicket(deps.cache, id);
    if (rootPath === undefined) {
      return c.json({ error: 'ticket not found', id }, 404);
    }

    try {
      await deps.issueWriter.addLabel(rootPath, id, parsed.data.label);
      await refreshAfterWrite(rootPath);
      return c.json({ ok: true });
    } catch (error: unknown) {
      return respondBdError(c, 'failed to add label', error);
    }
  });

  app.delete('/api/tickets/:id/labels/:label{.+}', async (c) => {
    if (deps.issueWriter === undefined) {
      return c.json({ error: 'label editing not available' }, 501);
    }

    const id = c.req.param('id');
    const label = c.req.param('label');

    if (!isSafeCliArgument(label)) {
      return c.json({ error: 'invalid label' }, 400);
    }

    const cached = findCachedTicket(deps.cache, id);
    if (cached === undefined) {
      return c.json({ error: 'ticket not found', id }, 404);
    }

    const currentLabels = cached.ticket.labels ?? [];
    if (!currentLabels.includes(label)) {
      return c.json(
        { error: 'label not found on this ticket', id, label },
        409,
      );
    }

    try {
      await deps.issueWriter.removeLabel(cached.rootPath, id, label);
      await refreshAfterWrite(cached.rootPath);
      return c.json({ ok: true });
    } catch (error: unknown) {
      return respondBdError(c, 'failed to remove label', error);
    }
  });

  app.post('/api/tickets/:id/session-link', async (c) => {
    if (deps.sessionLinkWriter === undefined) {
      return c.json({ error: 'session linking not available' }, 501);
    }

    const id = c.req.param('id');

    const parsed = await parseJsonBody(c, sessionLinkBodySchema);
    if (!parsed.ok) return parsed.response;

    const rootPath = findProjectRootPathForTicket(deps.cache, id);
    if (rootPath === undefined) {
      return c.json({ error: 'ticket not found', id }, 404);
    }

    try {
      await deps.sessionLinkWriter.linkSession(
        rootPath,
        id,
        parsed.data.sessionId,
      );
      await refreshAfterWrite(rootPath);
      return c.json({ ok: true });
    } catch (error: unknown) {
      return respondBdError(c, 'failed to link session', error);
    }
  });

  app.delete('/api/tickets/:id/session-link', async (c) => {
    if (deps.sessionLinkWriter === undefined) {
      return c.json({ error: 'session linking not available' }, 501);
    }

    const id = c.req.param('id');

    const rootPath = findProjectRootPathForTicket(deps.cache, id);
    if (rootPath === undefined) {
      return c.json({ error: 'ticket not found', id }, 404);
    }

    try {
      await deps.sessionLinkWriter.unlinkSession(rootPath, id);
      await refreshAfterWrite(rootPath);
      return c.json({ ok: true });
    } catch (error: unknown) {
      return respondBdError(c, 'failed to unlink session', error);
    }
  });

  app.post('/api/tickets/:id/comment', async (c) => {
    if (deps.issueWriter === undefined) {
      return c.json({ error: 'comments not available' }, 501);
    }

    const id = c.req.param('id');

    const parsed = await parseJsonBody(c, commentBodySchema);
    if (!parsed.ok) return parsed.response;

    const rootPath = findProjectRootPathForTicket(deps.cache, id);
    if (rootPath === undefined) {
      return c.json({ error: 'ticket not found', id }, 404);
    }

    try {
      await deps.issueWriter.addComment(rootPath, id, parsed.data.text);

      await refreshAfterWrite(rootPath);
      return c.json({ ok: true });
    } catch (error: unknown) {
      return respondBdError(c, 'failed to add comment', error);
    }
  });

  return app;
}
