// bdboard-sso1.28: HelpPanel.tsx から絞り込み検索の純粋ヘルパーを移動しただけ
// (move-only)。正規化・マッチ判定・ハイライト用の index map 構築・ハイライト
// ReactNode 組み立てのロジックと挙動は移動前から変えていない。
import type { ReactNode } from 'react';
import type { HelpSection } from '../../helpContent';

// NFKC folds full-width alphanumerics (e.g. ＰＷＡ → PWA). Hiragana/katakana
// folding is out of scope — NFKC does not map カナ to かな.
export function normalizeForSearch(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

export function sectionMatchesQuery(
  section: HelpSection,
  normalizedQuery: string,
): boolean {
  if (normalizedQuery.length === 0) {
    return true;
  }
  if (normalizeForSearch(section.title).includes(normalizedQuery)) {
    return true;
  }
  if (normalizeForSearch(section.description).includes(normalizedQuery)) {
    return true;
  }
  return section.steps.some((step) =>
    normalizeForSearch(step).includes(normalizedQuery),
  );
}

function buildNormalizedIndexMap(text: string): {
  normalized: string;
  indexMap: number[];
} {
  const indexMap: number[] = [];
  let normalized = '';

  for (let index = 0; index < text.length; ) {
    const codePoint = text.codePointAt(index)!;
    const charLength = codePoint > 0xffff ? 2 : 1;
    const normalizedChar = String.fromCodePoint(codePoint)
      .normalize('NFKC')
      .toLowerCase();

    for (let charIndex = 0; charIndex < normalizedChar.length; charIndex += 1) {
      indexMap.push(index);
    }

    normalized += normalizedChar;
    index += charLength;
  }

  return { normalized, indexMap };
}

export function highlightMatches(
  text: string,
  normalizedQuery: string,
): ReactNode {
  if (normalizedQuery.length === 0) {
    return text;
  }

  const { normalized, indexMap } = buildNormalizedIndexMap(text);
  const parts: ReactNode[] = [];
  let normalizedPosition = 0;
  let partKey = 0;

  while (normalizedPosition < normalized.length) {
    const matchIndex = normalized.indexOf(normalizedQuery, normalizedPosition);

    if (matchIndex === -1) {
      parts.push(text.slice(indexMap[normalizedPosition]));
      break;
    }

    if (matchIndex > normalizedPosition) {
      parts.push(
        text.slice(indexMap[normalizedPosition], indexMap[matchIndex]),
      );
    }

    const matchOrigStart = indexMap[matchIndex];
    const matchEndNormalized = matchIndex + normalizedQuery.length;
    const matchOrigEnd =
      matchEndNormalized < indexMap.length
        ? indexMap[matchEndNormalized]
        : text.length;

    parts.push(
      <mark key={partKey}>{text.slice(matchOrigStart, matchOrigEnd)}</mark>,
    );
    partKey += 1;
    normalizedPosition = matchEndNormalized;
  }

  if (parts.length === 1 && typeof parts[0] === 'string') {
    return parts[0];
  }

  return parts;
}
