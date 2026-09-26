// bdboard-sso1.46: commit-message-guard.mjs から move-only 分割。git commit 呼び出しの解釈
// (「コマンドの解釈」節。readInvocation / extractCommitMessages(=Message) / findCommitStarts など)。
import fs from 'node:fs';
import path from 'node:path';

import { MAX_MESSAGE_FILE_BYTES, OVERRIDE_ENV } from './constants.mjs';
import { classifyFlag } from './flags.mjs';
import { extractHeredocs } from './heredoc.mjs';
import { resolveTokenValue } from './resolve-value.mjs';
import { tokenize } from './tokenize.mjs';

/** `git` の後ろ何トークン以内に `commit` があれば commit 呼び出しとみなすか (`git -C <path> commit` 等の吸収)。 */
const GIT_SUBCOMMAND_LOOKAHEAD = 6;

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
 * 再試行するだけで無効化できてしまう (bdboard-harness の scripts/aimix-run.sh が扱う
 * BDBOARD_ROUTE_OVERRIDE と同じ理由・同じ形)。heredoc 本文は residual から抜けているので、
 * そこからも届かない。
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
