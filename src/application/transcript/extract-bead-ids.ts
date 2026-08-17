import { compareStrings } from '../../domain/compare.js';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sortPrefixes(prefixes: readonly string[]): readonly string[] {
  return [...prefixes].sort((a, b) => {
    const lengthDiff = b.length - a.length;
    if (lengthDiff !== 0) {
      return lengthDiff;
    }
    return compareStrings(a, b);
  });
}

/** 既知の接頭辞から bead ID 候補を抽出し、既知IDの集合と照合して確定させる */
export function extractBeadIds(
  text: string,
  knownPrefixes: readonly string[],
  knownIds: ReadonlySet<string>,
): readonly string[] {
  if (text.length === 0 || knownPrefixes.length === 0 || knownIds.size === 0) {
    return [];
  }

  const activePrefixes = sortPrefixes(
    knownPrefixes.filter((prefix) => prefix.length > 0),
  );
  if (activePrefixes.length === 0) {
    return [];
  }

  const alternation = activePrefixes.map((prefix) => escapeRegExp(prefix)).join('|');
  // The leading lookbehind stops a prefix from matching in the middle of a
  // longer token: without it "xbdboard-3tw" (or a URL path segment ending in
  // those characters) would yield "bdboard-3tw". knownIds filtering already
  // limits the damage to ids that genuinely exist, but this keeps the match
  // anchored to a real token boundary.
  const pattern = new RegExp(
    `(?<![A-Za-z0-9-])(?:${alternation})-[A-Za-z0-9]+(?:\\.[0-9]+)*`,
    'g',
  );
  const matches = text.match(pattern) ?? [];
  const unique = new Set<string>();

  for (const candidate of matches) {
    if (knownIds.has(candidate)) {
      unique.add(candidate);
    }
  }

  return [...unique].sort(compareStrings);
}
