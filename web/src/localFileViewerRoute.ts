import { isLocalFileKind, type LocalFileKind } from './api/local-files';

export interface LocalFileViewerRoute {
  readonly ticketId: string;
  readonly path: string;
  readonly kind: LocalFileKind;
  readonly size?: number;
}

export interface LocalFileViewerUrlInput {
  readonly ticketId: string;
  readonly path: string;
  readonly kind: LocalFileKind;
  readonly size?: number | null;
}

/** パスの最後のセグメント。末尾が `/` のときは空文字。 */
export function localFileNameOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

function nonNegativeInteger(size: number | null | undefined): number | undefined {
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) return undefined;
  return size;
}

/** 別ウィンドウのビューア。チケット deep link の `#ticket=` とは query を分ける。 */
export function buildLocalFileViewerUrl(input: LocalFileViewerUrlInput): string {
  const params = new URLSearchParams();
  params.set('view', 'local-file');
  params.set('ticket', input.ticketId);
  params.set('path', input.path);
  params.set('kind', input.kind);
  const size = nonNegativeInteger(input.size);
  if (size !== undefined) params.set('size', String(size));
  return `/?${params.toString()}`;
}

function parseSize(raw: string | null): number | undefined {
  if (raw === null || !/^\d+$/.test(raw)) return undefined;
  const size = Number(raw);
  if (!Number.isSafeInteger(size)) return undefined;
  return size;
}

/** `window.location.search` (`?` 始まり) を読む。条件を満たさなければ null。 */
export function parseLocalFileViewerRoute(search: string): LocalFileViewerRoute | null {
  const params = new URLSearchParams(search);
  if (params.get('view') !== 'local-file') return null;
  const ticketId = params.get('ticket');
  const path = params.get('path');
  const kind = params.get('kind');
  if (ticketId === null || ticketId === '' || path === null || path === '' || kind === null || !isLocalFileKind(kind)) {
    return null;
  }
  const size = parseSize(params.get('size'));
  return size === undefined ? { ticketId, path, kind } : { ticketId, path, kind, size };
}
