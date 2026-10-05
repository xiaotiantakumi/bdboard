// bdboard-ekvi / bdboard-rqzv: scripts/check-invisible-chars.mjs が検出する文字の表と、本文の走査・診断の整形。
// 入口 (check-invisible-chars.mjs) が行数の上限 (max-lines) に収まるよう、純粋な関数だけをここに置く。
// このファイルも検査の対象 (scripts/ 配下の .mjs) なので、生の文字は書かない。

const TAG_FIRST = 0xe0000;
const TAG_LAST = 0xe007f;
const VARIATION_RANGES = [[0xfe00, 0xfe0f], [0xe0100, 0xe01ef]];
const EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const CHAR_NAMES = new Map([
  [0x00ad, 'SOFT HYPHEN'],
  [0x061c, 'ARABIC LETTER MARK'],
  // U+115F / U+1160 は U+3164 / U+FFA0 と同じ Hangul filler で、単独で JS の識別子になる見えない文字。
  [0x115f, 'HANGUL CHOSEONG FILLER'],
  [0x1160, 'HANGUL JUNGSEONG FILLER'],
  [0x180e, 'MONGOLIAN VOWEL SEPARATOR'],
  [0x034f, 'COMBINING GRAPHEME JOINER'],
  [0x17b4, 'KHMER VOWEL INHERENT AQ'],
  [0x17b5, 'KHMER VOWEL INHERENT AA'],
  [0x180b, 'MONGOLIAN FREE VARIATION SELECTOR ONE'],
  [0x180c, 'MONGOLIAN FREE VARIATION SELECTOR TWO'],
  [0x180d, 'MONGOLIAN FREE VARIATION SELECTOR THREE'],
  [0x180f, 'MONGOLIAN FREE VARIATION SELECTOR FOUR'],
  [0x200e, 'LEFT-TO-RIGHT MARK'],
  [0x200f, 'RIGHT-TO-LEFT MARK'],
  [0x2028, 'LINE SEPARATOR'],
  [0x2029, 'PARAGRAPH SEPARATOR'],
  [0x202a, 'LEFT-TO-RIGHT EMBEDDING'],
  [0x202b, 'RIGHT-TO-LEFT EMBEDDING'],
  [0x202c, 'POP DIRECTIONAL FORMATTING'],
  [0x202d, 'LEFT-TO-RIGHT OVERRIDE'],
  [0x202e, 'RIGHT-TO-LEFT OVERRIDE'],
  [0x2066, 'LEFT-TO-RIGHT ISOLATE'],
  [0x2067, 'RIGHT-TO-LEFT ISOLATE'],
  [0x2068, 'FIRST STRONG ISOLATE'],
  [0x2069, 'POP DIRECTIONAL ISOLATE'],
  [0x200b, 'ZERO WIDTH SPACE'],
  [0x200c, 'ZERO WIDTH NON-JOINER'],
  [0x200d, 'ZERO WIDTH JOINER'],
  [0x2060, 'WORD JOINER'],
  [0x2061, 'FUNCTION APPLICATION'],
  [0x2062, 'INVISIBLE TIMES'],
  [0x2063, 'INVISIBLE SEPARATOR'],
  [0x2064, 'INVISIBLE PLUS'],
  [0x206a, 'INHIBIT SYMMETRIC SWAPPING'],
  [0x206b, 'ACTIVATE SYMMETRIC SWAPPING'],
  [0x206c, 'INHIBIT ARABIC FORM SHAPING'],
  [0x206d, 'ACTIVATE ARABIC FORM SHAPING'],
  [0x206e, 'NATIONAL DIGIT SHAPES'],
  [0x206f, 'NOMINAL DIGIT SHAPES'],
  [0x3164, 'HANGUL FILLER'],
  [0xfeff, 'ZERO WIDTH NO-BREAK SPACE (BOM)'],
  [0xffa0, 'HALFWIDTH HANGUL FILLER'],
  [0xe0001, 'LANGUAGE TAG'],
  [0xe007f, 'CANCEL TAG'],
]);

// 異体字セレクタ U+FE00-U+FE0F (VS1-16) と U+E0100-U+E01EF (VS17-256)。
export function isVariationSelector(codePoint) {
  return VARIATION_RANGES.some(([first, last]) => codePoint >= first && codePoint <= last);
}

function isKeycapBase(codePoint) {
  return (codePoint >= 0x30 && codePoint <= 0x39) || codePoint === 0x23 || codePoint === 0x2a;
}

