// bdboard-ekj3: 「閉じない `(`」を含むコミットメッセージを、書いた瞬間に弾く PreToolUse(Bash) ガード。
//
// 背景: release-please が使う @conventional-commits/parser は、直前の語にくっついた `(`
// (`採った(縦積み` のような形) をスコープの開始として読む。対応する `)` が同じ行に来ないと
// PEG が改行で落ち、そのコミットは CHANGELOG から黙って消える。タグを切ると永久に戻らない
// (詳細は scripts/check-commit-parse.mjs の冒頭)。開き括弧の前に半角スペースが 1 つあれば
// スコープとして読まれないので落ちない — つまり著者からは何が違うのか見えない罠である。
//
// この規約が今までどこにあったか: AGENTS.md にも CLAUDE.md にも docs/VERIFY.md にも無く、
// check-commit-parse.mjs が失敗時に出す実行時文字列と bd memory
// (2026-09-04-bdboard-commit-msg-paren-newline) にしかなかった。つまり「破ってから初めて
// 読む」文章で、規律として最初から弱い。その状態で 59498fa が main に入っている。
//
// このフックが見ているもの (CI の 2 層との違い):
//   - `npm run check:commits` (main push): タグ以降の main。**squash 後の 1 コミット**しか見ない。
//   - 同 PR 分岐 (bdboard-qhsb): base..head。ただし **CHANGELOG 対象の type だけ** を失敗に
//     する設計なので、59498fa のような test(...) は warning 止まりで PR を通ってしまった。
//   - このガード: **ローカルで書かれる全コミット**を、squash される前・type を問わず、
//     `git commit` が走る前に見る。見ている対象が CI と違うので置き換えではなく前倒しの層。
//
// なぜ git の commit-msg hook ではないのか (bdboard-ekj3 の設計判断):
//   このリポジトリは core.hooksPath を beads (.beads/hooks) に取られている。commit-msg を
//   足すには .beads/hooks へ書く (bd init が再生成する領域・PR で触れない) か core.hooksPath を
//   付け替える (共有 .git config なので、メインチェックアウトと全 worktree の beads hook 5 本が
//   同時に無効化される) しかない。どちらも代償が大きすぎるうえ、clone ごとの install 手順も要る。
//
// なぜ判定を正規表現ではなく本物のパーサでやるのか:
//   「行末に閉じない `(` がある行」を字句的に弾く案を実測した結果、main の 383 コミット中 198 件
//   (52%) が該当した。日本語の本文は括弧付きの補足を普通に折り返すので、字句規則では実用にならない。
//   実際にパーサが落ちるのは 40 件 (10.4%) で、うち 38 件が閉じない `(`。誤検知ゼロで狙った
//   ものだけ止めるには、release-please と同じパーサをそのまま通すしかない。
//   ただし 10.4% は allowlist 導入前の古い履歴を含む main 全体の数字で、日常の発火率ではない。
//   リリース対象範囲 v0.1.2..HEAD の 130 コミットで測ると解析不能は 2 件 (1.5%) しかなく、
//   うち 1 件は既に allowlist 済み。**普段はほぼ発火しない前提**のガードである。
//
// deny する範囲 (ここを広げないこと):
//   パーサの失敗のうち **「閉じ `)` を待っている状態で落ちたもの」だけ** を deny する。
//   エラー文の `valid tokens [)]` がその状態を表し、この状態になるのは `(` をスコープとして
//   食った後だけなので「閉じない `(` がある」と同義。main の解析不能 40 件のうち 38 件がこれで、
//   内訳は改行で落ちたもの 35 件・入れ子の `(` で落ちたもの 3 件。残り 2 件は件名が
//   conventional でない (`bd/bdboard 3tw.149 (#83)`) 別クラスで、allow + 1 行警告に倒す。
//   `wip` / `Revert "…"` / `Merge branch …` / `fixup!` / 空メッセージも同じく allow + 警告。
//   理由: このガードが存在するのは「著者に見えない不可逆な罠」を止めるためで、`wip` と打った
//   人はそれを自覚している。全 worktree の全 Bash 呼び出しに挟まるフックを conventional-commit の
//   スタイル強制装置へ広げると、override を常設させて本来の用途ごと無効化させることになる。
//
// 既知の限界 (指摘 m5): コマンド行に `git commit -m '<閉じない括弧>'` という文字列が現れれば、
//   それが実行ではなく言及 (`echo git commit -m '…'` や grep のパターン) でも deny する。
//   言及と実行を分けるにはトークナイザが意図的に持っていないシェル意味論が要るため、
//   override で通す運用に倒している。頻度が低いことは確認済み。
//
// 契約: stdin に Claude Code の hook 入力 JSON。deny は exit 2 + stderr、allow は exit 0。
// allow でも stderr に 1 行だけ出すことがある (括弧以外の解析失敗の警告 / override の使用痕跡)。
// 判定できないものはすべて allow に倒す (fail-open) — ガードが壊れて commit できなくなるより、
// 従来どおり CI の 2 層に戻る方が安全。fail-open の条件は下の各関数に個別に書いてある。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** 理由付きで 1 回だけガードを外すためのエスケープハッチ。理由が空なら外れない。 */
export const OVERRIDE_ENV = 'BDBOARD_COMMIT_GUARD_OVERRIDE';

