import { describe, expect, it } from 'vitest';
import { DECORATIVE_GLYPH_PATTERN } from './decorative-glyph-pattern.js';

/**
 * `DECORATIVE_GLYPH_PATTERN` を単体で固定する (bdboard-dh07)。
 *
 * `test/e2e/dark-theme.spec.ts` の `readSamples` はこの文字列を `page.evaluate` の引数として
 * 受け取り、ブラウザ側で `new RegExp(pattern, 'u')` に組み立てて使う — このファイルは
 * その **同じ文字列** を import して直接 assert するので、掃引側とテスト側が黙って
 * 乖離することはない (インライン複製した別 export を検証する形は議長裁定で不採用)。
 *
 * 本体は「可読な文章に `aria-hidden` が付いていても decorative 扱いにしない」こと
 * (`web/src/components/LoadingIndicator.tsx` が実際にこれをやっている)。この unit test が
 * 無いと、判定条件を `aria-hidden` 単独へ緩めても現行の e2e スイートが一度も踏まずに
 * 緑のまま通ってしまう (このチケットの発端)。
 */
describe('DECORATIVE_GLYPH_PATTERN', () => {
  const decorativeRe = new RegExp(DECORATIVE_GLYPH_PATTERN, 'u');

  it.each(['★', '☆', '▴', '▾', '▶', '▼'])(
    'matches the real decorative glyph %s (icon-like, non-alphanumeric, 1-2 chars)',
    (glyph) => {
      expect(decorativeRe.test(glyph)).toBe(true);
    },
  );

  it('does not match LoadingIndicator の経過秒数の可読な文章 (aria-hidden 付きだが本体)', () => {
    // web/src/components/LoadingIndicator.tsx: <span aria-hidden="true">{` (${elapsedSeconds}秒経過)`}</span>
    // 実描画時に readSamples 側でも .trim() されるので、ここでも trim 後の値で確認する。
    const elapsedSeconds = 12;
    const text = ` (${elapsedSeconds}秒経過)`.trim();
    expect(text).toBe('(12秒経過)');
    expect(decorativeRe.test(text)).toBe(false);
  });

  it('does not match other multi-character readable text', () => {
    expect(decorativeRe.test('読み込み中…')).toBe(false);
    expect(decorativeRe.test('OK')).toBe(false);
  });
});
