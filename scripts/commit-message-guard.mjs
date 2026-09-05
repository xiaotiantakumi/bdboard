// bdboard-ekj3: 括弧が行をまたぐコミットメッセージを「書いた瞬間」に弾く PreToolUse(Bash) ガード。
//
// 背景: release-please が使う @conventional-commits/parser は、本文で開いた `(` が同じ行で
// 閉じないと落ちる。落ちたコミットは CHANGELOG から黙って消え、タグを切ると永久に戻らない
// (詳細は scripts/check-commit-parse.mjs の冒頭)。この禁止は文章としては docs/VERIFY.md に
// 書いてあるが機械的な強制が無く、規律を書いた後にも 59498fa が main に入った。
//
// 既存の検知層との関係:
//   - `npm run check:commits` (main push): v<last>..HEAD。最後の砦だが、気づくのはマージ後。
//   - 同 PR 分岐 (bdboard-qhsb): base..head。ただし **CHANGELOG 対象の type だけ** を失敗に
//     する設計なので、59498fa のような test(...) は warning 止まりで PR を通ってしまった。
//   - このガード: type を問わず、commit コマンドが走る前に止める。3 層目であり置き換えではない。
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
//   実際にパーサが落ちるのは 40 件 (10.4%) で、うち 38 件が括弧の行またぎ。誤検知ゼロで狙った
//   ものだけ止めるには、release-please と同じパーサをそのまま通すしかない。
//
// 契約: stdin に Claude Code の hook 入力 JSON。deny は exit 2 + stderr、allow は exit 0 で無出力。
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
 */