const EXIT_ALLOW = 0;
const EXIT_DENY = 2;

/** `git` の後ろ何トークン以内に `commit` があれば commit 呼び出しとみなすか (`git -C <path> commit` 等の吸収)。 */
const GIT_SUBCOMMAND_LOOKAHEAD = 6;

/** `-F <file>` で読み込むメッセージファイルの上限 (指摘 m6)。超えたら読まずに fail-open。 */
export const MAX_MESSAGE_FILE_BYTES = 1024 * 1024;

// --- heredoc ---

// `<<` のみ。`<<<` (here-string) と紛れないよう前後を除外する。`<<<'EOF'` は 2 文字目からでも
// `<<'EOF'` に一致してしまうので、後読みまで付けないと here-string を heredoc と誤読する。
const HEREDOC_OPENER_RE =
  /(?<!<)<<(?!<)(-?)\s*(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))/g;

/**
 * コマンド文字列から heredoc の本文を切り出し、本文を除いた残り (residual) を返す。
 *
 * Claude Code が書く commit は `git commit -m "$(cat <<'EOF' … EOF)"` が常態で、本文には
 * `;` `|` `&` `"` が普通に含まれる。先に本文を抜いておかないと、後段のトークナイズが本文の
 * 記号でめちゃくちゃになる。抜いた本文はそのままメッセージ候補になる。
 *
 * 各 heredoc は `openerOffset` (residual の中で `<<` が現れる位置) を持つ。これが無いと
 * 「どの heredoc がどのコマンドに属するか」が分からず、`-F -` が無関係な heredoc の本文を
 * 掴んでしまう (指摘 m1)。
 */
export function extractHeredocs(command) {
  const lines = command.split('\n');
  const heredocs = [];
  const residual = [];
  let index = 0;
  // residual.join('\n') の中での、いま push する行の先頭オフセット。
  let residualOffset = 0;

  while (index < lines.length) {
    const line = lines[index];
    const lineStart = residualOffset;
    residual.push(line);
    residualOffset += line.length + 1;
    index += 1;

    const openers = [];
    HEREDOC_OPENER_RE.lastIndex = 0;
    let match;
    while ((match = HEREDOC_OPENER_RE.exec(line)) !== null) {
      openers.push({
        delimiter: match[2] ?? match[3] ?? match[4],
        // 区切り語を引用符で囲むと展開が起きない = 本文がそのままメッセージ。囲まない場合は
        // $VAR や $(…) が後で展開されるので、本文を最終形として扱ってはいけない。
        quoted: match[2] !== undefined || match[3] !== undefined,
        stripTabs: match[1] === '-',
        openerOffset: lineStart + match.index,
      });
    }

    // 同じ行に複数の heredoc があれば、本文は開いた順に並ぶ (シェルの仕様)。
    for (const opener of openers) {
      const body = [];
      let closed = false;
      while (index < lines.length) {
        const raw = lines[index];
        const candidate = opener.stripTabs ? raw.replace(/^\t+/, '') : raw;
        index += 1;
        if (candidate === opener.delimiter) {
          closed = true;
          break;
        }
        body.push(candidate);
      }
      heredocs.push({ ...opener, body: body.join('\n'), closed });
    }
  }

  return { heredocs, residual: residual.join('\n') };
}

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

