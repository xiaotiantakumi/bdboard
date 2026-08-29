/**
 * bdboard 自身のバージョンと、公開されている最新リリースを突き合わせる (bdboard-70z.7)。
 *
 * ここは純粋な比較ロジックだけを持つ。ネットワークアクセスと取得失敗の扱いは
 * application/infrastructure 側の責務。
 */

export interface Semver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** プレリリース識別子。空配列 = 正式リリース。 */
  readonly prerelease: readonly (string | number)[];
}

/** GitHub Releases の tag_name は `v1.2.3` 形式が慣例なので、先頭の `v` を許容する。 */
const SEMVER_PATTERN =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * SemVer 2.0.0 の主要部分をパースする。ビルドメタデータ (`+...`) は仕様上
 * 優先順位に影響しないので、受理はするが保持しない。
 */
export function parseSemver(input: string): Semver | null {
  const match = SEMVER_PATTERN.exec(input.trim());
  if (match === null) {
    return null;
  }

  const [, major, minor, patch, prerelease] = match;
  const identifiers =
    prerelease === undefined
      ? []
      : prerelease.split('.').map((part) => (/^(0|[1-9]\d*)$/.test(part) ? Number(part) : part));

  // `1.0.0-` や `1.0.0-a..b` のような空識別子は SemVer 的に不正。正規表現だけでは
  // 弾けないのでここで落とす。
  //
  // 先頭ゼロ付きの数値識別子 (`1.0.0-01`) も SemVer 9 で禁止されている。上の map は
  // `01` を数値化せず文字列のまま残すため、放置すると英数字識別子として扱われ
  // 「1.0.0-01 > 1.0.0-1」という誤った順序になる (SemVer 11.4.3 では数値識別子が
  // 常に小さい)。不正な入力を黙って誤解釈するより弾く (PR#112 fable レビュー minor-3)。
  if (identifiers.some((part) => part === '' || (typeof part === 'string' && /^\d+$/.test(part)))) {
    return null;
  }

  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: identifiers,
  };
}

function comparePrerelease(
  a: readonly (string | number)[],
  b: readonly (string | number)[],
): number {
  // プレリリース付きは、同じ数値部分の正式リリースより小さい (SemVer 11.3)。
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const left = a[i] as string | number;
    const right = b[i] as string | number;
    if (left === right) continue;

    const leftIsNumber = typeof left === 'number';
    const rightIsNumber = typeof right === 'number';
    // 数値識別子は英数字識別子より常に小さい (SemVer 11.4.3)。
    if (leftIsNumber && !rightIsNumber) return -1;
    if (!leftIsNumber && rightIsNumber) return 1;
    if (leftIsNumber && rightIsNumber) return left < right ? -1 : 1;
    return (left as string) < (right as string) ? -1 : 1;
  }

  // ここまで等しければ、識別子が多い方が大きい (SemVer 11.4.4)。
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

/** a < b なら負、a > b なら正、等しければ 0。 */
export function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

export interface LatestRelease {
  /** リリースのタグ名そのまま (`v1.2.3` など)。表示にはこれを使う。 */
  readonly tag: string;
  /** リリースページの URL。 */
  readonly url: string;
}

export type UpdateCheck =
  | { readonly kind: 'up-to-date'; readonly currentVersion: string }
  | {
      readonly kind: 'update-available';
      readonly currentVersion: string;
      readonly latestVersion: string;
      readonly releaseUrl: string;
    }
  /** 取得できなかった / どちらかのバージョンが SemVer として読めなかった。UI では黙る。 */
  | { readonly kind: 'unknown'; readonly currentVersion: string };

/**
 * 「最新版が自分より新しいときだけ update-available」を返す。
 *
 * 最新リリースが自分より古い場合 (開発中でリリース前の版を動かしている等) は
 * up-to-date であって「ダウングレードできます」ではない。
 */
export function evaluateUpdateCheck(
  currentVersion: string,
  latest: LatestRelease | null,
): UpdateCheck {
  if (latest === null) {
    return { kind: 'unknown', currentVersion };
  }

  const current = parseSemver(currentVersion);
  const latestSemver = parseSemver(latest.tag);
  if (current === null || latestSemver === null) {
    return { kind: 'unknown', currentVersion };
  }

  if (compareSemver(latestSemver, current) <= 0) {
    return { kind: 'up-to-date', currentVersion };
  }

  return {
    kind: 'update-available',
    currentVersion,
    latestVersion: latest.tag,
    releaseUrl: latest.url,
  };
}
