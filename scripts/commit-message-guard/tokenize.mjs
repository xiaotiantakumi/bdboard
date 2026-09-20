// bdboard-sso1.46: commit-message-guard.mjs から move-only 分割。シェル文字列のトークナイズ。

// --- トークナイズ ---

const OPERATOR_CHARS = new Set([';', '&', '|', '\n']);
// 引用符の外で展開・グロブが起きる文字。1 文字でも混ざればそのトークンは未確定扱い。
// `\` はここに入れない — 下で「次の 1 文字をリテラル化する」として明示的に処理する (指摘 m4)。
const UNRESOLVABLE_CHARS = /[$`*?]/;

/**
 * residual を「シェルのトークン」へ割る。各トークンは raw (元の綴り)、value (確定できた
 * リテラル値、確定できなければ null)、residual 内の位置 start / end を持つ。
 *
 * 完全なシェル文法の実装ではない。目的は `-m` / `-F` の値を取り出すことだけで、少しでも
 * 怪しければ value=null にして fail-open へ倒す方が、無理に解釈して誤判定するより安全。
 */
export function tokenize(text) {
  const tokens = [];
  let raw = '';
  let value = '';
  let resolvable = true;
  let started = false;
  let start = 0;

  const flush = (end) => {
    if (started) {
      tokens.push({ raw, value: resolvable ? value : null, start, end });
    }
    raw = '';
    value = '';
    resolvable = true;
    started = false;
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    if (ch === ' ' || ch === '\t' || ch === '\r') {
      flush(i);
      i += 1;
      continue;
    }

    // 行継続。シェルは `\` と改行の両方を消すだけでトークンを切らない。ここで消しておかないと
    // 改行が演算子として扱われ、次行に書かれた `-m '…'` を走査対象から落とす (指摘 m4)。
    if (ch === '\\' && text[i + 1] === '\n') {
      i += 2;
      continue;
    }

    if (OPERATOR_CHARS.has(ch)) {
      flush(i);
      tokens.push({ raw: ch, value: null, operator: true, start: i, end: i + 1 });
      i += 1;
      continue;
    }

    if (!started) {
      started = true;
      start = i;
    }

    if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      if (end === -1) {
        // 閉じない引用符。ここから先は解釈不能なので、残りを丸ごと未確定トークンにして終わる。
        raw += text.slice(i);
        resolvable = false;
        i = text.length;
        continue;
      }
      raw += text.slice(i, end + 1);
      value += text.slice(i + 1, end);
      i = end + 1;
      continue;
    }

    if (ch === '"') {
      const scanned = scanDoubleQuoted(text, i);
      if (scanned == null) {
        raw += text.slice(i);
        resolvable = false;
        i = text.length;
        continue;
      }
      raw += text.slice(i, scanned.end + 1);
      // 二重引用符の中では `*` `?` はグロブにならずリテラル。ここを一律に未確定へ倒していたので、
      // `-m "…しますか?"` のような普通の本文が判定されないまま素通りしていた (指摘 m3)。
      const inner = resolveDoubleQuoted(scanned.inner);
      if (inner == null) {
        resolvable = false;
      } else {
        value += inner;
      }
      i = scanned.end + 1;
      continue;
    }

    if (ch === '$' && text[i + 1] === '(') {
      const end = findMatchingParen(text, i + 1);
      const stop = end === -1 ? text.length : end + 1;
      raw += text.slice(i, stop);
      resolvable = false;
      i = stop;
      continue;
    }

    if (ch === '\\') {
      const next = text[i + 1];
      if (next === undefined) {
        raw += ch;
        resolvable = false;
        i += 1;
        continue;
      }
      raw += text.slice(i, i + 2);
      value += next;
      i += 2;
      continue;
    }

    raw += ch;
    if (UNRESOLVABLE_CHARS.test(ch)) {
      resolvable = false;
    } else {
      value += ch;
    }
    i += 1;
  }

  flush(text.length);
  return tokens;
}

/**
 * 二重引用符の内側をリテラル値へ解決する。展開が残るなら null。
 *
 * bash の規則: `"` の中で `\` が特別なのは `$` `` ` `` `"` `\` と改行の前だけで、それ以外の
 * `\x` は `\` ごとリテラル。`*` `?` はリテラル。裸の `$` / `` ` `` があれば展開されるので未確定。
 */
export function resolveDoubleQuoted(inner) {
  let out = '';
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === '\\') {
      const next = inner[i + 1];
      if (next === undefined) {
        out += ch;
        continue;
      }
      if (next === '\n') {
        i += 1;
        continue;
      }
      if (next === '$' || next === '`' || next === '"' || next === '\\') {
        out += next;
        i += 1;
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '$' || ch === '`') {
      return null;
    }
    out += ch;
  }
  return out;
}

/** `"` から始まる範囲を、内側の `$( … )` を丸ごと 1 つとして数えながら閉じ `"` まで読む。 */
function scanDoubleQuoted(text, start) {
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '$' && text[i + 1] === '(') {
      const end = findMatchingParen(text, i + 1);
      if (end === -1) {
        return null;
      }
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      return { end: i, inner: text.slice(start + 1, i) };
    }
    i += 1;
  }
  return null;
}

/** `(` の位置から対応する `)` を探す。見つからなければ -1。 */
function findMatchingParen(text, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    if (text[i] === '(') {
      depth += 1;
    } else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}