// --- 値の解決 ---

// `-m "$(cat <<'EOF' … )"` の外枠。residual では開き行と `)"` の行に分かれているので改行を
// 潰してから当てる。`cat` 以外 (sed 等を挟む形) は最終形が読めないので一致させない。
const CAT_HEREDOC_RE =
  /^"?\$\(\s*cat\s*<<-?\s*(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))\s*\)"?$/;

/**
 * トークン 1 個をメッセージ文字列へ解決する。確定できなければ null (= fail-open)。
 *
 * heredoc は「区切り語が一致するもの」ではなく「このトークンの綴りの中で開かれたもの」を選ぶ。
 * 同じ区切り語の heredoc が別のコマンドにもあるとき、名前だけで引くと他人の本文を掴む。
 */
export function resolveTokenValue(token, heredocs) {
  if (token == null) {
    return null;
  }
  if (token.value != null) {
    return token.value;
  }

  const flattened = token.raw.replace(/\n/g, '');
  const match = CAT_HEREDOC_RE.exec(flattened);
  if (match == null) {
    return null;
  }
  const delimiter = match[1] ?? match[2] ?? match[3];
  const candidates = heredocs.filter((item) => item.delimiter === delimiter && item.closed);
  const heredoc =
    token.start == null
      ? candidates[0]
      : candidates.find(
          (item) => item.openerOffset >= token.start && item.openerOffset < (token.end ?? Infinity),
        );
  // 区切り語が引用されていない heredoc は後で展開されるので、本文を最終形として扱えない。
  if (heredoc == null || !heredoc.quoted) {
    return null;
  }
  return heredoc.body;
}

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

/**
 * `git commit` 呼び出し 1 件から、実際に記録されるメッセージを組み立てる。
 *
 * 返り値の status:
 *   - `none`        : メッセージ指定が無い (エディタ・--amend --no-edit・-C <sha> による
 *                     再利用など)。既存コミットの再利用はここに落ちるので、解析不能な
 *                     過去コミットを touch しても新規に落ちることはない。
 *   - `unresolvable`: commit だが最終的な文字列を確定できない ($VAR・引用符の閉じ忘れ・
 *                     読めない -F など)。
 *   - `resolved`    : message を確定できた。判定対象。
 */
