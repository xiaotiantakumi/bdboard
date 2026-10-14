import { fetchJson, fetchOk } from './http';

/**
 * チケット本文が指すプロジェクト内ファイル (bdboard-vgdr)。
 * web/src/api.ts には出さない (api.exportSurface.test.ts が barrel の値を固定している)。
 */

export const LOCAL_FILE_KINDS = [
  'image',
  'video',
  'audio',
  'markdown',
  'json',
  'text',
  'directory',
] as const;

export type LocalFileKind = (typeof LOCAL_FILE_KINDS)[number];

export function isLocalFileKind(value: string): value is LocalFileKind {
  return (LOCAL_FILE_KINDS as readonly string[]).includes(value);
}

export interface LocalFileRefDto {
  readonly path: string;
  readonly kind: LocalFileKind;
  readonly size: number | null;
}

export interface LocalFileListEntryDto {
  readonly name: string;
  readonly path: string;
  readonly kind: LocalFileKind;
  readonly size: number | null;
}

export interface LocalFileListDto {
  readonly path: string;
  readonly entries: readonly LocalFileListEntryDto[];
  readonly truncated: boolean;
}

function localFilesBase(ticketId: string): string {
  return `/api/tickets/${encodeURIComponent(ticketId)}/local-files`;
}

export function fetchTicketLocalFiles(ticketId: string): Promise<{ files: LocalFileRefDto[] }> {
  return fetchJson<{ files: LocalFileRefDto[] }>(localFilesBase(ticketId));
}

export function fetchLocalFileList(ticketId: string, dirPath: string): Promise<LocalFileListDto> {
  return fetchJson<LocalFileListDto>(
    `${localFilesBase(ticketId)}/list?path=${encodeURIComponent(dirPath)}`,
  );
}

/** フォルダ一覧の React Query キー。サムネイル一覧と画像ビューアの前後送りで同じキャッシュを共有する。 */
export function localFileListQueryKey(ticketId: string, dirPath: string) {
  return ['ticket-local-file-list', ticketId, dirPath] as const;
}

export function localFileRawUrl(ticketId: string, path: string): string {
  return `${localFilesBase(ticketId)}/raw?path=${encodeURIComponent(path)}`;
}

export async function fetchLocalFileText(ticketId: string, path: string): Promise<string> {
  const res = await fetchOk(localFileRawUrl(ticketId, path));
  return res.text();
}
