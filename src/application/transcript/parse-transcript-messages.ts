import { truncate } from '../../domain/text.js';

export interface TranscriptTailMessage {
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly timestamp?: string;
}

const MAX_MESSAGE_CHARS = 4000;
const MAX_TOTAL_CHARS = 20000;

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  const parts: string[] = [];
  for (const block of content) {
    if (
      typeof block === 'object' &&
      block !== null &&
      'type' in block &&
      block.type === 'text' &&
      'text' in block &&
      typeof block.text === 'string'
    ) {
      parts.push(block.text);
    }
  }

  return parts.join('');
}

function parseLine(line: string): TranscriptTailMessage | undefined {
  const trimmed = line.trim();
  if (trimmed === '') {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;

  if (record.isMeta === true) {
    return undefined;
  }

  const type = record.type;
  if (type !== 'user' && type !== 'assistant') {
    return undefined;
  }

  const message = record.message;
  if (typeof message !== 'object' || message === null) {
    return undefined;
  }

  const messageRecord = message as Record<string, unknown>;
  const text = truncate(
    extractTextFromContent(messageRecord.content),
    MAX_MESSAGE_CHARS,
  );
  if (text === '') {
    return undefined;
  }

  const timestamp =
    typeof record.timestamp === 'string' ? record.timestamp : undefined;

  return {
    role: type,
    text,
    ...(timestamp !== undefined ? { timestamp } : {}),
  };
}

function applyTotalCharLimit(
  messages: readonly TranscriptTailMessage[],
): readonly TranscriptTailMessage[] {
  let totalChars = 0;
  let startIndex = messages.length;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const nextTotal = totalChars + messages[index].text.length;
    if (nextTotal > MAX_TOTAL_CHARS) {
      break;
    }
    totalChars = nextTotal;
    startIndex = index;
  }

  return messages.slice(startIndex);
}

export function parseTranscriptTailMessages(
  rawJsonlText: string,
  limit: number,
): readonly TranscriptTailMessage[] {
  const lines = rawJsonlText.split('\n');
  const messages: TranscriptTailMessage[] = [];

  for (const line of lines) {
    const message = parseLine(line);
    if (message !== undefined) {
      messages.push(message);
    }
  }

  const limited =
    limit > 0 && messages.length > limit ? messages.slice(-limit) : messages;

  return applyTotalCharLimit(limited);
}

export interface TranscriptIdentity {
  /** そのトランスクリプト行を記録した claude プロセスの実際の作業ディレクトリ。 */
  readonly cwd: string;
  /** ファイル名ではなく、トランスクリプト自身が記録している真のセッションID。 */
  readonly sessionId: string;
}

/**
 * トランスクリプト(の先頭付近のチャンクを想定)から、cwd と真の sessionId を持つ
 * 最初の user/assistant 行を探す。
 *
 * なぜファイル名ではなくこれが必要か(bdboard-3tw.104.3 レビュー MF3/SF4): ディレクトリ名や
 * ファイル名からの推測は `-old`/`.old`/`_old` サフィックスなどで別プロジェクトを誤って
 * 拾う偽陽性がありうる。トランスクリプト自身が記録した cwd は claude プロセスが実際に
 * 動いていたディレクトリなので、これと `Project.rootPath`/`aliasPaths` を完全一致で
 * 突き合わせることで、ディレクトリ名照合の偽陽性が実害(cwd の異なるセッションを
 * 一覧・resume 対象に含めてしまうこと)につながらないようにする。
 *
 * 見つからなければ undefined。呼び出し側は「所有権を検証できない」として扱い、
 * 一覧にも resume 対象にも含めないこと(fail-closed)。
 */
export function extractTranscriptIdentity(
  rawJsonlText: string,
): TranscriptIdentity | undefined {
  const lines = rawJsonlText.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // チャンクの末尾行は途中で切れている場合がある(readRange の byte 境界のため)。
      // 無視して次の行を試す。
      continue;
    }

    if (typeof parsed !== 'object' || parsed === null) {
      continue;
    }

    const record = parsed as Record<string, unknown>;
    if (record.type !== 'user' && record.type !== 'assistant') {
      continue;
    }

    const cwd = record.cwd;
    const sessionId = record.sessionId;
    if (
      typeof cwd === 'string' &&
      cwd.length > 0 &&
      typeof sessionId === 'string' &&
      sessionId.length > 0
    ) {
      return { cwd, sessionId };
    }
  }

  return undefined;
}