function readInvocation(tokens, commitStart, heredocs, residual, ctx) {
  const override = hasOverride(tokens, commitStart);
  const segment = commandSegment(tokens, commitStart, residual.length);

  const messages = [];
  let filePath = null;
  let unresolvable = null;

  for (let i = commitStart + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.operator) {
      break;
    }
    const flag = classifyFlag(token);
    if (flag == null) {
      continue;
    }

    let valueToken = null;
    if (flag.attached != null) {
      valueToken = { raw: flag.attached, value: flag.attachedValue };
    } else {
      i += 1;
      valueToken = tokens[i];
      if (valueToken == null || valueToken.operator) {
        unresolvable = 'missing-argument';
        break;
      }
    }

    const resolved = resolveTokenValue(valueToken, heredocs);
    if (flag.kind === 'message') {
      if (resolved == null) {
        unresolvable = 'unreadable-argument';
        break;
      }
      messages.push(resolved);
    } else if (resolved === '-') {
      // -F -: 標準入力。この commit と同じ simple command の中で開かれた heredoc が
      // ちょうど 1 本ならそれが本文。他のコマンドへ向いた heredoc は拾わない (指摘 m1)。
      const usable = heredocs.filter(
        (item) =>
          item.quoted &&
          item.closed &&
          item.openerOffset >= segment.start &&
          item.openerOffset < segment.end,
      );
      if (usable.length !== 1) {
        unresolvable = 'ambiguous-stdin-heredoc';
        break;
      }
      messages.push(usable[0].body);
    } else if (resolved == null) {
      unresolvable = 'unreadable-argument';
      break;
    } else {
      filePath = resolved;
    }
  }

  if (unresolvable != null) {
    return { status: 'unresolvable', reason: unresolvable, override };
  }

  if (filePath != null) {
    const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(ctx.cwd, filePath);
    try {
      return {
        status: 'resolved',
        message: ctx.readFile(absolute),
        source: `-F ${filePath}`,
        override,
      };
    } catch {
      // まだ書かれていない一時ファイル / 通常ファイルでない / 大きすぎる。読めないなら判定しない。
      return { status: 'unresolvable', reason: 'unreadable-file', override };
    }
  }

  if (messages.length === 0) {
    return { status: 'none', override };
  }

  // git は複数の -m を空行で連結する。判定対象は実際に記録される形でなければ意味が無い。
  return { status: 'resolved', message: messages.join('\n\n'), source: '-m', override };
}

/**
 * コマンド文字列に含まれる **すべての** `git commit` 呼び出しを解釈する。
 *
 * `git commit -m 'ok' && git commit -m '<閉じない括弧>'` のように 1 回の Bash 呼び出しで
 * 複数コミットするのは日常的な形で、最初の 1 件しか見ないと 2 件目が素通りする (指摘 m2)。
 */
export function extractCommitMessages(command, options = {}) {
  const readFile = options.readFile ?? defaultReadMessageFile;
  const cwd = options.cwd ?? process.cwd();

  const { heredocs, residual } = extractHeredocs(command);
  // 閉じていない heredoc がある = 行の切り出しがどこかでずれている。解釈を続けない。
  if (heredocs.some((item) => !item.closed)) {
    return [{ status: 'unresolvable', reason: 'unterminated-heredoc', override: false }];
  }

  const tokens = tokenize(residual);
  const starts = findCommitStarts(tokens);
  if (starts.length === 0) {
    return [];
  }
  return starts.map((start) => readInvocation(tokens, start, heredocs, residual, { readFile, cwd }));
}

/** 先頭 1 件だけを返す薄いラッパー。単一呼び出しを検証するテストと外部利用のため。 */
export function extractCommitMessage(command, options = {}) {
  return extractCommitMessages(command, options)[0] ?? { status: 'none', override: false };
}