// 異体字セレクタのうち、正当な絵文字の表示指定として通すもの (bdboard-jb5x)。previous / next は直前・直後のコードポイント
// (無ければ undefined)。GlassWorm 型の隠し込みは ASCII や引用符の後ろに異体字セレクタを連ねるので、通すのは次だけ:
//  - U+FE0E / U+FE0F の直前が \p{Extended_Pictographic} (絵文字・U+26A0 など)。
//  - U+FE0F の直前が keycap の元 (0-9 # *) で、直後が U+20E3 (COMBINING ENCLOSING KEYCAP)。
// 連なりは 2 つめの直前が異体字セレクタなので必ず止まる。U+FE00-U+FE0D と U+E0100-U+E01EF は常に止める。
export function isEmojiVariationSelector(codePoint, previous, next) {
  if (codePoint !== 0xfe0e && codePoint !== 0xfe0f) return false;
  if (previous === undefined) return false;
  if (EXTENDED_PICTOGRAPHIC.test(String.fromCodePoint(previous))) return true;
  return codePoint === 0xfe0f && next === 0x20e3 && isKeycapBase(previous);
}

// 検出対象のコードポイントの名前。対象でなければ undefined。Tags ブロック (U+E0000-U+E007F) は範囲で持つ。
// 異体字セレクタは全部名前を返す (ファイル名のエスケープと診断の名前に使う)。検出するかは文脈で決まるので findInvisibleChars が見る。
export function charName(codePoint) {
  if (isVariationSelector(codePoint)) {
    const index = codePoint <= 0xfe0f ? codePoint - 0xfe00 + 1 : codePoint - 0xe0100 + 17;
    return `VARIATION SELECTOR-${index}`;
  }
  const named = CHAR_NAMES.get(codePoint);
  if (named !== undefined) return named;
  if (codePoint >= TAG_FIRST && codePoint <= TAG_LAST) return 'TAG CHARACTER';
  return undefined;
}

function formatCodePoint(codePoint) {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
}

export function findInvisibleChars(text) {
  const findings = [];
  let line = 1;
  let column = 1;
  let previous; // 直前のコードポイント (先頭は undefined)。異体字セレクタが絵文字の直後かを見るのに使う
  for (let index = 0; index < text.length; index += 1) {
    const codePoint = text.codePointAt(index);
    const char = String.fromCodePoint(codePoint);
    const next = text.codePointAt(index + char.length);
    if (charName(codePoint) !== undefined && !isEmojiVariationSelector(codePoint, previous, next)) {
      findings.push({ line, column, codePoint: formatCodePoint(codePoint) });
    }
    previous = codePoint;
    if (char === '\r') {
      if (text[index + 1] === '\n') index += 1;
      line += 1;
      column = 1;
    } else if (char === '\n') {
      line += 1;
      column = 1;
    } else {
      column += char.length;
      if (char.length === 2) index += 1;
    }
  }
  return findings;
}

// 制御文字 (Cc)・書式文字 (Cf)・未割り当て (Cn)・私用 (Co)・サロゲート (Cs)・行/段落区切り (Zl/Zp)・空白類 (Zs)。
// 通常の空白 (U+0020) だけは下で除く。ここは検出対象 (charName) の外の見えない文字も含めるための広い網。
const HIDDEN_CHAR = /[\p{Cc}\p{Cf}\p{Cn}\p{Co}\p{Cs}\p{Zl}\p{Zp}\p{Zs}]/u;

function formatEscape(codePoint) {
  const digits = codePoint.toString(16).toUpperCase();
  return codePoint > 0xffff ? `\\u{${digits}}` : `\\u${digits.padStart(4, '0')}`;
}

// 診断に出す文字列 (主にファイル名) を、生の不可視文字・制御文字を含まない形にする。
// 読める文字 (日本語・絵文字など) はそのまま残す。バックスラッシュは、名前の中の文字どおりの「バックスラッシュ + u202E」と
// エスケープ結果を見分けられるように、バックスラッシュ自身も U+005C のエスケープにする。
export function escapeForDisplay(text) {
  let shown = '';
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    const mustEscape =
      char === '\\' || charName(codePoint) !== undefined || (char !== ' ' && HIDDEN_CHAR.test(char));
    shown += mustEscape ? formatEscape(codePoint) : char;
  }
  return shown;
}
