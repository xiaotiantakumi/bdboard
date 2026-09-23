import { normalizeSessionId } from '../../../application/session/parse-session-file.js';

export function sessionIdFromFileName(fileName: string): string {
  const base = fileName.endsWith('.jsonl')
    ? fileName.slice(0, -'.jsonl'.length)
    : fileName;
  return normalizeSessionId(base);
}