/** `-F <file>` の既定の読み手。通常ファイルで、上限サイズ以内のときだけ読む (指摘 m6)。 */
function defaultReadMessageFile(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    // FIFO / デバイス / ディレクトリ。読むと固まりうるので触らない。
    throw new Error(`not a regular file: ${filePath}`);
  }
  if (stat.size > MAX_MESSAGE_FILE_BYTES) {
    throw new Error(`message file too large: ${stat.size} bytes`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

/** `git` … `commit` の並びをすべて探し、`commit` トークンの位置を昇順で返す。 */
export function findCommitStarts(tokens) {
  const starts = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const value = tokens[i].value;
    if (value == null) {
      continue;
    }
    if (value !== 'git' && !value.endsWith('/git')) {
      continue;
    }
    const limit = Math.min(tokens.length, i + 1 + GIT_SUBCOMMAND_LOOKAHEAD);
    for (let j = i + 1; j < limit; j += 1) {
      if (tokens[j].operator) {
        break;
      }
      if (tokens[j].value === 'commit') {
        if (!starts.includes(j)) {
          starts.push(j);
        }
        break;
      }
    }
  }
  return starts;
}

/** commit を含む simple command が residual 上で占める範囲 (演算子で区切られた 1 区画)。 */
function commandSegment(tokens, commitStart, residualLength) {
  let start = tokens[commitStart].start ?? 0;
  for (let i = commitStart - 1; i >= 0; i -= 1) {
    if (tokens[i].operator) {
      break;
    }
    start = tokens[i].start ?? start;
  }
  let end = residualLength;
  for (let i = commitStart + 1; i < tokens.length; i += 1) {
    if (tokens[i].operator) {
      end = tokens[i].start ?? end;
      break;
    }
  }
  return { start, end };
}

/**
 * エスケープハッチの検出。**`git` より前の同一セグメントに置かれた代入だけ** を見る。
 *
 * コマンド全体の部分一致にすると、コミットメッセージ本文にこの変数名を書くだけでガードが
 * 外れる。しかも下の deny 文言自身がこの名前を含むので、deny をそのまま本文へ貼り付けて
 * 再試行するだけで無効化できてしまう (pre-bash-guard 規則 6 の BDBOARD_ROUTE_OVERRIDE と
 * 同じ理由・同じ形)。heredoc 本文は residual から抜けているので、そこからも届かない。
 */
function hasOverride(tokens, commitStart) {
  const fromEnv = process.env[OVERRIDE_ENV];
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    return true;
  }
  for (let i = commitStart - 1; i >= 0; i -= 1) {
    const token = tokens[i];
    if (token.operator) {
      break;
    }
    if (token.value != null && token.value.startsWith(`${OVERRIDE_ENV}=`)) {
      if (token.value.slice(OVERRIDE_ENV.length + 1).trim().length > 0) {
        return true;
      }
    }
  }
  return false;
}

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

// --- 判定 ---

// パーサが「次に来られるのは閉じ `)` だけ」という状態で落ちたことを表す。この状態になるのは
// `(` をスコープ開始として食った後だけなので、`valid tokens [)]` = 閉じない `(` がある、と読める。
const PAREN_SCOPE_RE = /,\s*valid tokens \[\)\]\s*$/;
const UNEXPECTED_TOKEN_RE = /^unexpected token (?:EOF|'([\s\S]*?)') at \d+:\d+/;

/**
 * パーサの失敗が「閉じない `(`」由来かを判定する。deny してよいのはこれだけ。
 *
 * 返り値 (main の解析不能 40 件での実測内訳):
 *   - `across-lines` : 改行で落ちた。`)` が次の行以降にある。35 件。
 *   - `nested`       : 内側の `(` で落ちた (`なっている(clear() の…)`)。3 件。
 *   - `unclosed`     : 最後まで `)` が来なかった (EOF)。履歴上は 0 件だが構造的に起こりうる。
 *   - `null`         : 括弧由来ではない (件名が conventional でない、空、`wip` など)。2 件。allow。
 */
export function classifyParseFailure(parsed, message) {
  if (parsed == null || parsed.ok) {
    return null;
  }
  const text = typeof parsed.parserMessage === 'string' ? parsed.parserMessage : '';
  if (!PAREN_SCOPE_RE.test(text)) {
    return null;
  }
  // 念のための不変条件。`(` を 1 つも含まないメッセージが括弧スコープで落ちることは構造上
  // ありえないが、そうなったらパーサ側の前提が変わったということなので deny しない。
  if (typeof message === 'string' && !message.includes('(')) {
    return null;
  }
  const match = UNEXPECTED_TOKEN_RE.exec(text);
  if (match == null) {
    return 'unclosed';
  }
  if (match[1] === '\n') {
    return 'across-lines';
  }
  if (match[1] === '(') {
    return 'nested';
  }
  return 'unclosed';
}

/**
 * コマンド 1 本を評価する。`checkCommitMessage` は release-please が使う本物のパーサなので、
 * ここで見ているのは `npm run check:commits` が解析不能と呼ぶものと厳密に同じ集合。
 * そのうち deny するのは `classifyParseFailure` が括弧由来と判定したものだけ。
 *
 * fail-open: メッセージを確定できないとき / パーサを読み込めないとき / パーサや解釈が
 * 想定外の例外を投げたとき / 失敗が括弧由来でないとき は allow。
 */
