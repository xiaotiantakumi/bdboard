/**
 * bdboard-vgdr。チケット本文が指すプロジェクト内のファイルをボードで見るための読み取り API。
 * ローカル直アクセス限定 (トンネル不可)。閉じ込めは resolveContainedLocalPath の 1 関数に集約。
 * この router は inner のキャッチオールより先に mount される (mount-routes.ts) ので、
 * inner 側のガードは効かない — ここで自前のガードを両パターンに掛ける。
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { findLocalFileRefs } from '../../application/local-files/find-local-file-refs.js';
import { listLocalDirectory } from '../../application/local-files/list-local-directory.js';
import {
  resolveContainedLocalPath,
  toLocalFileRef,
} from '../../application/local-files/resolve-contained-local-path.js';
import type { BoardCache } from '../../application/ports/board-cache.js';
import type { CommentReader } from '../../application/ports/comment-reader.js';
import type { FileSystemPort } from '../../application/ports/file-system.js';
import type { Ticket } from '../../domain/ticket.js';
import { isSafePathSegment } from './attachment-validation.js';
import { localFileErrorResponse } from './local-file-http-errors.js';
import { serveLocalFileRaw } from './local-file-raw.js';
import { findCachedTicket } from './ticket-project-lookup.js';
import { createPrivilegedApiGuardMiddleware } from './write-guard.js';

export interface LocalFileRoutesDeps {
  readonly cache: Pick<BoardCache, 'listProjects'>;
  readonly fs: Pick<
    FileSystemPort,
    'tryRealPath' | 'stat' | 'isDirectory' | 'readDir' | 'readRangeBytes'
  >;
  readonly commentReader?: CommentReader;
}

export const LOCAL_FILES_PATH = '/api/tickets/:id/local-files';

/**
 * 抽出に渡すチケット本文。description / design / acceptance_criteria / notes の順。
 */
export function ticketTextsForLocalFiles(
  ticket: Pick<Ticket, 'description' | 'design' | 'acceptanceCriteria' | 'notes'>,
): readonly string[] {
  const texts: string[] = [];
  if (ticket.description !== undefined) {
    texts.push(ticket.description);
  }
  if (ticket.design !== undefined) {
    texts.push(ticket.design);
  }
  if (ticket.acceptanceCriteria !== undefined) {
    texts.push(ticket.acceptanceCriteria);
  }
  if (ticket.notes !== undefined) {
    texts.push(ticket.notes);
  }
  return texts;
}

async function commentTexts(
  commentReader: CommentReader | undefined,
  rootPath: string,
  ticketId: string,
): Promise<readonly string[]> {
  if (commentReader === undefined) {
    return [];
  }
  try {
    const comments = await commentReader.listComments(rootPath, ticketId);
    return comments.map((comment) => comment.text);
  } catch {
    return [];
  }
}

type OpenedLocalFileTicket =
  | {
      readonly ok: true;
      readonly id: string;
      readonly rootPath: string;
      readonly ticket: Ticket;
    }
  | { readonly ok: false; readonly response: Response };

function openLocalFileTicket(
  c: Context,
  cache: Pick<BoardCache, 'listProjects'>,
): OpenedLocalFileTicket {
  const id = c.req.param('id');
  if (id === undefined || !isSafePathSegment(id)) {
    return { ok: false, response: c.json({ error: 'invalid ticket id' }, 400) };
  }
  const found = findCachedTicket(cache, id);
  if (found === undefined) {
    return { ok: false, response: c.json({ error: 'ticket not found', id }, 404) };
  }
  return { ok: true, id, rootPath: found.rootPath, ticket: found.ticket };
}

export function createLocalFileRoutes(deps: LocalFileRoutesDeps): Hono {
  const app = new Hono();

  // コレクション単体は `/*` にマッチしないので、両方に同じガードを掛ける。
  const guard = createPrivilegedApiGuardMiddleware({});
  app.use(LOCAL_FILES_PATH, guard);
  app.use(`${LOCAL_FILES_PATH}/*`, guard);

  app.get(LOCAL_FILES_PATH, async (c) => {
    const opened = openLocalFileTicket(c, deps.cache);
    if (!opened.ok) {
      return opened.response;
    }
    const texts = [
      ...ticketTextsForLocalFiles(opened.ticket),
      ...(await commentTexts(deps.commentReader, opened.rootPath, opened.id)),
    ];
    const files = await findLocalFileRefs(texts, async (relativePath) =>
      toLocalFileRef(await resolveContainedLocalPath(deps.fs, opened.rootPath, relativePath)),
    );
    return c.json({ files });
  });

  app.get(`${LOCAL_FILES_PATH}/list`, async (c) => {
    const opened = openLocalFileTicket(c, deps.cache);
    if (!opened.ok) {
      return opened.response;
    }
    const requestedPath = c.req.query('path');
    if (requestedPath === undefined || requestedPath === '') {
      return c.json({ error: 'path is required' }, 400);
    }
    const listing = await listLocalDirectory(deps.fs, opened.rootPath, requestedPath);
    if (!listing.ok) {
      const { status, body } = localFileErrorResponse(listing.reason);
      return c.json(body, status);
    }
    return c.json({
      path: listing.path,
      entries: listing.entries,
      truncated: listing.truncated,
    });
  });

  app.get(`${LOCAL_FILES_PATH}/raw`, async (c) => {
    const opened = openLocalFileTicket(c, deps.cache);
    if (!opened.ok) {
      return opened.response;
    }
    return serveLocalFileRaw(c, deps.fs, opened.rootPath);
  });

  return app;
}
