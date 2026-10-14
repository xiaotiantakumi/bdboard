import path from 'node:path';
import { localFileTypeForPath, type LocalFileContentKind } from '../../domain/local-file-kinds.js';
import { normalizeLocalRelativePath } from '../../domain/local-file-path.js';
import type { FileSystemPort } from '../ports/file-system.js';
import type { LocalFileRef } from './find-local-file-refs.js';

export type ContainedLocalPath =
  | {
      readonly ok: true;
      readonly relativePath: string;
      readonly realPath: string;
      readonly isDirectory: true;
      readonly kind: 'directory';
      readonly size: null;
    }
  | {
      readonly ok: true;
      readonly relativePath: string;
      readonly realPath: string;
      readonly isDirectory: false;
      readonly kind: LocalFileContentKind;
      readonly contentType: string;
      readonly size: number;
    }
  | { readonly ok: false; readonly reason: 'invalid' | 'not-found' | 'unsupported-type' };

/**
 * 要求パスをプロジェクト根の内側に閉じ込めて解決する。
 * raw / list / 参照解決はすべてここを通す。比較は realpath 済みの値どうしで行う
 * （根が日本語でも、macOS の /var と /private/var の差でもずれない）。
 * realpath できない根・対象、通常ファイルでない対象、要求と実体で種類が違うリンクは拒否する。
 */
export async function resolveContainedLocalPath(
  fs: Pick<FileSystemPort, 'tryRealPath' | 'stat' | 'isDirectory'>,
  rootPath: string,
  requestedPath: string,
): Promise<ContainedLocalPath> {
  const normalized = normalizeLocalRelativePath(requestedPath);
  if (normalized === undefined) {
    return { ok: false, reason: 'invalid' };
  }

  const realRoot = await fs.tryRealPath(rootPath);
  const realTarget = await fs.tryRealPath(path.join(rootPath, normalized));
  // 解決できない根/対象は拒否する。入力を素通しする realPath だと、未解決の文字列で
  // 閉じ込めを判定しつつ stat/open はリンクをたどってしまう (根の外を配りうる)。
  if (realRoot === undefined || realTarget === undefined) {
    return { ok: false, reason: 'not-found' };
  }
  // 根そのもの、根の外へ出るリンク。
  if (realTarget === realRoot || !realTarget.startsWith(realRoot + path.sep)) {
    return { ok: false, reason: 'not-found' };
  }
  const resolvedSegments = path.relative(realRoot, realTarget).split(path.sep);
  if (resolvedSegments.some((segment) => segment.startsWith('.'))) {
    return { ok: false, reason: 'not-found' };
  }

  const stat = await fs.stat(realTarget);
  if (stat === undefined) {
    return { ok: false, reason: 'not-found' };
  }
  if (await fs.isDirectory(realTarget)) {
    return {
      ok: true,
      relativePath: normalized,
      realPath: realTarget,
      isDirectory: true,
      kind: 'directory',
      size: null,
    };
  }

  // FIFO・ソケット・デバイスは配らない (isFile を返さない fake は通常ファイル扱い)。
  if (stat.isFile === false) {
    return { ok: false, reason: 'not-found' };
  }

  const requested = localFileTypeForPath(normalized);
  const actual = localFileTypeForPath(realTarget);
  // 要求した拡張子と実体の種類が違うリンク (a.json -> b.png) は、要求側の種類で配らない。
  if (requested === undefined || actual === undefined || requested.kind !== actual.kind) {
    return { ok: false, reason: 'unsupported-type' };
  }
  return {
    ok: true,
    relativePath: normalized,
    realPath: realTarget,
    isDirectory: false,
    kind: requested.kind,
    contentType: requested.contentType,
    size: stat.size,
  };
}

/** 解決できた参照だけを一覧用の形にする。拒否は undefined。 */
export function toLocalFileRef(contained: ContainedLocalPath): LocalFileRef | undefined {
  if (!contained.ok) {
    return undefined;
  }
  return { path: contained.relativePath, kind: contained.kind, size: contained.size };
}