export async function evaluateCommand(command, options = {}) {
  if (typeof command !== 'string' || command.trim().length === 0) {
    return { verdict: 'allow', reason: 'empty-command' };
  }

  let invocations;
  try {
    invocations = extractCommitMessages(command, options);
  } catch {
    return { verdict: 'allow', reason: 'extract-threw' };
  }
  const resolved = invocations.filter((item) => item.status === 'resolved');
  if (resolved.length === 0) {
    const first = invocations[0];
    return { verdict: 'allow', reason: first?.reason ?? first?.status ?? 'none' };
  }

  // `??` ではなく所有プロパティで分岐する。テストが「パーサを読み込めない」状態を
  // 明示的な null で表現できないと、fail-open の枝が一度も実行されないまま緑になる。
  const checkCommitMessage = Object.hasOwn(options, 'checkCommitMessage')
    ? options.checkCommitMessage
    : await loadChecker();
  if (checkCommitMessage == null) {
    return { verdict: 'allow', reason: 'parser-unavailable' };
  }

  let warning = null;
  for (const invocation of resolved) {
    let parsed;
    try {
      parsed = checkCommitMessage(invocation.message);
    } catch {
      return { verdict: 'allow', reason: 'parser-threw' };
    }
    if (parsed.ok) {
      continue;
    }
    const kind = classifyParseFailure(parsed, invocation.message);
    if (kind == null) {
      // 括弧ではないスタイル上の失敗 (`wip` / `Revert "…"` / 空メッセージ等)。書いた本人に
      // 見えている失敗なので止めない。1 行だけ知らせる。
      warning ??= { ...parsed, message: invocation.message };
      continue;
    }
    if (invocation.override) {
      return { verdict: 'allow', reason: 'override', overrode: { ...parsed, kind } };
    }
    return { verdict: 'deny', kind, message: invocation.message, ...parsed };
  }

  if (warning != null) {
    return { verdict: 'allow', reason: 'unparsable-but-not-parens', warning };
  }
  return { verdict: 'allow', reason: 'parsable' };
}

/**
 * パーサの読み込みは実際に必要になってから行う。このフックは全 Bash 呼び出しに挟まるので、
 * 大半を占める commit 以外のコマンドで @conventional-commits/parser の import 代を払わない。
 * npm install 前の worktree では import が失敗するが、その場合も allow に倒す。
 */
async function loadChecker() {
  try {
    const module = await import('./check-commit-parse.mjs');
    return module.checkCommitMessage;
  } catch {
    return null;
  }
}

// --- 出力 ---

const REMEDY = {
  'across-lines': [
    '原因: 直前の語にくっついた `(` をパーサがスコープの開始として読み、閉じ `)` が同じ行に来ていません。',
    '直し方: 開き括弧の前に半角スペースを入れる (`採った(縦積み` → `採った (縦積み`)、または `)` を同じ行の中で閉じる。',
  ],
  nested: [
    '原因: スコープとして開いた `(` の内側にもう一つ `(` があり、そこでパーサが落ちています。',
    '直し方: 外側の開き括弧の前に半角スペースを入れる (`なっている(clear() の…)` → `なっている (clear() の…)`)。',
  ],
  unclosed: [
    '原因: スコープとして開いた `(` が最後まで閉じていません。',
    '直し方: `)` で閉じるか、開き括弧の前に半角スペースを入れる。',
  ],
};

const OVERRIDE_HINT =
  `どうしてもこの本文で commit するなら ${OVERRIDE_ENV}="<理由>" を git と同じコマンドの先頭に置いてください ` +
  `(例: ${OVERRIDE_ENV}="理由" git commit …)。別コマンドの \`export …\` や \`… && git commit\` では効きません。`;

