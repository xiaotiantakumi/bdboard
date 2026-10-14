export type LocalFileKind = 'image' | 'video' | 'audio' | 'markdown' | 'json' | 'text' | 'directory';

export type LocalFileContentKind = Exclude<LocalFileKind, 'directory'>;

export interface LocalFileType {
  kind: LocalFileContentKind;
  contentType: string;
}

const MIB = 1024 * 1024;

/** 単一 Range を終端省略で返すときの 1 回あたりの上限。 */
export const LOCAL_FILE_RANGE_CHUNK_BYTES = 4 * MIB;

const UNRANGED_BODY_LIMIT_BYTES: Readonly<Record<LocalFileContentKind, number>> = {
  markdown: 2 * MIB,
  json: 2 * MIB,
  text: 2 * MIB,
  image: 30 * MIB,
  video: 4 * MIB,
  audio: 4 * MIB,
};

const LOCAL_FILE_TYPES: Readonly<Record<string, LocalFileType>> = {
  png: { kind: 'image', contentType: 'image/png' },
  jpg: { kind: 'image', contentType: 'image/jpeg' },
  jpeg: { kind: 'image', contentType: 'image/jpeg' },
  webp: { kind: 'image', contentType: 'image/webp' },
  gif: { kind: 'image', contentType: 'image/gif' },
  mp4: { kind: 'video', contentType: 'video/mp4' },
  webm: { kind: 'video', contentType: 'video/webm' },
  m4v: { kind: 'video', contentType: 'video/x-m4v' },
  mov: { kind: 'video', contentType: 'video/quicktime' },
  mp3: { kind: 'audio', contentType: 'audio/mpeg' },
  m4a: { kind: 'audio', contentType: 'audio/mp4' },
  wav: { kind: 'audio', contentType: 'audio/wav' },
  md: { kind: 'markdown', contentType: 'text/markdown; charset=utf-8' },
  json: { kind: 'json', contentType: 'application/json; charset=utf-8' },
  txt: { kind: 'text', contentType: 'text/plain; charset=utf-8' },
  csv: { kind: 'text', contentType: 'text/csv; charset=utf-8' },
  srt: { kind: 'text', contentType: 'text/plain; charset=utf-8' },
  vtt: { kind: 'text', contentType: 'text/vtt; charset=utf-8' },
};

/** Range 無しの 200 応答で返す本文の上限バイト数。 */
export function localFileUnrangedBodyLimitBytes(kind: LocalFileContentKind): number {
  return UNRANGED_BODY_LIMIT_BYTES[kind];
}

function extensionOfLastSegment(path: string): string | undefined {
  const slash = path.lastIndexOf('/');
  const name = slash === -1 ? path : path.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) {
    return undefined;
  }
  return name.slice(dot + 1).toLowerCase();
}

/** 最後のセグメントの拡張子を大文字小文字を無視して引く。許可外は undefined。 */
export function localFileTypeForPath(path: string): LocalFileType | undefined {
  const extension = extensionOfLastSegment(path);
  if (extension === undefined || !Object.hasOwn(LOCAL_FILE_TYPES, extension)) {
    return undefined;
  }
  return LOCAL_FILE_TYPES[extension];
}
