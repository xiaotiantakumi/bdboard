export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function trimToMaxBytes(text: string, maxBytes: number): string {
  if (utf8ByteLength(text) <= maxBytes) {
    return text;
  }

  const bytes = new TextEncoder().encode(text);
  const tail = bytes.slice(bytes.length - maxBytes);

  for (let offset = 0; offset < tail.length; offset += 1) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(tail.slice(offset));
    } catch {
      // skip a broken leading byte from slicing mid-codepoint
    }
  }

  return '';
}

export function formatChunk(chunk: { stream: 'stdout' | 'stderr'; text: string }): string {
  return `[${chunk.stream}] ${chunk.text}`;
}