export function formatDenial(result, helpers) {
  const { caretLine, escapeControlChars } = helpers;
  const lines = result.message.split('\n');
  const lineText =
    result.line != null && result.line >= 1 && result.line <= lines.length
      ? lines[result.line - 1]
      : '';
  const location =
    result.line != null && result.column != null ? `${result.line}:${result.column}` : '(位置不明)';
  const remedy = REMEDY[result.kind] ?? REMEDY.unclosed;
  // caretLine は行末で落ちたとき「次の行に持ち越されています」と書く。EOF で落ちた unclosed には
  // 次の行が無いので、その一文は出さない (すぐ下の 原因 行と矛盾する)。
  const caret =
    result.kind === 'unclosed' && result.column > lineText.length
      ? ''
      : caretLine(lineText, result.column);

  return [
    'commit-guard: このコミットメッセージには閉じない `(` があり、release-please と同じパーサで解析できません (bdboard-ekj3)。',
    `commit-guard:   ${location} — ${escapeControlChars(result.parserMessage)}`,
    lineText ? `commit-guard:   ${lineText}` : '',
    caret ? `commit-guard:   ${caret}` : '',
    `commit-guard:   ${remedy[0]}`,
    `commit-guard:   ${remedy[1]}`,
    'commit-guard:   このまま commit すると release-please がこのコミットを CHANGELOG から丸ごと落とし、タグを切ると永久に戻せません。',
    `commit-guard:   ${OVERRIDE_HINT}`,
  ].filter(Boolean);
}

/**
 * allow のまま出す 1 行。括弧以外の解析失敗の警告と、override を実際に使った痕跡。
 * 不可逆ガードを迂回したことは黙って通さない (指摘 n4)。
 */
export function formatNotice(result, helpers) {
  const { escapeControlChars } = helpers;
  if (result.overrode != null) {
    const location =
      result.overrode.line != null && result.overrode.column != null
        ? `${result.overrode.line}:${result.overrode.column}`
        : '(位置不明)';
    return [
      `commit-guard: ${OVERRIDE_ENV} により、閉じない \`(\` を含むコミットメッセージ (${location}) をそのまま通しました (bdboard-ekj3)。`,
    ];
  }
  if (result.warning != null) {
    const location =
      result.warning.line != null && result.warning.column != null
        ? `${result.warning.line}:${result.warning.column}`
        : '(位置不明)';
    return [
      `commit-guard: warning — ${location} ${escapeControlChars(result.warning.parserMessage)} : 括弧の問題ではないので通しますが、CHANGELOG 対象の type ならリリース時に落ちます (bdboard-ekj3)。`,
    ];
  }
  return [];
}

// --- エントリポイント ---

async function main() {
  const input = await readStdin();
  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    return EXIT_ALLOW;
  }

  const toolName = payload?.tool_name;
  if (toolName != null && toolName !== 'Bash') {
    return EXIT_ALLOW;
  }

  const command = payload?.tool_input?.command;
  const cwd = typeof payload?.cwd === 'string' && payload.cwd.length > 0 ? payload.cwd : process.cwd();

  const result = await evaluateCommand(command, { cwd });
  const notable = result.verdict === 'deny' || result.warning != null || result.overrode != null;
  if (!notable) {
    return EXIT_ALLOW;
  }

  let helpers;
  try {
    const module = await import('./check-commit-parse.mjs');
    helpers = { caretLine: module.caretLine, escapeControlChars: module.escapeControlChars };
  } catch {
    return EXIT_ALLOW;
  }

  if (result.verdict !== 'deny') {
    for (const line of formatNotice(result, helpers)) {
      process.stderr.write(`${line}\n`);
    }
    return EXIT_ALLOW;
  }

  for (const line of formatDenial(result, helpers)) {
    process.stderr.write(`${line}\n`);
  }
  return EXIT_DENY;
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
  });
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  // このフックは全 Bash 呼び出しに挟まる。何が起きても「通す」ところまでは必ず戻す。
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`commit-guard: skipped (${error?.message ?? error})\n`);
      process.exitCode = EXIT_ALLOW;
    });
}
