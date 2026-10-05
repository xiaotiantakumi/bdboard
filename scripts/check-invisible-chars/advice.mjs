// bdboard-jb5x: 診断の 1 行の「直し方」。ASCII だけで書く (生の文字を出力に混ぜない)。
// UTF-16 のファイルは、エスケープで書いても直らない (BOM の U+FEFF 自体も検出される) ので UTF-8 で保存し直すよう案内する。
// UTF-8 のファイルの先頭の U+FEFF は BOM なので、エスケープではなく BOM を外すよう案内する。
// それ以外は、ファイルの種類 (targets.mjs の adviceKind) に合うエスケープを、見つけたコードポイントそのものの形で示す
// (BMP 外を \uXXXX と書くと、\uE0100 が U+E010 + '0' と読まれて別の文字になる):
//  - JS / TS: \u202E、BMP 外は \u{E0100}。JSX のテキストと属性ではエスケープが解釈されないので、その注意も添える。
//  - YAML の二重引用符: \u202E、BMP 外は \U000E0100 (YAML に \u{...} は無い)。
//  - bash: UTF-8 のバイト列 $'\xE2\x80\xAE'。$'\u...' / $'\U...' は bash 4.2 未満と、BMP 外を macOS の /bin/bash 3.2 や
//    C ロケールで文字にできない (エスケープのまま残る)。バイト列の書き方はどの版・ロケールでも同じ文字になる。
import { isVariationSelector } from './chars.mjs';

const hexDigits = (value, width) => value.toString(16).toUpperCase().padStart(width, '0');

export function jsEscape(codePoint) {
  return codePoint > 0xffff ? `\\u{${hexDigits(codePoint, 1)}}` : `\\u${hexDigits(codePoint, 4)}`;
}

export function yamlEscape(codePoint) {
  return codePoint > 0xffff ? `\\U${hexDigits(codePoint, 8)}` : `\\u${hexDigits(codePoint, 4)}`;
}

export function shellEscape(codePoint) {
  const bytes = [...Buffer.from(String.fromCodePoint(codePoint), 'utf8')];
  return `$'${bytes.map((byte) => `\\x${hexDigits(byte, 2)}`).join('')}'`;
}

export function fixAdvice({ encoding, kind, codePoint, atFileStart = false }) {
  let advice;
  if (encoding === 'utf16le' || encoding === 'utf16be') {
    advice = 'this file is saved as UTF-16: save it again as UTF-8 without a BOM';
  } else if (atFileStart && codePoint === 0xfeff) {
    advice = 'this file starts with a UTF-8 byte order mark: save it again as UTF-8 without a BOM';
  } else if (kind === 'shell') {
    advice = `write it as its UTF-8 bytes ${shellEscape(codePoint)} in bash, not the raw character ($'\\u...' depends on the bash version and locale)`;
  } else if (kind === 'yaml') {
    advice = `write it inside a double-quoted string as ${yamlEscape(codePoint)}, not the raw character (in a run: script, use the bash form ${shellEscape(codePoint)})`;
  } else {
    const escape = jsEscape(codePoint);
    advice = `write it as the escape ${escape}, not the raw character (in JSX text or attributes the escape is not interpreted: use a JS expression such as {'${escape}'})`;
  }
  return isVariationSelector(codePoint) ? `${advice} (a variation selector is accepted only as U+FE0E or U+FE0F right after an emoji)` : advice;
}
