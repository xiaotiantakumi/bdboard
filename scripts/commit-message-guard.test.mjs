import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkCommitMessage } from './check-commit-parse.mjs';
import {
  MAX_MESSAGE_FILE_BYTES,
  OVERRIDE_ENV,
  classifyFlag,
  classifyParseFailure,
  evaluateCommand,
  extractCommitMessage,
  extractCommitMessages,
  extractHeredocs,
  resolveDoubleQuoted,
  resolveTokenValue,
  tokenize,
} from './commit-message-guard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUARD_PATH = path.join(HERE, 'commit-message-guard.mjs');
const FIXTURE_DIR = path.join(HERE, 'fixtures');
const R5WE_FIXTURE = path.join(FIXTURE_DIR, 'commit-r5we-unparsable.txt');
const QS6_FIXTURE = path.join(FIXTURE_DIR, 'commit-6qs6-parsable.txt');

// check-commit-parse.test.mjs と同じ理由: fixture は行:列を再現する検証対象なので、CRLF で
// チェックアウトされた作業ツリーでも桁がずれないよう読み込み側で正規化する。
function readFixture(filePath) {
  return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, '');
}

const UNPARSABLE_MESSAGE = readFixture(R5WE_FIXTURE);
const PARSABLE_MESSAGE = readFixture(QS6_FIXTURE);

// 括弧由来の 3 変種。パーサは「直前の語にくっついた `(`」だけをスコープの開始として読むので、
// 開き括弧の前に半角スペースがあるかどうかで結果が変わる。
const ACROSS_LINES_MESSAGE =
  'feat(bdboard-ekj3): 件名\n\n方針を採った(縦積みは比較という\n価値を失うため)。';
const NESTED_MESSAGE = 'feat(bdboard-ekj3): 件名\n\n設計になっている(clear() のコメントに明記)。';
const UNCLOSED_MESSAGE = 'feat(bdboard-ekj3): 件名\n\n方針を採った(閉じないまま終わる';
// 同じ本文でも開き括弧の前に空白があれば通る。deny の境界がここにあることを固定する。
const SPACED_MESSAGE =
  'feat(bdboard-ekj3): 件名\n\n方針を採った (縦積みは比較という\n価値を失うため)。';

/** Claude Code が実際に書く commit の形。ここを外すとガードは何も守らない。 */
function heredocCommit(message, { prefix = '', delimiter = 'EOF' } = {}) {
  return `${prefix}git commit -m "$(cat <<'${delimiter}'\n${message}\n${delimiter}\n)"`;
}

describe('extractHeredocs', () => {
  it('captures a quoted heredoc body and keeps it out of the residual', () => {
    const { heredocs, residual } = extractHeredocs(
      heredocCommit('subject\n\nbody; with | metachars'),
    );
    expect(heredocs).toHaveLength(1);
    expect(heredocs[0].closed).toBe(true);
    expect(heredocs[0].quoted).toBe(true);
    expect(heredocs[0].body).toBe('subject\n\nbody; with | metachars');
    // 本文の `;` や `|` が residual に残るとトークナイズが壊れる。
    expect(residual).not.toContain('metachars');
  });

  it('does not mistake a here-string for a heredoc', () => {
    const { heredocs } = extractHeredocs("cat <<<'EOF'\nnot a body\n");
    expect(heredocs).toHaveLength(0);
  });

  it('marks an unterminated heredoc as not closed', () => {
    const { heredocs } = extractHeredocs("git commit -m \"$(cat <<'EOF'\nsubject\n");
    expect(heredocs).toHaveLength(1);
    expect(heredocs[0].closed).toBe(false);
  });

  it('strips leading tabs for <<- and records where the opener sits in the residual', () => {
    const command = "git commit -F - <<-'EOF'\n\t\tsubject\n\t\tEOF\n";
    const { heredocs, residual } = extractHeredocs(command);
    expect(heredocs[0].stripTabs).toBe(true);
    expect(heredocs[0].body).toBe('subject');
    // openerOffset は residual 上の `<<` の位置。ここがずれると `-F -` の帰属判定が壊れる。
    expect(residual.slice(heredocs[0].openerOffset, heredocs[0].openerOffset + 2)).toBe('<<');
  });

  it('gives each heredoc its own offset when several commands are chained', () => {
    const command = "cat <<'A'\nfirst\nA\ngit commit -F - <<'B'\nsecond\nB";
    const { heredocs, residual } = extractHeredocs(command);
    expect(heredocs.map((item) => item.delimiter)).toEqual(['A', 'B']);
    for (const heredoc of heredocs) {
      expect(residual.slice(heredoc.openerOffset, heredoc.openerOffset + 2)).toBe('<<');
    }
    expect(heredocs[0].openerOffset).toBeLessThan(heredocs[1].openerOffset);
  });
});

