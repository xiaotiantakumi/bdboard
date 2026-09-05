import { readFileSync } from 'node:fs';
import { URL as NodeUrl, fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * bdboard-tlus の回帰ガード。
 *
 * `--badge-neutral-fg` は `.status-pill-reconnecting` / `.status-pill-connecting` /
 * `.alert-bar-quiet` / `.lane-count` / `.badge-p2,.badge-p3,.badge-p4` /
 * `.badge-pr-unknown` / `.badge-defer-countdown` / `.badge-link-inferred` など
 * 10 箇所超で、常に半透明の `--badge-neutral-bg` を自分の背景として敷いた上に乗る
 * (`background: var(--badge-neutral-bg); color: var(--badge-neutral-fg);` の対)。
 * `--badge-neutral-bg` は `rgba(120, 120, 128, 0.12 | 0.24)` と不透明でないため、
 * 実際のコントラストは「その badge がどの面の上に置かれているか」に依存する。
 *
 * bdboard-tlus はライト側 `#6c6c70` を `#656569` に、ダーク側 `#a1a1a6` を `#a2a2a7` に
 * 変更して、代表的な地の面 (`body` = `--color-bg`、パネル類 = `--color-bg-elevated` /
 * `--color-bg-grouped`) で AA (4.5:1) を満たすようにした。ところが e2e のコントラスト掃引
 * (`test/e2e/dark-theme.spec.ts`) は `.alert-bar-quiet` (フィクスチャ非表示)・
 * `.status-pill-reconnecting` (非既定状態)・hover 状態のいずれも踏まないため、
 * `--badge-neutral-fg` を旧値へ戻しても掃引は緑のままになる = 回帰ガードが無い。
 *
 * **面のリストを手書きしない。** 「badge がどの面に乗ったときのコントラストが何:1」を
 * ハードコードすると、面トークンの値が変わったときにテストだけが古い前提のまま緑になり
 * 続ける (bdboard-97ib が固定許可リストの rot 検出で塞いだのと同じ穴)。そこで本テストは
 * `--badge-neutral-fg` / `--badge-neutral-bg` と、上記の badge 群が実際に乗りうる面を表す
 * トークン `--color-bg` / `--color-bg-elevated` / `--color-bg-grouped` の**値**を、実行の
 * たびに index.css から正規表現で読み直し、都度コントラスト比を計算する。トークンの値が
 * 変われば計算が自動で追随し、`--badge-neutral-fg` を戻せば必ず赤くなる。
 *
 * **対象外にした面とその理由 (hover / `color-mix()`)。** 上のコメント (index.css 内、
 * bdboard-tlus 自身の実装コメント) が挙げる実測面には `.header`
 * (`color-mix(in srgb, var(--color-bg-elevated) 88%, transparent)`) や
 * `.lane-header:hover` (`color-mix(in srgb, var(--color-text) 4%, transparent)`、実際に
 * 画面に出る色はさらにこの上に敷かれる祖先の背景色にも依存する) も含まれるが、これらは
 * 本テストの対象外にしている。`color-mix()` を CSS テキストから機械的に解くには CSS の
 * カラー空間変換・混色を実装する必要があり、テスト側に第二の CSS エンジンを抱えることに
 * なって割に合わない。今回の実害 (`.alert-bar-quiet` が乗る `--color-bg` 面で旧値が
 * 4.10:1 だった件) は、hover や color-mix を含まない素のトークン面 3 つ (`--color-bg` /
 * `--color-bg-elevated` / `--color-bg-grouped`) だけで再現・検出できるため、この境界でも
 * 実効性を失わない。
 *
 * **変異テストで判明した非対称性 (light は再現するが dark はしない)。** `--badge-neutral-fg`
 * を旧値に戻して確認したところ、light (`#6c6c70`) は `--color-bg` 面で 4.1025:1 となり
 * 本テストが正しく検出する。一方 dark (`#a1a1a6`) は 3 つの面すべてで元々 AA を満たしていた
 * (`--color-bg` 6.56:1 / `--color-bg-elevated` 及び `--color-bg-grouped` 4.96:1、いずれも
 * 4.5 以上)。上記 index.css のコメントが挙げる `.lane-header:hover` 面 (color-mix を含み
 * 本テストの対象外) でも旧値は 4.500225:1 と、僅差ながら AA を割ってはいない。つまり
 * dark 側の変更はマージンをほぼ 0 から安全域へ広げる予防的な変更であり、旧値が実際に
 * AA 違反だった面は存在しない。したがって本テストは dark について「旧値に戻しても
 * 赤くならない」— これは検出漏れではなく、旧値が (ぎりぎりではあるものの) 実際に
 * AA 違反ではなかったことを正しく反映した結果である。
 */

const SURFACE_TOKENS = ['--color-bg', '--color-bg-elevated', '--color-bg-grouped'] as const;

const REQUIRED_CONTRAST_RATIO = 4.5;

function readCss(): string {
  return readFileSync(fileURLToPath(new NodeUrl('./index.css', import.meta.url)), 'utf8');
}

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * bare `:root { … }` ブロック (ライトテーマの既定トークン) の宣言部を返す。
 * index.css の先頭が必ずこの形である前提に依存しているので、構造が変わって
 * マッチしなくなった場合は「見つからない」ことそのものをテストの失敗として扱う
 * (呼び出し側で toBeDefined 相当のアサートを行う)。
 */
function extractLightRootBlock(css: string): string | undefined {
  const match = css.match(/^\s*:root\s*\{([^{}]*)\}/);
  return match?.[1];
}

/**
 * `@media (prefers-color-scheme: dark) { :root:not([data-theme='light']) { … } }` の
 * 宣言部を返す。ライト同様、中身は入れ子ルールを含まない前提 (index.css の実際の構造)
 * なので `[^{}]*` の非入れ子マッチで十分。
 */
function extractDarkRootBlock(css: string): string | undefined {
  const match = css.match(
    /@media\s*\(\s*prefers-color-scheme:\s*dark\s*\)\s*\{\s*:root:not\(\s*\[\s*data-theme\s*=\s*(['"])light\1\s*\]\s*\)\s*\{([^{}]*)\}\s*\}/,
  );
  return match?.[2];
}

/** ブロック内から `<propertyName>: <値>;` の値部分を取り出す。 */
function extractCustomProperty(blockContent: string, propertyName: string): string | undefined {
  const pattern = new RegExp(`${propertyName}\\s*:\\s*([^;]+);`);
  const match = blockContent.match(pattern);
  return match?.[1]?.trim();
}

interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** `#rrggbb` または `rgb()`/`rgba()` を解釈する。index.css の badge/surface トークンは
 * すべてこの 2 形のいずれかで、hsl() や named color は使われていない。 */
function parseColor(value: string): RgbaColor {
  const hexMatch = value.match(/^#([0-9a-fA-F]{6})$/);
  if (hexMatch) {
    const hex = hexMatch[1];
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
      a: 1,
    };
  }
  const rgbaMatch = value.match(
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/,
  );
  if (rgbaMatch) {
    return {
      r: Number(rgbaMatch[1]),
      g: Number(rgbaMatch[2]),
      b: Number(rgbaMatch[3]),
      a: rgbaMatch[4] === undefined ? 1 : Number(rgbaMatch[4]),
    };
  }
  throw new Error(
    `色として解釈できない値です: "${value}" (#rrggbb か rgb()/rgba() の形のみ対応しています)`,
  );
}

/** 半透明の前景色 (fg) を不透明な背景色 (bg) の上にアルファ合成する。 */
function compositeOver(fg: RgbaColor, bg: RgbaColor): RgbaColor {
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  };
}

/** WCAG 2.x の相対輝度計算 (sRGB -> 線形変換 -> 重み付け和)。 */
function relativeLuminance(color: RgbaColor): number {
  const toLinear = (channel255: number): number => {
    const channel = channel255 / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * toLinear(color.r) + 0.7152 * toLinear(color.g) + 0.0722 * toLinear(color.b);
}

/** WCAG 2.x のコントラスト比: (明るい方の輝度 + 0.05) / (暗い方の輝度 + 0.05)。 */
function contrastRatio(colorA: RgbaColor, colorB: RgbaColor): number {
  const luminanceA = relativeLuminance(colorA);
  const luminanceB = relativeLuminance(colorB);
  const lighter = Math.max(luminanceA, luminanceB);
  const darker = Math.min(luminanceA, luminanceB);
  return (lighter + 0.05) / (darker + 0.05);
}

interface ThemeTokens {
  themeName: 'light' | 'dark';
  badgeNeutralFg: string;
  badgeNeutralBg: string;
  surfaces: Record<(typeof SURFACE_TOKENS)[number], string>;
}

function readThemeTokens(css: string, themeName: 'light' | 'dark'): ThemeTokens {
  const block = themeName === 'light' ? extractLightRootBlock(css) : extractDarkRootBlock(css);
  expect(
    block,
    `index.css から ${themeName} テーマのトークンブロックを抽出できませんでした。index.css の ` +
      `bare :root ブロック、または @media (prefers-color-scheme: dark) { :root:not(...) { … } } ` +
      'ブロックの構造が変わった可能性があります。',
  ).toBeDefined();
  const nonNullBlock = block as string;

  const badgeNeutralFg = extractCustomProperty(nonNullBlock, '--badge-neutral-fg');
  const badgeNeutralBg = extractCustomProperty(nonNullBlock, '--badge-neutral-bg');
  expect(
    badgeNeutralFg,
    `${themeName} テーマの --badge-neutral-fg が index.css から抽出できませんでした。`,
  ).toBeDefined();
  expect(
    badgeNeutralBg,
    `${themeName} テーマの --badge-neutral-bg が index.css から抽出できませんでした。`,
  ).toBeDefined();

  const surfaces = {} as Record<(typeof SURFACE_TOKENS)[number], string>;
  for (const surfaceToken of SURFACE_TOKENS) {
    const surfaceValue = extractCustomProperty(nonNullBlock, surfaceToken);
    expect(
      surfaceValue,
      `${themeName} テーマの ${surfaceToken} が index.css から抽出できませんでした。` +
        'この値は --badge-neutral-fg が実際に乗りうる面として本テストが参照しています。',
    ).toBeDefined();
    surfaces[surfaceToken] = surfaceValue as string;
  }

  return {
    themeName,
    badgeNeutralFg: badgeNeutralFg as string,
    badgeNeutralBg: badgeNeutralBg as string,
    surfaces,
  };
}

describe('index.css — badge-neutral の AA コントラスト (bdboard-tlus)', () => {
  const css = stripCssComments(readCss());

  for (const themeName of ['light', 'dark'] as const) {
    it(`${themeName}: --badge-neutral-fg は各面トークン上で WCAG AA (4.5:1) 以上になる`, () => {
      const tokens = readThemeTokens(css, themeName);
      const fg = parseColor(tokens.badgeNeutralFg);
      const badgeBg = parseColor(tokens.badgeNeutralBg);

      for (const surfaceToken of SURFACE_TOKENS) {
        const surface = parseColor(tokens.surfaces[surfaceToken]);
        // badge 自身の背景 (半透明) を面にアルファ合成してから、その実効背景と
        // 前景色のコントラストを見る。badge-neutral-fg は不透明の単色なので
        // それ自体の合成は不要。
        const effectiveBackground = compositeOver(badgeBg, surface);
        const ratio = contrastRatio(fg, effectiveBackground);

        expect(
          ratio,
          `[${themeName}] --badge-neutral-fg (${tokens.badgeNeutralFg}) は ${surfaceToken} ` +
            `(${tokens.surfaces[surfaceToken]}) に --badge-neutral-bg (${tokens.badgeNeutralBg}) ` +
            `を合成した面 (実効背景 rgb(${effectiveBackground.r.toFixed(2)}, ` +
            `${effectiveBackground.g.toFixed(2)}, ${effectiveBackground.b.toFixed(2)})) 上で ` +
            `コントラスト比 ${ratio.toFixed(4)}:1 でした。要求は ${REQUIRED_CONTRAST_RATIO}:1 以上です。`,
        ).toBeGreaterThanOrEqual(REQUIRED_CONTRAST_RATIO);
      }
    });
  }
});
