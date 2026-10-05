/**
 * 手元だけの鍵 (LocalOnlyKeys: プロジェクトの根のパス・固有名詞) を、検索用の正規表現にコンパイルする
 * (bdboard-4y8q.2)。鍵は「探す文字列」であり、出力の材料にはしない (出力に出るのは置換後の印だけ)。
 *
 * 固有名詞の扱い (最小の長さと単語境界):
 *   - 1 文字・空・一般的なブランチ名 (main など) は黙って無視する。
 *   - LONG (4 コードポイント以上): 大文字小文字を区別しない部分一致で、置き換えも検出もする。
 *   - SHORT (2〜3 コードポイント): 置き換えない。一般語 ("web"・"api") を壊すと報告が読めなくなるため。
 *     検出だけして人に知らせる。誤検出を減らすため、前後が文字・数字でない単語として現れたときだけ。
 *   - 各名前の変種 (NFC/NFD・パーセント表記) も探す: issue-public-key-variants.ts。
 * プロジェクトの根のパスは、区切りの書き方・NFC/NFD・パーセント表記の変種を並べて探し、根の最後の要素 (フォルダ名) が
 * 4 コードポイント以上なら、それも project の固有名詞として足す (WSL・混ざった区切り・JSON の \/ から見たパスでも名前が残らない)。
 * 直後が [文字・数字・_ -] なら別の名前 (example-project2) なので一致させない。
 *
 * 上限 (黙って落とさない): 固有名詞は重複 (同じカテゴリ・同じ綴り) を除いてから数え、最大 200 件。超えたときは優先順位の高い順に
 * 残す: (1) project・user・host の LONG → (2) branch の LONG → (3) SHORT。512 コードポイントを超える名前と、
 * 1024 コードポイントを超える根、200 件を超える根も登録しない。落としたものが 1 つでもあれば `truncated` を立てる
 * (呼び出し側は結果の keysTruncated と、suspectedLeaks の 'key-overflow' で知らせる)。
 * 上限そのものは性能のため: 敵対的な 512 コードポイントの名前 200 件で 64k 文字の全欄を処理しても数秒で終わる。
 *
 * 根と LONG の名前は、正規表現ではなく、大文字小文字をたたんだ文字列の indexOf で探す (自分と重なる出現も探す。issue-public-casefold.ts。以前の `/…/giu` と
 * 同じ一致。長い鍵の正規表現のコンパイルが 1 回の組み立てを 117〜233 秒にしていた、bdboard-uudb)。SHORT の名前は前後の条件つきの
 * 正規表現のまま (短いのでコンパイルは軽い)。RegExp オブジェクトは `g` フラグで lastIndex を持つので、使うたびに lastIndex = 0 に戻す
 * (別の呼び出しの状態を引きずらない)。
 */
import { caseInsensitiveLiteral, escapeRegExp, type CaseInsensitiveLiteral } from './issue-public-casefold.js';
import { literalSearcher } from './issue-public-literal-search.js';
import { fragmentKeyCollector, type FragmentKey } from './issue-public-fragments.js';
import { codePointLength, normalizeInline } from './issue-public-text.js';
import { nounVariants, prepareRoot } from './issue-public-key-variants.js';
import type { LocalOnlyKeys, ProperNounCategory } from './issue-public-types.js';

export interface KeySpan {
  readonly start: number;
  readonly end: number;
}

export interface NounSpan extends KeySpan {
  readonly kind: ProperNounCategory;
}

/** SHORT の固有名詞 (前後が文字・数字でない単語として探す正規表現)。 */
interface PreparedNoun {
  readonly kind: ProperNounCategory;
  readonly pattern: RegExp;
}

/** LONG の固有名詞 (大文字小文字を区別しない部分一致)。 */
interface LiteralNoun {
  readonly kind: ProperNounCategory;
  readonly literal: CaseInsensitiveLiteral;
}

export interface PreparedKeys {
  /** プロジェクトの根の変種 (直後が [文字・数字・_ -] でないものだけ一致)。 */
  readonly projectRoots: readonly CaseInsensitiveLiteral[];
  /** 置き換えも検出もする LONG の固有名詞 (変種を含む)。 */
  readonly replaceableNouns: readonly LiteralNoun[];
  /** SHORT (2〜3 コードポイント。置き換えず報告だけ) の固有名詞。 */
  readonly shortNouns: readonly PreparedNoun[];
  /** 欄の端の断片を探す鍵 (根と LONG の固有名詞の変種。issue-public-fragments.ts、bdboard-4y8q.13)。 */
  readonly fragmentKeys: readonly FragmentKey[];
  /** 上限・長さの制限で、一部の鍵を探していない。 */
  readonly truncated: boolean;
}

/** 固有名詞として登録されても無視する一般的な名前 (小文字で比べる)。置き換えると本文が壊れる。 */
const GENERIC = new Set(['main', 'master', 'develop', 'trunk', 'head', 'root', 'localhost']);
export const MAX_NOUNS = 200;
export const MAX_ROOTS = 200;
const MAX_NOUN_CODE_POINTS = 512;
const LONG_NOUN_CODE_POINTS = 4;
const MIN_NOUN_CODE_POINTS = 2;

interface Candidate {
  readonly category: ProperNounCategory;
  readonly value: string;
  readonly length: number;
  /** 1: project・user・host の LONG、2: branch の LONG、3: SHORT。小さいほど先に残す。 */
  readonly tier: 1 | 2 | 3;
}