describe('tokenize / resolveTokenValue', () => {
  it('resolves quoted literals and refuses expansions', () => {
    const tokens = tokenize(`git commit -m 'literal' -m "$VAR"`).filter((t) => !t.operator);
    expect(tokens.map((t) => t.value)).toEqual(['git', 'commit', '-m', 'literal', '-m', null]);
  });

  it('resolves a $(cat <<EOF) token back to the heredoc body', () => {
    const command = heredocCommit('hello');
    const { heredocs, residual } = extractHeredocs(command);
    const token = tokenize(residual).find((t) => t.raw.includes('$(cat'));
    expect(resolveTokenValue(token, heredocs)).toBe('hello');
  });

  it('refuses an unquoted heredoc delimiter because the body still expands', () => {
    const command = 'git commit -m "$(cat <<EOF\nhello $USER\nEOF\n)"';
    const { heredocs, residual } = extractHeredocs(command);
    const token = tokenize(residual).find((t) => t.raw.includes('$(cat'));
    expect(resolveTokenValue(token, heredocs)).toBeNull();
  });

  it('picks the heredoc opened inside the token, not another one with the same delimiter', () => {
    // 同じ区切り語の heredoc が先に別コマンドで開かれている。名前だけで引くと他人の本文を掴む。
    const command = `cat <<'EOF' > /dev/null\ndecoy body\nEOF\n${heredocCommit('real body')}`;
    const { heredocs, residual } = extractHeredocs(command);
    const token = tokenize(residual).find((t) => t.raw.includes('$(cat'));
    expect(resolveTokenValue(token, heredocs)).toBe('real body');
  });

  // 指摘 m3: 二重引用符の中で `*` `?` はグロブにならずリテラル。
  it('treats * and ? inside double quotes as literal text', () => {
    const tokens = tokenize('git commit -m "本当に消しますか? 全部*"').filter((t) => !t.operator);
    expect(tokens.at(-1).value).toBe('本当に消しますか? 全部*');
  });

  it('still refuses * and ? outside quotes, where they glob', () => {
    const tokens = tokenize('git commit -m subject?').filter((t) => !t.operator);
    expect(tokens.at(-1).value).toBeNull();
  });

  it.each([
    ['plain text', 'hello world', 'hello world'],
    ['escaped dollar', 'costs \\$5', 'costs $5'],
    ['escaped quote', 'say \\"hi\\"', 'say "hi"'],
    ['non-special backslash stays literal', 'a\\nb', 'a\\nb'],
    ['line continuation disappears', 'a\\\nb', 'ab'],
    ['bare expansion is unresolvable', 'hello $USER', null],
    ['backtick is unresolvable', 'hello `date`', null],
  ])('resolveDoubleQuoted: %s', (_label, inner, expected) => {
    expect(resolveDoubleQuoted(inner)).toBe(expected);
  });

  // 指摘 m4: `\` + 改行はトークンを切らない。
  it('follows a backslash line continuation instead of stopping at the newline', () => {
    const tokens = tokenize("git commit \\\n  -m 'subject'").filter((t) => !t.operator);
    expect(tokens.map((t) => t.value)).toEqual(['git', 'commit', '-m', 'subject']);
  });
});

