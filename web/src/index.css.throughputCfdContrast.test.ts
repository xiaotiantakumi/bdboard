import { readFileSync } from 'node:fs';
import { URL as NodeUrl, fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * bdboard-8gvg の回帰ガード。
 *
 * `ThroughputStats.tsx` の `CFD_STATUS_COLORS` は、累積フロー図 (CFD) の 7 系列
 * (open/in_progress/blocked/closed/deferred/pinned/hooked) の色を、すべて
 * `web/src/index.css` のカスタムプロパティ経由で参照する。この 7 色は塗り分けられた
 * 面 (バー本体・凡例のスウォッチ) であって本文テキストではないため、適用対象は
 * WCAG SC 1.4.11 (非テキストコントラスト、3:1) — SC 1.4.3 の 4.5:1 ではない。
 *
 * bdboard-7g0a で closed/deferred に `--color-success` / `--color-warning` を
 * 流用した結果、light の `--color-bg-elevated` (#ffffff) 上で closed 2.22:1 /
 * deferred 2.20:1 と 3:1 を下回っていた (dark は問題なし)。bdboard-8gvg は
 * `--throughput-cfd-closed` / `--throughput-cfd-deferred` という専用の派生トークンを
 * 新設して差し替えることで解消した。本テストはこの 2 系列に限らず 7 系列全部を
 * 対象にする — pinned/hooked は 7g0a で個別に検証済みだが機械的な回帰ガードが
 * 無かったため、ここで併せて塞ぐ。
 *
 * **系列同士の判別性はここでは検証しない。** WCAG のコントラスト比 (輝度ベース) は
 * 「グラフィカルオブジェクトとその背景」の比であり、「系列同士が互いに見分けられる
 * こと」を表現できない (index.css の該当コメント参照: 21 ペア中 3:1 を満たすものは
 * 1 つも無い)。凡例のテキストラベルが SC 1.4.1 (色だけに依存しない) を別途満たして
 * いるため、判別性はそちらで担保されている。
 *
 * **面のリストを手書きしない。** `index.css.badgeNeutralContrast.test.ts` と同じ方針で、
 * トークンの値を index.css から正規表現で読み直し、都度コントラスト比を計算する。
 * ハードコードした比率を書くと、色の値が変わってもテストだけ緑のまま残り続ける
 * (bdboard-97ib が固定許可リストの rot 検出で塞いだのと同じ穴)。
 */

const REQUIRED_CONTRAST_RATIO = 3.0;

const CFD_SERIES_TOKENS = [
  '--color-accent', // open
  '--color-purple', // in_progress
  '--color-danger', // blocked
  '--throughput-cfd-closed', // closed (bdboard-8gvg で新設)
  '--throughput-cfd-deferred', // deferred (bdboard-8gvg で新設)
  '--throughput-cfd-pinned', // pinned (bdboard-7g0a で新設)
  '--throughput-cfd-hooked', // hooked (bdboard-7g0a で新設)
] as const;

const BACKGROUND_TOKEN = '--color-bg-elevated';

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

interface RgbColor {
  r: number;
  g: number;
  b: number;
}

/** `#rrggbb` を解釈する。index.css の CFD 系列トークンはすべてこの形。 */
function parseHexColor(value: string): RgbColor {
  const hexMatch = value.match(/^#([0-9a-fA-F]{6})$/);
  if (!hexMatch) {
    throw new Error(
      `色として解釈できない値です: "${value}" (#rrggbb 形式のみ対応しています)`,
    );
  }
  const hex = hexMatch[1];
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

/** WCAG 2.x の相対輝度計算 (sRGB -> 線形変換 -> 重み付け和)。 */
function relativeLuminance(color: RgbColor): number {
  const toLinear = (channel255: number): number => {
    const channel = channel255 / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * toLinear(color.r) + 0.7152 * toLinear(color.g) + 0.0722 * toLinear(color.b);
}

/** WCAG 2.x のコントラスト比: (明るい方の輝度 + 0.05) / (暗い方の輝度 + 0.05)。 */
function contrastRatio(colorA: RgbColor, colorB: RgbColor): number {
  const luminanceA = relativeLuminance(colorA);
  const luminanceB = relativeLuminance(colorB);
  const lighter = Math.max(luminanceA, luminanceB);
  const darker = Math.min(luminanceA, luminanceB);
  return (lighter + 0.05) / (darker + 0.05);
}

function readThemeBlock(css: string, themeName: 'light' | 'dark'): string {
  const block = themeName === 'light' ? extractLightRootBlock(css) : extractDarkRootBlock(css);
  expect(
    block,
    `index.css から ${themeName} テーマのトークンブロックを抽出できませんでした。index.css の ` +
      `bare :root ブロック、または @media (prefers-color-scheme: dark) { :root:not(...) { … } } ` +
      'ブロックの構造が変わった可能性があります。',
  ).toBeDefined();
  return block as string;
}

describe('index.css — CFD 系列色の非テキストコントラスト (WCAG SC 1.4.11, 3:1, bdboard-8gvg)', () => {
  const css = stripCssComments(readCss());

  for (const themeName of ['light', 'dark'] as const) {
    it(`${themeName}: CFD 7 系列すべてが ${BACKGROUND_TOKEN} に対して 3:1 以上になる`, () => {
      const block = readThemeBlock(css, themeName);

      const backgroundValue = extractCustomProperty(block, BACKGROUND_TOKEN);
      expect(
        backgroundValue,
        `${themeName} テーマの ${BACKGROUND_TOKEN} が index.css から抽出できませんでした。`,
      ).toBeDefined();
      const background = parseHexColor(backgroundValue as string);

      for (const seriesToken of CFD_SERIES_TOKENS) {
        const seriesValue = extractCustomProperty(block, seriesToken);
        expect(
          seriesValue,
          `${themeName} テーマの ${seriesToken} が index.css から抽出できませんでした。`,
        ).toBeDefined();
        const seriesColor = parseHexColor(seriesValue as string);

        const ratio = contrastRatio(seriesColor, background);

        expect(
          ratio,
          `[${themeName}] ${seriesToken} (${seriesValue}) は ${BACKGROUND_TOKEN} ` +
            `(${backgroundValue}) に対してコントラスト比 ${ratio.toFixed(4)}:1 でした。` +
            `WCAG SC 1.4.11 の要求は ${REQUIRED_CONTRAST_RATIO}:1 以上です。`,
        ).toBeGreaterThanOrEqual(REQUIRED_CONTRAST_RATIO);
      }
    });
  }
});
