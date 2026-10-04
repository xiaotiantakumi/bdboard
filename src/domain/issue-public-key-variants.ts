/**
 * 手元の鍵 (固有名詞・プロジェクトの根のパス) の「別の書き方」を作る (bdboard-4y8q.2)。ログには、同じ名前が元の文字列のまま
 * 現れるとは限らない。ここで作った変種を全部探すことで、取りこぼしを減らす:
 *   - NFC と NFD (macOS のファイル名は分解形のことがある。濁点など)。
 *   - URL のパーセント表記 (encodeURI と encodeURIComponent): Node の ESM のスタックトレースは
 *     "file:///work/my%20proj/%E4%BB%95%E4%BA%8B/x.mjs" のように、空白や日本語の名前を %XX で出す。16 進の大文字小文字は、
 *     探すときの正規表現が大文字小文字を区別しない (i フラグ) ので 1 つの変種で足りる。元の文字列と同じになる変種は捨てる。
 *   - パスの区切りの書き方 (/ と \ と JSON の \\): 可変の区切り `[\\/]+` を正規表現に組むと失敗時に 2 乗になるので、変種を列挙する。
 * 鍵は text と同じ整形 (normalizeInline: 孤立サロゲート・見えない文字・空白の畳み込み) を通す。ログ側も同じ整形を通るので、
 * 比べる前に両方から同じものを取り除く。
 */
import { codePointLength, normalizeInline } from './issue-public-text.js';

export const MIN_ROOT_CODE_POINTS = 4;
export const MAX_ROOT_CODE_POINTS = 1024;

function normalizationVariants(value: string): string[] {
  return [value, value.normalize('NFC'), value.normalize('NFD')];
}

function percentVariants(value: string): string[] {
  try {
    return [value, encodeURIComponent(value), encodeURI(value)];
  } catch {
    // encodeURI は孤立サロゲートで例外を投げる。整形で取り除き済みなので来ないが、来ても元の形だけで続ける。
    return [value];
  }
}

/** 固有名詞 (整形後) の変種: NFC/NFD × (元の形・encodeURIComponent・encodeURI)。重複は捨てる。 */
export function nounVariants(normalized: string): string[] {
  return [...new Set(normalizationVariants(normalized).flatMap(percentVariants))];
}

function trimTrailingSeparators(value: string): string {
  let end = value.length;
  while (end > 0 && (value[end - 1] === '/' || value[end - 1] === '\\')) end -= 1;
  return value.slice(0, end);
}

export interface PreparedRoot {
  /** 探す文字列の変種。空なら登録しない (短すぎる・区切りだけ)。 */
  readonly variants: readonly string[];
  /** 根の最後の要素 (プロジェクトのフォルダ名)。なければ undefined。 */
  readonly basename: string | undefined;
  /** 長すぎて登録しなかった (呼び出し側が「鍵を落とした」と知らせる)。 */
  readonly dropped: boolean;
}

/**
 * プロジェクトの根のパスの変種と、フォルダ名。末尾の区切りは落とす (線形に。`/[\\/]+$/` は区切りが 10 万個続くと 2 乗になる)。
 * 4 コードポイント未満・区切りだけ ("/"・"C:\") は、何にでも一致するので登録しない。
 */
export function prepareRoot(raw: string): PreparedRoot {
  const root = trimTrailingSeparators(normalizeInline(raw));
  const length = codePointLength(root);
  if (length > MAX_ROOT_CODE_POINTS) return { variants: [], basename: undefined, dropped: true };
  if (length < MIN_ROOT_CODE_POINTS || !/[^\\/]/u.test(root.replace(/^[A-Za-z]:/u, ''))) {
    return { variants: [], basename: undefined, dropped: false };
  }
  const separatorForms = [
    root,
    root.replace(/[\\/]+/gu, '/'),
    root.replace(/[\\/]+/gu, '\\'),
    root.replace(/[\\/]+/gu, '\\\\'),
  ];
  const lastSeparator = Math.max(root.lastIndexOf('/'), root.lastIndexOf('\\'));
  const basename = root.slice(lastSeparator + 1);
  return {
    variants: [...new Set(separatorForms.flatMap(nounVariants))],
    // 4 コードポイント未満のフォルダ名 ("app"・"src") は名前として足さない (一般語との区別がつかない)。
    basename: codePointLength(basename) >= MIN_ROOT_CODE_POINTS ? basename : undefined,
    dropped: false,
  };
}