describe('classifyFlag', () => {
  it.each([
    ['-m', 'message'],
    ['-am', 'message'],
    ['-sam', 'message'],
    ['-F', 'file'],
    ['-aF', 'file'],
    ['--message', 'message'],
    ['--file', 'file'],
  ])('%s is a %s flag', (spelling, kind) => {
    expect(classifyFlag({ raw: spelling, value: spelling })).toMatchObject({ kind });
  });

  // 指摘 M2: 値を取る短縮オプションの後ろはその値。`m` が現れても `-m` ではない。
  it.each(['-Smykey', '-Cmine', '-cmine', '-tmytemplate', '-umode', '-a', '-v', '--amend'])(
    '%s carries no message or file flag',
    (spelling) => {
      expect(classifyFlag({ raw: spelling, value: spelling })).toBeNull();
    },
  );

  it('reads a value attached to the same token', () => {
    expect(classifyFlag({ raw: '-msubject', value: '-msubject' })).toMatchObject({
      kind: 'message',
      attachedValue: 'subject',
    });
  });
});

describe('extractCommitMessage', () => {
  it('reads the heredoc form Claude Code actually uses', () => {
    const result = extractCommitMessage(heredocCommit(UNPARSABLE_MESSAGE));
    expect(result.status).toBe('resolved');
    expect(result.message).toBe(UNPARSABLE_MESSAGE);
  });

  it('joins repeated -m the way git does (blank line between)', () => {
    const result = extractCommitMessage(`git commit -m 'subject' -m 'body'`);
    expect(result).toMatchObject({ status: 'resolved', message: 'subject\n\nbody' });
  });

  it('reads an attached short-flag value and a bundled -am', () => {
    expect(extractCommitMessage(`git commit -m'subject'`)).toMatchObject({ message: 'subject' });
    expect(extractCommitMessage(`git commit -am 'subject'`)).toMatchObject({ message: 'subject' });
  });

  it('reads --message= and --file= with the value glued on', () => {
    expect(extractCommitMessage(`git commit --message='subject'`)).toMatchObject({
      status: 'resolved',
      message: 'subject',
    });
    expect(
      extractCommitMessage(`git commit --file=msg.txt`, {
        cwd: '/repo',
        readFile: () => 'subject from file',
      }),
    ).toMatchObject({ status: 'resolved', message: 'subject from file' });
  });

  it('reads -F <file> from disk', () => {
    const result = extractCommitMessage('git commit -F msg.txt', {
      cwd: '/repo',
      readFile: (filePath) => {
        expect(filePath).toBe(path.resolve('/repo', 'msg.txt'));
        return 'subject from file';
      },
    });
    expect(result).toMatchObject({ status: 'resolved', message: 'subject from file' });
  });

  it('finds git commit behind global options', () => {
    expect(extractCommitMessage(`git -C /repo commit -m 'subject'`)).toMatchObject({
      message: 'subject',
    });
  });

  it('follows a backslash line continuation to the flags on the next line', () => {
    expect(extractCommitMessage("git commit \\\n  -m 'subject'")).toMatchObject({
      status: 'resolved',
      message: 'subject',
    });
  });

  // 指摘 M2 の実害: `-Smykey` の m を `-m` と読むと、本文のどこにも無い "ykey" を判定してしまう。
  it('does not invent a message from -Smykey', () => {
    expect(extractCommitMessage('git commit -Smykey').status).toBe('none');
    expect(extractCommitMessage(`git commit -Smykey -m 'subject'`)).toMatchObject({
      message: 'subject',
    });
  });

  describe('-F - (stdin)', () => {
    it('uses the heredoc opened by the same command', () => {
      expect(extractCommitMessage("git commit -F - <<'EOF'\nsubject\nEOF\n")).toMatchObject({
        status: 'resolved',
        message: 'subject',
      });
    });

    it('uses the <<- form too', () => {
      expect(extractCommitMessage("git commit -F - <<-'EOF'\n\tsubject\n\tEOF\n")).toMatchObject({
        status: 'resolved',
        message: 'subject',
      });
    });

    // 指摘 m1: 別コマンドの heredoc を掴まない。
    it('refuses a heredoc that belongs to an earlier command', () => {
      const command = "cat <<'X'\nnot the commit message\nX\ngit commit -F -";
      expect(extractCommitMessage(command)).toMatchObject({
        status: 'unresolvable',
        reason: 'ambiguous-stdin-heredoc',
      });
    });

    it('picks its own heredoc even when another command opened one first', () => {
      const command = "cat <<'X'\ndecoy\nX\ngit commit -F - <<'Y'\nreal subject\nY";
      expect(extractCommitMessage(command)).toMatchObject({
        status: 'resolved',
        message: 'real subject',
      });
    });
  });

  // --- fail-open が要求される入力 ---

  it.each([
    ['not a commit at all', 'git status --porcelain'],
    ['message comes from a variable', 'git commit -m "$MSG"'],
    ['message comes from an unrelated substitution', 'git commit -m "$(build_message)"'],
    ['no message flag (editor)', 'git commit'],
    ['amend without a new message', 'git commit --amend --no-edit'],
    ['reuses an existing commit message', 'git commit -C 59498fa'],
    ['cherry-pick of an existing commit', 'git cherry-pick 59498fa'],
    ['unterminated heredoc', "git commit -m \"$(cat <<'EOF'\nsubject\n"],
    ['unreadable -F target', 'git commit -F /nonexistent/definitely-not-here.txt'],
    ['-F with nothing after it', 'git commit -F'],
  ])('does not claim a message for %s', (_label, command) => {
    expect(extractCommitMessage(command).status).not.toBe('resolved');
  });
});

