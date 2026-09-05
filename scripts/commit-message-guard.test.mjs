import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  OVERRIDE_ENV,
  evaluateCommand,
  extractCommitMessage,
  extractHeredocs,
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

/** Claude Code が実際に書く commit の形。ここを外すとガードは何も守らない。 */
function heredocCommit(message, { prefix = '', delimiter = 'EOF' } = {}) {
  return `${prefix}git commit -m "$(cat <<'${delimiter}'\n${message}\n${delimiter}\n)"`;
}

describe('extractHeredocs', () => {
  it('captures a quoted heredoc body and keeps it out of the residual', () => {
    const { heredocs, residual } = extractHeredocs(heredocCommit('subject\n\nbody; with | metachars'));
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
  ])('does not claim a message for %s', (_label, command) => {
    expect(extractCommitMessage(command).status).not.toBe('resolved');
  });
});

describe('evaluateCommand', () => {
  it('denies the unparsable fixture written through the heredoc form', async () => {
    const result = await evaluateCommand(heredocCommit(UNPARSABLE_MESSAGE));
    expect(result.verdict).toBe('deny');
    expect(result.line).toBe(74);
    expect(result.column).toBe(37);
  });

  it('allows the parsable fixture written the same way', async () => {
    const result = await evaluateCommand(heredocCommit(PARSABLE_MESSAGE));
    expect(result.verdict).toBe('allow');
    expect(result.reason).toBe('parsable');
  });

  it('allows a message whose parentheses close on the same line', async () => {
    const message = 'fix(bdboard-ekj3): 括弧を行内で閉じる\n\n本文で開いた (括弧) は同じ行で閉じている。\n';
    expect((await evaluateCommand(`git commit -m '${message}'`)).verdict).toBe('allow');
  });

  it('denies a message that splits parentheses across lines even in a non-CHANGELOG type', async () => {
    // これが 59498fa の類型。type が test(...) なので check:commits の PR 分岐では warning
    // 止まりになり、実際に main へ入った。ここで止まらなければガードの存在意義が無い。
    const subject = 'test(bdboard-ekj3): 括弧の行またぎ';
    const body = UNPARSABLE_MESSAGE.split('\n').slice(1).join('\n');
    const result = await evaluateCommand(heredocCommit(`${subject}\n${body}`));
    expect(result.verdict).toBe('deny');
  });

  it('honours an override placed before git, with a reason', async () => {
    const command = heredocCommit(UNPARSABLE_MESSAGE, { prefix: `${OVERRIDE_ENV}="復元のため" ` });
    expect((await evaluateCommand(command)).verdict).toBe('allow');
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

  it(
    'exits 2 and explains where the parentheses broke',
    () => {
      const result = runHook({
        tool_name: 'Bash',
        tool_input: { command: heredocCommit(UNPARSABLE_MESSAGE) },
        cwd: tmpDir,
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('74:37');
      expect(result.stderr).toContain('開いた括弧が次の行に持ち越されています');
      expect(result.stderr).toContain(OVERRIDE_ENV);
    },
    15000,
  );

  it(
    'exits 0 and says nothing for a parsable commit',
    () => {
      const result = runHook({
        tool_name: 'Bash',
        tool_input: { command: heredocCommit(PARSABLE_MESSAGE) },
        cwd: tmpDir,
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
    },
    15000,
  );

  it.each([
    ['malformed stdin', 'not json at all'],
    ['empty stdin', ''],
  ])('exits 0 on %s', (_label, payload) => {
    expect(runHook(payload).status).toBe(0);
  }, 15000);

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
});