export function extractHeredocs(command) {
  const lines = command.split('\n');
  const heredocs = [];
  const residual = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    residual.push(line);
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
// 展開・グロブが絡むと最終的な文字列を確定できない。1 文字でも混ざればそのトークンは未確定扱い。
const UNRESOLVABLE_CHARS = /[$`*?\\]/;

/**
 * residual を「シェルのトークン」へ割る。各トークンは raw (元の綴り) と value
 * (確定できたリテラル値、確定できなければ null) を持つ。
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

  const flush = () => {
    if (started) {
      tokens.push({ raw, value: resolvable ? value : null });
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
      flush();
      i += 1;
      continue;
    }

    if (OPERATOR_CHARS.has(ch)) {
      flush();
      tokens.push({ raw: ch, value: null, operator: true });
      i += 1;
      continue;
    }

    started = true;

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
      if (UNRESOLVABLE_CHARS.test(scanned.inner)) {
        resolvable = false;
      } else {
        value += scanned.inner;
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

    raw += ch;
    if (UNRESOLVABLE_CHARS.test(ch)) {
      resolvable = false;
    } else {
      value += ch;
    }
    i += 1;
  }

  flush();
  return tokens;
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
  const heredoc = heredocs.find((item) => item.delimiter === delimiter && item.closed);
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
 * `git commit` 呼び出しから、実際に記録されるメッセージを組み立てる。
 *
 * 返り値の status:
 *   - `none`        : commit ではない / メッセージ指定が無い (エディタ・--amend --no-edit・
 *                     -C <sha> による再利用など)。既存コミットの再利用はここに落ちるので、
 *                     解析不能な過去コミットを触っても新規に落ちることはない。
 *   - `unresolvable`: commit だが最終的な文字列を確定できない ($VAR・引用符の閉じ忘れ・
 *                     読めない -F など)。
 *   - `resolved`    : message を確定できた。判定対象。
 */
export function extractCommitMessage(command, options = {}) {
  const readFile = options.readFile ?? ((filePath) => fs.readFileSync(filePath, 'utf8'));
  const cwd = options.cwd ?? process.cwd();

  const { heredocs, residual } = extractHeredocs(command);
  // 閉じていない heredoc がある = 行の切り出しがどこかでずれている。解釈を続けない。
  if (heredocs.some((item) => !item.closed)) {
    return { status: 'unresolvable', reason: 'unterminated-heredoc' };
  }

  const tokens = tokenize(residual);
  const commitStart = findCommitStart(tokens);
  if (commitStart === -1) {
    return { status: 'none' };
  }

  if (hasOverride(tokens, commitStart)) {
    return { status: 'none', reason: 'override' };
  }

  const messages = [];
  let filePath = null;
  let unresolvable = false;

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
        unresolvable = true;
        break;
      }
    }

    const resolved = resolveTokenValue(valueToken, heredocs);
    if (flag.kind === 'message') {
      if (resolved == null) {
        unresolvable = true;
        break;
      }
      messages.push(resolved);
    } else {
      // -F -: 標準入力。heredoc がちょうど 1 本ならそれが本文。
      if (resolved === '-') {
        const usable = heredocs.filter((item) => item.quoted && item.closed);
        if (usable.length !== 1) {
          unresolvable = true;
          break;
        }
        messages.push(usable[0].body);
      } else if (resolved == null) {
        unresolvable = true;
        break;
      } else {
        filePath = resolved;
      }
    }
  }

  if (unresolvable) {
    return { status: 'unresolvable', reason: 'unreadable-argument' };
  }

  if (filePath != null) {
    const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
    try {
      return { status: 'resolved', message: readFile(absolute), source: `-F ${filePath}` };
    } catch {
      // まだ書かれていない一時ファイル等。読めないなら判定しない。
      return { status: 'unresolvable', reason: 'unreadable-file' };
    }
  }

  if (messages.length === 0) {
    return { status: 'none' };
  }

  // git は複数の -m を空行で連結する。判定対象は実際に記録される形でなければ意味が無い。
  return { status: 'resolved', message: messages.join('\n\n'), source: '-m' };
}

/** `git` … `commit` の並びを探し、`commit` トークンの位置を返す。 */
function findCommitStart(tokens) {
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
        return j;
      }
    }
  }
  return -1;
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
function classifyFlag(token) {
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

  // 短縮フラグの束 (-am / -sm など)。m / F は値を取るので、束の中では最後に来る。
  const bundle = spelling.slice(1);
  const messageAt = bundle.indexOf('m');
  const fileAt = bundle.indexOf('F');
  if (messageAt === -1 && fileAt === -1) {
    return null;
  }
  const first = messageAt === -1 ? fileAt : fileAt === -1 ? messageAt : Math.min(messageAt, fileAt);
  const kind = first === messageAt ? 'message' : 'file';
  const rest = bundle.slice(first + 1);
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

/**
 * コマンド 1 本を評価する。`checkCommitMessage` は release-please が使う本物のパーサなので、
 * ここで deny するのは `npm run check:commits` が解析不能と呼ぶものと厳密に同じ集合。
 *
 * fail-open: メッセージを確定できないとき / パーサを読み込めないとき / 例外が出たときは allow。
 */
export async function evaluateCommand(command, options = {}) {
  if (typeof command !== 'string' || command.trim().length === 0) {
    return { verdict: 'allow', reason: 'empty-command' };
  }

  const extracted = extractCommitMessage(command, options);
  if (extracted.status !== 'resolved') {
    return { verdict: 'allow', reason: extracted.reason ?? extracted.status };
  }

  // `??` ではなく所有プロパティで分岐する。テストが「パーサを読み込めない」状態を
  // 明示的な null で表現できないと、fail-open の枝が一度も実行されないまま緑になる。
  const checkCommitMessage = Object.hasOwn(options, 'checkCommitMessage')
    ? options.checkCommitMessage
    : await loadChecker();
  if (checkCommitMessage == null) {
    return { verdict: 'allow', reason: 'parser-unavailable' };
  }

  const parsed = checkCommitMessage(extracted.message);
  if (parsed.ok) {
    return { verdict: 'allow', reason: 'parsable' };
  }

  return { verdict: 'deny', message: extracted.message, ...parsed };
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

export function formatDenial(result, helpers) {
  const { caretLine, escapeControlChars } = helpers;
  const lines = result.message.split('\n');
  const lineText =
    result.line != null && result.line >= 1 && result.line <= lines.length
      ? lines[result.line - 1]
      : '';
  const location =
    result.line != null && result.column != null ? `${result.line}:${result.column}` : '(位置不明)';

  return [
    'commit-guard: このコミットメッセージは release-please と同じパーサで解析できません (bdboard-ekj3)。',
    `commit-guard:   ${location} — ${escapeControlChars(result.parserMessage)}`,
    lineText ? `commit-guard:   ${lineText}` : '',
    caretLine(lineText, result.column) ? `commit-guard:   ${caretLine(lineText, result.column)}` : '',
    'commit-guard:   直し方: 本文で開いた `(` は同じ行の中で閉じる。行をまたぐと release-please がこのコミットを CHANGELOG から丸ごと落とし、タグを切ると永久に戻せません。',
    `commit-guard:   どうしてもこの本文で commit するなら ${OVERRIDE_ENV}="<理由>" を git の前に置いてください。`,
  ].filter(Boolean);
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
  if (result.verdict !== 'deny') {
    return EXIT_ALLOW;
  }

  let helpers;
  try {
    const module = await import('./check-commit-parse.mjs');
    helpers = { caretLine: module.caretLine, escapeControlChars: module.escapeControlChars };
  } catch {
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
