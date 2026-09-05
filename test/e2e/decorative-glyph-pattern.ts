/**
 * 「アイコンとして機能する装飾グリフ」判定に使う正規表現パターンの**単一の正本**
 * (bdboard-dh07)。判定条件・退行の経緯は `test/e2e/dark-theme.spec.ts` の
 * `Sample.decorative` の doc コメントを参照。
 *
 * この定数は文字列で持つ。`page.evaluate` は関数値をシリアライズして転送できない
 * (クロージャを転送する手段が無い) ため、判定述語そのものを関数として `page.evaluate` の
 * 引数に渡す実装は動かない。かわりにこのパターン**文字列**を `page.evaluate` の引数として
 * 渡し、ブラウザ側で `new RegExp(DECORATIVE_GLYPH_PATTERN, 'u')` を都度組み立てて使う
 * (`readSamples` 参照)。
 *
 * 同じ文字列を vitest 側 (`decorative-glyph-pattern.test.ts`) からも import して直接
 * assert する。**`readSamples` 内にこのパターンをインライン複製し、別途 export したものを
 * unit test する形は採らない** — 2 箇所が黙って乖離しうるので、テストが緑のまま実際の掃引は
 * 古い述語のまま、という壊れ方をする (bdboard-dh07 の議長裁定)。
 */
export const DECORATIVE_GLYPH_PATTERN = '^[^\\p{L}\\p{N}]{1,2}$';