// 指摘 m2: 1 回の Bash 呼び出しに複数の commit が並ぶ形。
describe('extractCommitMessages', () => {
  it('reads every git commit in a && chain', () => {
    const command = `git add -A && git commit -m 'first' && git commit -m 'second'`;
    expect(extractCommitMessages(command).map((item) => item.message)).toEqual(['first', 'second']);
  });

  it('reads commits separated by a semicolon', () => {
    const command = `git commit -m 'first'; git commit -m 'second'`;
    expect(extractCommitMessages(command)).toHaveLength(2);
  });

  it('returns nothing when there is no commit at all', () => {
    expect(extractCommitMessages('npm run verify')).toEqual([]);
  });
});

describe('classifyParseFailure', () => {
  it.each([
    ['paren opened on one line, closed on the next', ACROSS_LINES_MESSAGE, 'across-lines'],
    ['nested paren inside a scope paren', NESTED_MESSAGE, 'nested'],
    ['paren never closed', UNCLOSED_MESSAGE, 'unclosed'],
    ['the r5we fixture', UNPARSABLE_MESSAGE, 'across-lines'],
  ])('classifies %s as %s', (_label, message, kind) => {
    const parsed = checkCommitMessage(message);
    expect(parsed.ok).toBe(false);
    expect(classifyParseFailure(parsed, message)).toBe(kind);
  });

  // M1: 括弧以外の解析失敗は deny 対象ではない。ここを広げるとスタイル強制装置になる。
  it.each([
    ['wip', 'wip'],
    ['empty message', ''],
    ['revert', 'Revert "feat(x): y"\n\nThis reverts commit abc1234.'],
    ['merge branch', "Merge branch 'main' into feature/x"],
    ['merge pull request', 'Merge pull request #12 from foo/bar'],
    ['fixup', 'fixup! feat(x): y'],
    ['squash', 'squash! feat(x): y'],
    ['prose subject', 'update the readme'],
    ['non-conventional subject with a paren', 'bd/bdboard 3tw.149 (#83)'],
  ])('does not classify %s as a paren failure', (_label, message) => {
    const parsed = checkCommitMessage(message);
    expect(parsed.ok).toBe(false);
    expect(classifyParseFailure(parsed, message)).toBeNull();
  });

  it('refuses to classify a paren failure for a message with no ( at all', () => {
    const parsed = {
      ok: false,
      line: 1,
      column: 1,
      parserMessage: 'unexpected token EOF at 1:1, valid tokens [)]',
    };
    expect(classifyParseFailure(parsed, 'no parens here')).toBeNull();
  });
});

