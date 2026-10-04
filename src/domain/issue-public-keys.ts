/**
 * 手元だけの鍵 (LocalOnlyKeys: プロジェクトの根のパス・固有名詞) を、検索用の正規表現にコンパイルする
 * (bdboard-4y8q.2)。鍵は「探す文字列」であり、出力の材料にはしない (出力に出るのは置換後の印だけ)。
 *
 * 固有名詞の扱い (最小の長さと単語境界):
 *   - 1 文字・空・512 コードポイント超・一般的なブランチ名 (main など) は無視する。上限は 200 件。
 *   - LONG (4 コードポイント以上): 大文字小文字を区別しない部分一致で、置き換えも検出もする。
 *   - SHORT (2〜3 コードポイント): 置き換えない。一般語 ("web"・"api") を壊すと報告が読めなくなるため。
 *     検出だけして人に知らせる。誤検出を減らすため、前後が文字・数字でない単語として現れたときだけ。
 *   - NFC と NFD の両方で探す (macOS のファイル名は分解形のことがある。濁点など)。
 * プロジェクトの根のパスは、区切りの書き方 (/ と \ と JSON の \\) と NFC/NFD の変種を並べて探す。
 * `[\\/]+` のような可変の区切りを正規表現に組むと失敗時に 2 乗になるので、変種を列挙する。
 * 直後が [文字・数字・_ -] なら別の名前 (example-project2) なので一致させない。
 */
import { codePointLength, normalizeInline } from './issue-public-text.js';
import type { LocalOnlyKeys, ProperNounCategory } from './issue-public-types.js';

export interface KeySpan {
  readonly start: number;
  readonly end: number;
}

export interface NounSpan extends KeySpan {
  readonly kind: ProperNounCategory;
}

interface PreparedNoun {
  readonly kind: ProperNounCategory;
  readonly pattern: RegExp;
}

export interface PreparedKeys {
  readonly projectRoots: readonly RegExp[];
  readonly replaceableNouns: readonly PreparedNoun[];
  readonly detectableNouns: readonly PreparedNoun[];
}

/** 固有名詞として登録されても無視する一般的な名前 (小文字で比べる)。置き換えると本文が壊れる。 */
const GENERIC = new Set(['main', 'master', 'develop', 'trunk', 'head', 'root', 'localhost']);
const MAX_NOUNS = 200;
const MAX_NOUN_CODE_POINTS = 512;
const LONG_NOUN_CODE_POINTS = 4;
const MIN_NOUN_CODE_POINTS = 2;
const MIN_ROOT_CODE_POINTS = 4;

/** 標準の escapeRegExp。`-` は escape しない (`u` フラグでは範囲外の `\-` は構文エラー)。 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function literalPattern(value: string, suffix = ''): RegExp {
  return new RegExp(`${escapeRegExp(value)}${suffix}`, 'giu');
}

function normalizationVariants(value: string): string[] {
  return [...new Set([value, value.normalize('NFC'), value.normalize('NFD')])];
}

function rootVariants(raw: string): string[] {
  const root = raw.trim().replace(/[\\/]+$/u, '');
  const withoutDrive = root.replace(/^[A-Za-z]:/u, '');
  if (codePointLength(root) < MIN_ROOT_CODE_POINTS || !/[^\\/]/u.test(withoutDrive)) return [];
  return [
    root,
    root.replace(/[\\/]+/gu, '/'),
    root.replace(/[\\/]+/gu, '\\'),
    root.replace(/[\\/]+/gu, '\\\\'),
  ].flatMap(normalizationVariants);
}

export function prepareKeys(keys: LocalOnlyKeys): PreparedKeys {
  const rootValues = new Set<string>();
  for (const root of keys.projectRoots) for (const variant of rootVariants(root)) rootValues.add(variant);

  const replaceableNouns: PreparedNoun[] = [];
  const detectableNouns: PreparedNoun[] = [];
  const seen = new Set<string>();
  let accepted = 0;
  for (const noun of keys.properNouns) {
    if (accepted >= MAX_NOUNS) break;
    const normalized = normalizeInline(noun.value);
    const length = codePointLength(normalized);
    if (length < MIN_NOUN_CODE_POINTS || length > MAX_NOUN_CODE_POINTS || GENERIC.has(normalized.toLowerCase())) {
      continue;
    }
    accepted += 1;
    for (const variant of normalizationVariants(normalized)) {
      const key = `${noun.category}\0${variant.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const entry: PreparedNoun =
        length < LONG_NOUN_CODE_POINTS
          ? {
              kind: noun.category,
              pattern: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(variant)}(?![\\p{L}\\p{N}])`, 'giu'),
            }
          : { kind: noun.category, pattern: literalPattern(variant) };
      detectableNouns.push(entry);
      if (length >= LONG_NOUN_CODE_POINTS) replaceableNouns.push(entry);
    }
  }
  return {
    projectRoots: [...rootValues].map((root) => literalPattern(root, '(?![\\p{L}\\p{N}_-])')),
    replaceableNouns,
    detectableNouns,
  };
}

function matches(text: string, patterns: readonly RegExp[]): KeySpan[] {
  return patterns.flatMap((pattern) =>
    [...text.matchAll(pattern)].map((match) => ({ start: match.index, end: match.index + match[0].length })),
  );
}

function nounMatches(text: string, nouns: readonly PreparedNoun[]): NounSpan[] {
  return nouns.flatMap(({ kind, pattern }) =>
    [...text.matchAll(pattern)].map((match) => ({ kind, start: match.index, end: match.index + match[0].length })),
  );
}

/** プロジェクトの根のパスの出現位置 (置き換えも検出も同じ)。 */
export function findProjectRootSpans(text: string, prepared: PreparedKeys): KeySpan[] {
  return matches(text, prepared.projectRoots);
}

/** 置き換える固有名詞 (LONG のみ) の出現位置。kind は固有名詞の種別。 */
export function findReplaceableNounSpans(text: string, prepared: PreparedKeys): NounSpan[] {
  return nounMatches(text, prepared.replaceableNouns);
}

/** 検出する固有名詞 (LONG と SHORT。SHORT は単語として現れたときだけ) の出現位置。 */
export function findDetectableNounSpans(text: string, prepared: PreparedKeys): NounSpan[] {
  return nounMatches(text, prepared.detectableNouns);
}
