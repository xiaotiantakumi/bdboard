// bdboard-sso1.46: commit-message-guard.mjs から move-only 分割。-m/-F 系フラグの判定
// (元は「コマンドの解釈」節の一部。値を取る短縮/長縮オプションの定数と classifyFlag をまとめる)。

// --- コマンドの解釈 ---

const MESSAGE_LONG_FLAGS = new Set(['--message']);
const FILE_LONG_FLAGS = new Set(['--file']);

/**
 * `git commit` が値を取る短縮オプション。束 (`-Sm…`) を左から読むとき、最初にここへ当たった
 * 文字が後ろ全部を自分の値として食う。
 *
 * これを見ないと `git commit -Smykey` の `m` を `-m` と誤読し、本文のどこにも無い "ykey" を
 * メッセージとして判定してしまう (指摘 M2)。
 */
const VALUE_TAKING_SHORT_OPTS = new Set(['m', 'F', 'C', 'c', 't', 'u', 'S']);

/** `-m` / `-F` / `--message` / `--file` を、値が同一トークンに付いている形も含めて判定する。 */
export function classifyFlag(token) {
  const spelling = token.value ?? token.raw;
  if (typeof spelling !== 'string' || !spelling.startsWith('-') || spelling === '-') {
    return null;
  }

  if (spelling.startsWith('--')) {
    const eq = spelling.indexOf('=');
    const name = eq === -1 ? spelling : spelling.slice(0, eq);
    const kind = MESSAGE_LONG_FLAGS.has(name)
      ? 'message'
      : FILE_LONG_FLAGS.has(name)
        ? 'file'
        : null;
    if (kind == null) {
      return null;
    }
    if (eq === -1) {
      return { kind, attached: null };
    }
    const attached = spelling.slice(eq + 1);
    return { kind, attached, attachedValue: token.value == null ? null : attached };
  }

  // 短縮フラグの束 (-am / -sm など) を左から読む。最初に「値を取る」文字へ当たった時点で、
  // 後ろは全部その文字の値になる。当たった文字が m / F でなければこのトークンに -m / -F は無い。
  const bundle = spelling.slice(1);
  let at = -1;
  for (let k = 0; k < bundle.length; k += 1) {
    if (VALUE_TAKING_SHORT_OPTS.has(bundle[k])) {
      at = k;
      break;
    }
  }
  if (at === -1) {
    return null;
  }
  const letter = bundle[at];
  if (letter !== 'm' && letter !== 'F') {
    return null;
  }
  const kind = letter === 'm' ? 'message' : 'file';
  const rest = bundle.slice(at + 1);
  if (rest.length === 0) {
    return { kind, attached: null };
  }
  // `-m"text"` のように値が同一トークンへ続く形。raw から同じ長さだけ後ろを切り出す。
  const attachedRaw = token.raw.slice(token.raw.length - lengthOfAttachedRaw(token, rest));
  return { kind, attached: attachedRaw, attachedValue: token.value == null ? null : rest };
}

function lengthOfAttachedRaw(token, rest) {
  // value が確定しているなら raw と value は綴りが同じ (引用符なし) なので rest の長さでよい。
  // 確定していない場合は raw 側の `-x` 分だけ落とす。
  if (token.value != null) {
    return rest.length;
  }
  const dashPrefix = /^-[A-Za-z]*/.exec(token.raw);
  return token.raw.length - (dashPrefix ? dashPrefix[0].length : 1);
}
