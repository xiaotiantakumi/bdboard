import type { InlineCode, Link, Parent, PhrasingContent, Root, Text } from 'mdast';
import { visit } from 'unist-util-visit';

/** チケット本文中のパスを、そのチケットの解決済みローカルファイル (bdboard-vgdr) へのリンクにする (bdboard-32vv)。 */
export const LOCAL_FILE_URL_PREFIX = 'local-file:';

// サーバー側の抽出 (src/domain/local-file-refs.ts) と同じ字種。
const PATH_TOKEN = /[A-Za-z0-9._/-]+/g;

export function localFileUrl(path: string): string {
  return `${LOCAL_FILE_URL_PREFIX}${encodeURIComponent(path)}`;
}

export function localFilePathFromUrl(href: string | undefined): string | undefined {
  if (href === undefined || !href.startsWith(LOCAL_FILE_URL_PREFIX)) return undefined;
  try {
    return decodeURIComponent(href.slice(LOCAL_FILE_URL_PREFIX.length));
  } catch {
    return undefined;
  }
}

function stripTrailingPunctuation(token: string): string {
  let end = token.length;
  while (end > 0 && '.,:;'.includes(token.charAt(end - 1))) end -= 1;
  return token.slice(0, end);
}

function normalizeToken(token: string): string {
  let value = token;
  while (value.startsWith('./')) value = value.slice(2);
  while (value.endsWith('/')) value = value.slice(0, -1);
  return value;
}

/**
 * 本文のトークンを解決済みパスの 1 つに結びつける。実在が確かめられたものだけが対象。
 * 完全一致を優先し、なければ `/` 区切りの末尾一致 (サーバーが直前のフォルダ基準で解決した相対パス)
 * のうち最短のもの。`/` も `.` も含まないトークンは対象にしない (サーバー側の候補条件と同じ)。
 */
export function matchLocalFilePath(token: string, paths: readonly string[]): string | undefined {
  const normalized = normalizeToken(token);
  if (normalized.length === 0 || (!normalized.includes('/') && !normalized.includes('.'))) {
    return undefined;
  }
  if (paths.includes(normalized)) return normalized;
  let best: string | undefined;
  for (const path of paths) {
    if (path.endsWith(`/${normalized}`) && (best === undefined || path.length < best.length)) {
      best = path;
    }
  }
  return best;
}

export interface TextSegment {
  readonly text: string;
  readonly path?: string;
}

/** テキストを「リンクにするパス」と「それ以外」に分ける。何も見つからなければ null。 */
export function splitTextByLocalFiles(
  value: string,
  paths: readonly string[],
): TextSegment[] | null {
  const segments: TextSegment[] = [];
  let last = 0;
  for (const match of value.matchAll(PATH_TOKEN)) {
    const index = match.index;
    if (index > 0 && value.charAt(index - 1) === '~') continue;
    const token = stripTrailingPunctuation(match[0]);
    const path = matchLocalFilePath(token, paths);
    if (path === undefined) continue;
    if (index > last) segments.push({ text: value.slice(last, index) });
    segments.push({ text: token, path });
    last = index + token.length;
  }
  if (segments.length === 0) return null;
  if (last < value.length) segments.push({ text: value.slice(last) });
  return segments;
}

function linkNode(path: string, children: PhrasingContent[]): Link {
  return { type: 'link', url: localFileUrl(path), children };
}

export function remarkLocalFileLinks(paths: readonly string[]) {
  return (tree: Root) => {
    if (paths.length === 0) return;
    visit(tree, (node, index, parent: Parent | undefined) => {
      if (parent === undefined || index === undefined) return;
      if (parent.type === 'link' || parent.type === 'linkReference') return;

      if (node.type === 'inlineCode') {
        const code = node as InlineCode;
        const path = matchLocalFilePath(stripTrailingPunctuation(code.value.trim()), paths);
        if (path === undefined) return;
        parent.children.splice(index, 1, linkNode(path, [code]));
        return index + 1;
      }

      if (node.type === 'text') {
        const segments = splitTextByLocalFiles((node as Text).value, paths);
        if (segments === null) return;
        const replacements: PhrasingContent[] = segments.map((segment) =>
          segment.path === undefined
            ? { type: 'text', value: segment.text }
            : linkNode(segment.path, [{ type: 'text', value: segment.text }]),
        );
        parent.children.splice(index, 1, ...replacements);
        return index + replacements.length;
      }
    });
  };
}