function tierOf(category: ProperNounCategory, length: number): 1 | 2 | 3 {
  if (length < LONG_NOUN_CODE_POINTS) return 3;
  return category === 'branch' ? 2 : 1;
}

export function prepareKeys(keys: LocalOnlyKeys): PreparedKeys {
  let truncated = false;
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const addNoun = (category: ProperNounCategory, raw: string): void => {
    const value = normalizeInline(raw);
    const length = codePointLength(value);
    if (length < MIN_NOUN_CODE_POINTS || GENERIC.has(value.toLowerCase())) return;
    if (length > MAX_NOUN_CODE_POINTS) {
      truncated = true;
      return;
    }
    const key = `${category}\0${value.normalize('NFC').toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ category, value, length, tier: tierOf(category, length) });
  };
  for (const noun of keys.properNouns) addNoun(noun.category, noun.value);

  const rootKeys: CaseInsensitiveLiteral[] = [];
  const seenRootKeys = new Set<string>();
  // 端の検査の鍵: たたんだ後で同じになる変種は 1 つにし、合計のコードポイント数に上限を置く (記憶量。5節「欄の端の断片」)。
  const fragments = fragmentKeyCollector();
  const addFragmentKey = (variant: string): void => {
    if (!fragments.add(variant)) truncated = true;
  };
  const seenRoots = new Set<string>();
  for (const raw of keys.projectRoots) {
    const root = prepareRoot(raw);
    if (root.dropped) truncated = true;
    const first = root.variants[0];
    if (first === undefined || seenRoots.has(first)) continue;
    seenRoots.add(first);
    if (seenRoots.size > MAX_ROOTS) {
      truncated = true;
      break;
    }
    for (const variant of root.variants) {
      const literal = caseInsensitiveLiteral(variant, true);
      // たたんだ後で同じ変種 (パーセント表記の 16 進の大小文字など) は、同じ位置にしか一致しないので 1 つにする。
      if (!seenRootKeys.has(literal.folded)) {
        seenRootKeys.add(literal.folded);
        rootKeys.push(literal);
      }
      addFragmentKey(variant);
    }
    if (root.basename !== undefined) addNoun('project', root.basename);
  }

  const ordered = [...candidates].sort((left, right) => left.tier - right.tier);
  if (ordered.length > MAX_NOUNS) truncated = true;
  const replaceableNouns: LiteralNoun[] = [];
  const shortNouns: PreparedNoun[] = [];
  const seenPatterns = new Set<string>();
  for (const { category, value, length } of ordered.slice(0, MAX_NOUNS)) {
    for (const variant of nounVariants(value)) {
      if (length < LONG_NOUN_CODE_POINTS) {
        const key = `${category}\0${variant.toLowerCase()}`;
        if (seenPatterns.has(key)) continue;
        seenPatterns.add(key);
        shortNouns.push({
          kind: category,
          pattern: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(variant)}(?![\\p{L}\\p{N}])`, 'giu'),
        });
        continue;
      }
      // 端の検査も本体と同じ表でたたむので、たたんだ後で同じ変種は fragmentKeyCollector が 1 つにする。ここでは全部の変種を渡してよい。
      addFragmentKey(variant);
      const literal = caseInsensitiveLiteral(variant, false);
      const key = `${category}\0${literal.folded}`;
      if (seenPatterns.has(key)) continue;
      seenPatterns.add(key);
      replaceableNouns.push({ kind: category, literal });
    }
  }
  const fragmentKeys: readonly FragmentKey[] = fragments.keys;
  return { projectRoots: rootKeys, replaceableNouns, shortNouns, fragmentKeys, truncated };
}

function spansOf(text: string, pattern: RegExp): KeySpan[] {
  pattern.lastIndex = 0;
  return [...text.matchAll(pattern)].map((match) => ({ start: match.index, end: match.index + match[0].length }));
}

function shortNounMatches(text: string, nouns: readonly PreparedNoun[]): NounSpan[] {
  return nouns.flatMap(({ kind, pattern }) => spansOf(text, pattern).map((span) => ({ kind, ...span })));
}

/** プロジェクトの根のパスの出現位置 (置き換えも検出も同じ)。 */
export function findProjectRootSpans(text: string, prepared: PreparedKeys): KeySpan[] {
  return prepared.projectRoots.flatMap(literalSearcher(text));
}

/** 置き換える固有名詞 (LONG のみ) の出現位置。kind は固有名詞の種別。 */
export function findReplaceableNounSpans(text: string, prepared: PreparedKeys): NounSpan[] {
  const search = literalSearcher(text);
  return prepared.replaceableNouns.flatMap(({ kind, literal }) => search(literal).map((span) => ({ kind, ...span })));
}

/** 検出する固有名詞 (LONG と SHORT。SHORT は単語として現れたときだけ) の出現位置。 */
export function findDetectableNounSpans(text: string, prepared: PreparedKeys): NounSpan[] {
  return [...findReplaceableNounSpans(text, prepared), ...shortNounMatches(text, prepared.shortNouns)];
}

/** 報告だけの固有名詞 (SHORT のみ。単語として現れたときだけ) の出現位置。LONG の名前と根は探さない (その分の O(n·m) を払わない)。 */
export function findShortNounSpans(text: string, prepared: PreparedKeys): NounSpan[] {
  return shortNounMatches(text, prepared.shortNouns);
}
