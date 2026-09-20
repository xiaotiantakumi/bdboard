import type { ProviderBlock } from './types.js';

export function extractProviderBlocks(stdout: string): readonly ProviderBlock[] {
  const blocks: ProviderBlock[] = [];
  let current: { header: string; lines: string[] } | null = null;

  for (const rawLine of stdout.split('\n')) {
    if (rawLine.startsWith('## ')) {
      if (current !== null) {
        blocks.push(current);
      }
      current = { header: rawLine.slice(3).trim(), lines: [] };
      continue;
    }

    if (current === null) {
      continue;
    }

    // ブロック本文は常に2スペース以上のインデント付きで出力される。インデント無しの
    // 行(例: "ほかの連携AI（確認方法）:")に当たったら、そこでブロックのスコープを抜ける。
    if (rawLine.length > 0 && !rawLine.startsWith(' ')) {
      blocks.push(current);
      current = null;
      continue;
    }

    current.lines.push(rawLine);
  }

  if (current !== null) {
    blocks.push(current);
  }

  return blocks;
}

export function parseHeader(header: string): {
  readonly id: string;
  readonly label: string;
  readonly vendor?: string;
} {
  const separator = ' — ';
  const sepIndex = header.indexOf(separator);
  if (sepIndex === -1) {
    return { id: header.trim(), label: header.trim() };
  }

  const id = header.slice(0, sepIndex).trim();
  const rest = header.slice(sepIndex + separator.length).trim();

  const vendorMatch = rest.match(/^(.+)\s\(([^()]+)\)$/);
  if (vendorMatch) {
    return { id, label: vendorMatch[1].trim(), vendor: vendorMatch[2].trim() };
  }

  return { id, label: rest };
}