describe('evaluateCommand', () => {
  it('denies the unparsable fixture written through the heredoc form', async () => {
    const result = await evaluateCommand(heredocCommit(UNPARSABLE_MESSAGE));
    expect(result.verdict).toBe('deny');
    expect(result.kind).toBe('across-lines');
    expect(result.line).toBe(74);
    expect(result.column).toBe(37);
  });

  it('allows the parsable fixture written the same way', async () => {
    const result = await evaluateCommand(heredocCommit(PARSABLE_MESSAGE));
    expect(result.verdict).toBe('allow');
    expect(result.reason).toBe('parsable');
  });

  it.each([
    ['paren across lines', ACROSS_LINES_MESSAGE, 'across-lines'],
    ['nested paren', NESTED_MESSAGE, 'nested'],
    ['paren never closed', UNCLOSED_MESSAGE, 'unclosed'],
  ])('denies %s', async (_label, message, kind) => {
    const result = await evaluateCommand(heredocCommit(message));
    expect(result.verdict).toBe('deny');
    expect(result.kind).toBe(kind);
  });

  it('allows the same body once the opening paren has a space in front of it', async () => {
    expect((await evaluateCommand(heredocCommit(SPACED_MESSAGE))).verdict).toBe('allow');
  });

  it('allows a message whose parentheses close on the same line', async () => {
    const message =
      'fix(bdboard-ekj3): 括弧を行内で閉じる\n\n本文で開いた (括弧) は同じ行で閉じている。\n';
    expect((await evaluateCommand(`git commit -m '${message}'`)).verdict).toBe('allow');
  });

  // M1: 括弧以外の解析失敗は通す。書いた本人に見えている失敗まで止めない。
  it.each([
    ['wip', 'wip'],
    ['revert', 'Revert "feat(x): y"'],
    ['merge branch', "Merge branch 'main' into feature/x"],
    ['fixup', 'fixup! feat(x): y'],
    ['prose subject', 'update the readme'],
  ])('allows %s with a warning instead of denying it', async (_label, message) => {
    const result = await evaluateCommand(`git commit -m ${JSON.stringify(message)}`);
    expect(result.verdict).toBe('allow');
    expect(result.reason).toBe('unparsable-but-not-parens');
    expect(result.warning).toBeTruthy();
  });

  it('denies a message that splits parentheses across lines even in a non-CHANGELOG type', async () => {
    // これが 59498fa の類型。type が test(...) なので check:commits の PR 分岐では warning
    // 止まりになり、実際に main へ入った。ここで止まらなければガードの存在意義が無い。
    const subject = 'test(bdboard-ekj3): 括弧の行またぎ';
    const body = UNPARSABLE_MESSAGE.split('\n').slice(1).join('\n');
    const result = await evaluateCommand(heredocCommit(`${subject}\n${body}`));
    expect(result.verdict).toBe('deny');
  });

  // 指摘 m2: 2 件目の commit も見る。
  it('denies the second commit of a && chain when the first one is fine', async () => {
    // 2 件目は本物の改行を含む必要があるので単引用符で埋め込む (本文に `'` は無い)。
    const command = `git commit -m 'feat(x): ok' && git commit -m '${ACROSS_LINES_MESSAGE}'`;
    const result = await evaluateCommand(command);
    expect(result.verdict).toBe('deny');
    expect(result.message).toBe(ACROSS_LINES_MESSAGE);
  });

  it('denies a bad message passed through -F - as a heredoc', async () => {
    const command = `git commit -F - <<'EOF'\n${ACROSS_LINES_MESSAGE}\nEOF\n`;
    expect((await evaluateCommand(command)).verdict).toBe('deny');
  });

  it('honours an override placed before git, with a reason', async () => {
    const command = heredocCommit(UNPARSABLE_MESSAGE, { prefix: `${OVERRIDE_ENV}="復元のため" ` });
    const result = await evaluateCommand(command);
    expect(result.verdict).toBe('allow');
    expect(result.reason).toBe('override');
    // 指摘 n4: 迂回したことが呼び出し元から見える形で残る。
    expect(result.overrode).toMatchObject({ kind: 'across-lines' });
  });

  it('ignores an empty override reason', async () => {
    const command = heredocCommit(UNPARSABLE_MESSAGE, { prefix: `${OVERRIDE_ENV}="" ` });
    expect((await evaluateCommand(command)).verdict).toBe('deny');
  });

  it('is not disarmed by the override name appearing inside the commit body', async () => {
    // deny 文言自身がこの変数名を含むので、それを本文へ貼り付けて再試行するだけで
    // ガードが外れてはならない。
    const poisoned = UNPARSABLE_MESSAGE.replace('\n\n', `\n\n${OVERRIDE_ENV}=bypass\n\n`);
    expect((await evaluateCommand(heredocCommit(poisoned))).verdict).toBe('deny');
  });

  it('falls open when the parser cannot be loaded', async () => {
    const result = await evaluateCommand(heredocCommit(UNPARSABLE_MESSAGE), {
      checkCommitMessage: null,
    });
    expect(result.verdict).toBe('allow');
    expect(result.reason).toBe('parser-unavailable');
  });

  it('falls open when the parser throws something unexpected', async () => {
    const result = await evaluateCommand(heredocCommit(UNPARSABLE_MESSAGE), {
      checkCommitMessage: () => {
        throw new Error('boom');
      },
    });
    expect(result).toMatchObject({ verdict: 'allow', reason: 'parser-threw' });
  });

  it('falls open when reading the message file throws', async () => {
    const result = await evaluateCommand('git commit -F msg.txt', {
      cwd: '/repo',
      readFile: () => {
        throw new Error('too large');
      },
    });
    expect(result).toMatchObject({ verdict: 'allow', reason: 'unreadable-file' });
  });

  it.each([
    ['undefined command', undefined],
    ['empty command', ''],
    ['whitespace command', '   '],
  ])('falls open on %s', async (_label, command) => {
    expect((await evaluateCommand(command)).verdict).toBe('allow');
  });
});

