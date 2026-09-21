// bdboard-sso1.46: commit-message-guard.mjs から move-only 分割。パーサ失敗の判定 (「判定」節)。
// check-commit-parse.mjs への動的 import は分割によりディレクトリが1段深くなった分だけ
// './check-commit-parse.mjs' → '../check-commit-parse.mjs' にパスを直した (指す先の実ファイルは同じ)。
import { extractCommitMessages } from './invocation.mjs';

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
    const module = await import('../check-commit-parse.mjs');
    return module.checkCommitMessage;
  } catch {
    return null;
  }
}
