// bdboard-jb5x: 診断の 1 行の「直し方」。ASCII だけで書く (生の文字を出力に混ぜない)。
// UTF-16 のファイルは、エスケープで書いても直らない (BOM の U+FEFF 自体も検出される) ので UTF-8 で保存し直すよう案内する。
// UTF-8 のファイルは、ファイルの種類 (targets.mjs の adviceKind) に合うエスケープの書き方を案内する。JSX のテキストと属性では
// エスケープが解釈されないので、JS / TS にはその注意も添える。
import { isVariationSelector } from './chars.mjs';

export function fixAdvice({ encoding, kind, codePoint }) {
  let advice;
  if (encoding === 'utf16le' || encoding === 'utf16be') {
    advice = 'this file is saved as UTF-16: save it again as UTF-8 without a BOM';
  } else if (kind === 'shell') {
    advice = 'write it as an escape such as $\'\\uXXXX\' in bash (or build it with printf), not the raw character';
  } else if (kind === 'yaml') {
    advice = 'write it inside a double-quoted string as a \\uXXXX escape, not the raw character';
  } else {
    advice = 'write it as a \\uXXXX escape, not the raw character (in JSX text or attributes the escape is not interpreted: use a JS expression such as {\'\\u200B\'})';
  }
  return isVariationSelector(codePoint) ? `${advice} (a variation selector is accepted only as U+FE0E or U+FE0F right after an emoji)` : advice;
}