describe('commit-message-guard hook CLI', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-guard-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function runHook(payload) {
    return spawnSync(process.execPath, [GUARD_PATH], {
      input: typeof payload === 'string' ? payload : JSON.stringify(payload),
      encoding: 'utf8',
      cwd: tmpDir,
    });
  }

  function bashPayload(command) {
    return { tool_name: 'Bash', tool_input: { command }, cwd: tmpDir };
  }

  it(
    'exits 2 and explains where the parentheses broke',
    () => {
      const result = runHook(bashPayload(heredocCommit(UNPARSABLE_MESSAGE)));
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('74:37');
      expect(result.stderr).toContain('開いた括弧が次の行に持ち越されています');
      expect(result.stderr).toContain(OVERRIDE_ENV);
      // 指摘 n5: `export …` や `… && git commit` では効かないことを文面で示す。
      expect(result.stderr).toContain('git と同じコマンドの先頭');
    },
    15000,
  );

  it(
    'exits 0 and says nothing for a parsable commit',
    () => {
      const result = runHook(bashPayload(heredocCommit(PARSABLE_MESSAGE)));
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
    },
    15000,
  );

  // M1: `wip` は止めない。1 行だけ警告する。
  it(
    'exits 0 with a single warning line for a non-paren parse failure',
    () => {
      const result = runHook(bashPayload(`git commit -m 'wip'`));
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('commit-guard: warning');
      expect(result.stderr.trimEnd().split('\n')).toHaveLength(1);
    },
    15000,
  );

  // 指摘 n4: override を使ったら痕跡を残す。
  it(
    'exits 0 but records one line when the override is used',
    () => {
      const command = heredocCommit(UNPARSABLE_MESSAGE, {
        prefix: `${OVERRIDE_ENV}="復元のため" `,
      });
      const result = runHook(bashPayload(command));
      expect(result.status).toBe(0);
      expect(result.stderr).toContain(OVERRIDE_ENV);
      expect(result.stderr.trimEnd().split('\n')).toHaveLength(1);
    },
    15000,
  );

  it(
    'exits 2 for a nested-paren message and names the nesting',
    () => {
      const result = runHook(bashPayload(heredocCommit(NESTED_MESSAGE)));
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('内側にもう一つ');
    },
    15000,
  );

  it(
    'does not claim a paren was carried to the next line when there is no next line',
    () => {
      const result = runHook(bashPayload(heredocCommit(UNCLOSED_MESSAGE)));
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('最後まで閉じていません');
      expect(result.stderr).not.toContain('次の行に持ち越されています');
    },
    15000,
  );

  // 指摘 m6: `-F` が指す先を無制限に読まない。
  it(
    'exits 0 without reading an oversized -F file',
    () => {
      const big = path.join(tmpDir, 'big.txt');
      fs.writeFileSync(big, 'x'.repeat(MAX_MESSAGE_FILE_BYTES + 1));
      const result = runHook(bashPayload(`git commit -F ${big}`));
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
    },
    15000,
  );

  it(
    'exits 0 without reading a -F target that is a directory',
    () => {
      const result = runHook(bashPayload(`git commit -F ${tmpDir}`));
      expect(result.status).toBe(0);
    },
    15000,
  );

  it(
    'reads a real -F file relative to the hook cwd and denies a bad one',
    () => {
      fs.writeFileSync(path.join(tmpDir, 'msg.txt'), ACROSS_LINES_MESSAGE);
      const result = runHook(bashPayload('git commit -F msg.txt'));
      expect(result.status).toBe(2);
    },
    15000,
  );

  it.each([
    ['malformed stdin', 'not json at all'],
    ['empty stdin', ''],
  ])(
    'exits 0 on %s',
    (_label, payload) => {
      expect(runHook(payload).status).toBe(0);
    },
    15000,
  );

  it(
    'exits 0 for a non-Bash tool even if the payload looks like a bad commit',
    () => {
      const result = runHook({
        tool_name: 'Edit',
        tool_input: { command: heredocCommit(UNPARSABLE_MESSAGE) },
        cwd: tmpDir,
      });
      expect(result.status).toBe(0);
    },
    15000,
  );

  it.each([
    ['an unterminated heredoc', "git commit -m \"$(cat <<'EOF'\nsubject\n"],
    ['a missing -F target', 'git commit -F /nonexistent/definitely-not-here.txt'],
    ['a message built from a variable', 'git commit -m "$MSG"'],
    ['no command key at all', null],
  ])(
    'exits 0 for %s',
    (_label, command) => {
      const payload =
        command == null ? { tool_name: 'Bash', tool_input: {}, cwd: tmpDir } : bashPayload(command);
      expect(runHook(payload).status).toBe(0);
    },
    15000,
  );
});
