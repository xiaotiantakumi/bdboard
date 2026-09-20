import { decodeStrictBase64 } from './chat-image-validation.js';

/**
 * チケット詳細で表示する添付画像の検証 (bdboard-qw26)。base64 の厳密デコードは
 * chat-image-validation.ts の decodeStrictBase64 を再利用し、マジックバイト判定は
 * GIF を追加した上でこちらに持つ (チャット添付は GIF 非対応なので分ける)。
 */

export const ATTACHMENT_ALLOWED_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;

export type AttachmentMimeType = (typeof ATTACHMENT_ALLOWED_MIME_TYPES)[number];

export function isAttachmentMimeType(value: string): value is AttachmentMimeType {
  return (ATTACHMENT_ALLOWED_MIME_TYPES as readonly string[]).includes(value);
}

/** 1ファイルあたりの上限 (デコード後バイト数)。 */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
/** 1チケットあたりの添付枚数上限。 */
export const ATTACHMENT_MAX_COUNT_PER_TICKET = 20;
/**
 * POST body (JSON, base64 data を含む) の上限。10MiB decoded -> 約13.34MiB base64。
 * JSON overhead を含めて14MiBで打ち切る (chat-image-validation.ts の比率に合わせる)。
 */
export const ATTACHMENT_BODY_MAX_BYTES = 14 * 1024 * 1024;

const EXTENSION_BY_MIME_TYPE: Readonly<Record<AttachmentMimeType, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export function extensionForMimeType(mimeType: AttachmentMimeType): string {
  return EXTENSION_BY_MIME_TYPE[mimeType];
}

/** サーバーが生成するファイル名の形 (<epochMs>-<16桁hex>.<ext>) だけを許可する。
 *  クライアント由来の文字列を一切含まないので、これに一致しないものは
 *  即座に拒否してよい (パストラバーサル対策)。 */
const GENERATED_FILE_NAME_PATTERN =
  /^[0-9]{1,20}-[0-9a-f]{16}\.(png|jpg|webp|gif)$/;

export function isGeneratedAttachmentFileName(value: string): boolean {
  return GENERATED_FILE_NAME_PATTERN.test(value);
}

function mimeTypeFromFileName(fileName: string): AttachmentMimeType | undefined {
  const ext = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase();
  const entry = (Object.entries(EXTENSION_BY_MIME_TYPE) as [AttachmentMimeType, string][])
    .find(([, mappedExt]) => mappedExt === ext);
  return entry?.[0];
}

/** GET 配信時に、拡張子からしか Content-Type を決めない (クライアントの主張を信用しない)。 */
export function contentTypeForGeneratedFileName(fileName: string): string | undefined {
  if (!isGeneratedAttachmentFileName(fileName)) return undefined;
  return mimeTypeFromFileName(fileName);
}

function hasExpectedMagicBytes(mimeType: AttachmentMimeType, data: Uint8Array): boolean {
  switch (mimeType) {
    case 'image/png':
      return data.length >= 8 &&
        data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47 &&
        data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a;
    case 'image/jpeg':
      return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    case 'image/webp':
      return data.length >= 12 &&
        data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
        data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50;
    case 'image/gif':
      return data.length >= 6 &&
        data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38 &&
        (data[4] === 0x37 || data[4] === 0x39) && data[5] === 0x61;
  }
}

/**
 * decodeStrictBase64 (デコード + 再エンコード + 文字列比較で入力全体を舐める) に
 * 渡す前に、base64 文字列の長さだけで上限超過を弾くための閾値。
 * N バイトの base64 表現は ceil(N/3)*4 文字になるため、上限バイト数から
 * 決定的に計算できる。
 * (bdboard-qw26 Opus レビュー指摘: 上限超過でも一度フルデコードしてしまうと、
 * レート制限の無いこの endpoint では CPU 消費による DoS の材料になり得る。
 * 長さチェックはデコード無しで O(1) なので、先に弾く。)
 */
const ATTACHMENT_MAX_BASE64_LENGTH = Math.ceil(ATTACHMENT_MAX_BYTES / 3) * 4;

/**
 * base64 文字列をデコードし、サイズ上限とマジックバイトを検証する。
 * 検証に失敗した場合は undefined (呼び出し側は 400 を返す)。
 */
export function decodeAttachmentImage(
  mimeType: AttachmentMimeType,
  data: string,
): Uint8Array | undefined {
  if (data.length > ATTACHMENT_MAX_BASE64_LENGTH) return undefined;
  const decoded = decodeStrictBase64(data);
  if (decoded === undefined) return undefined;
  if (decoded.byteLength === 0 || decoded.byteLength > ATTACHMENT_MAX_BYTES) return undefined;
  if (!hasExpectedMagicBytes(mimeType, decoded)) return undefined;
  return decoded;
}

/**
 * プロジェクトキー / issue id など、ファイルパスの構成要素として使う文字列の allowlist。
 * スラッシュ・ドット2連続・制御文字はすべて弾く (パストラバーサル対策)。
 */
const SAFE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;

export function isSafePathSegment(value: string): boolean {
  if (!SAFE_PATH_SEGMENT_PATTERN.test(value)) return false;
  if (value === '.' || value === '..') return false;
  return true;
}
