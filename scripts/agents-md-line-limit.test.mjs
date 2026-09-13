// bdboard-pkr6.23: AGENTS.md (CLAUDE.md はそのシンボリックリンク) の「200 行以下に保つ」を機械検査する。
//
// AGENTS.md は常時ロードされる指示なので、肥大化はすべてのセッションのコンテキストを削る。上限は
// AGENTS.md 冒頭が自ら定めているが、手作業の注意だけでは守りきれない — 管理ブロック
// (<!-- BEGIN BEADS INTEGRATION --> 等のマーカー内側) は `bd init` / `bd setup <tool>` が黙って
// 再生成し、行数が増えても誰も気付かない (bdboard-ejz の前例)。
//
// 行数の数え方は `wc -l` と一致させる (末尾改行で終わる 200 行のファイルは 200)。Windows で
// core.autocrlf により CRLF でチェックアウトされても同じ値になる — \r\n にも \n は 1 個しか
// 含まれないため。countLines の \r\n → \n 置換は結果を変えないが、意図を明示するために残している。CLAUDE.md は Windows でシンボリックリンクが実体化されないことがあるため
// 読まず、実体の AGENTS.md だけを読む。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const AGENTS_MD_MAX_LINES = 200;

// `wc -l` 相当: 改行の数。ただし末尾改行が無い最終行も 1 行として数える (wc -l は数えないが、
// 末尾改行を消すだけで上限をすり抜けられないようにする)。
function countLines(text) {
  if (text.length === 0) return 0;
  const normalized = text.replace(/\r\n/g, '\n');
  const newlines = normalized.split('\n').length - 1;
  return normalized.endsWith('\n') ? newlines : newlines + 1;
}

// 上限内なら null、超過なら移設先の手がかり付きの失敗メッセージを返す。
function checkAgentsMdLineLimit(text, max = AGENTS_MD_MAX_LINES) {
  const lines = countLines(text);
  if (lines <= max) return null;
  return [
    `AGENTS.md is ${lines} lines (limit ${max}, over by ${lines - max}).`,
    'AGENTS.md / CLAUDE.md is always loaded — keep only "always needed" rules and "when to read what" pointers there.',
    'Move details out and leave a one-line pointer:',
    '  - procedures an agent follows on demand -> a skill under .claude/skills/<name>/SKILL.md',
    '  - rules that only matter when touching certain paths -> a path-scoped rule under .claude/rules/',
    '  - background, rationale, incident history -> docs/ (e.g. docs/GIT-WORKFLOW.md, docs/VERIFY.md)',
    'If the growth came from `bd init` / `bd setup <tool>` regenerating the managed Beads block,',
    'review it per .claude/rules/bd-init-agents-md.md instead of hand-editing inside the markers.',
  ].join('\n');
}

describe('countLines', () => {
  it('matches wc -l for text ending with a newline', () => {
    expect(countLines('a\nb\nc\n')).toBe(3);
  });

  it('counts a final line without a trailing newline', () => {
    expect(countLines('a\nb\nc')).toBe(3);
  });

  it('counts CRLF line endings the same as LF (Windows autocrlf checkout)', () => {
    expect(countLines('a\r\nb\r\nc\r\n')).toBe(3);
    expect(countLines('a\r\nb\r\nc')).toBe(3);
  });

  it('counts blank lines', () => {
    expect(countLines('\n\n\n')).toBe(3);
  });

  it('returns 0 for an empty file', () => {
    expect(countLines('')).toBe(0);
  });
});

describe('checkAgentsMdLineLimit', () => {
  const linesOf = (n, eol = '\n') => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join(eol) + eol;

  it('passes at exactly the limit (200 lines)', () => {
    expect(checkAgentsMdLineLimit(linesOf(200))).toBeNull();
    expect(checkAgentsMdLineLimit(linesOf(200, '\r\n'))).toBeNull();
  });

  it('fails one line over the limit (201 lines)', () => {
    expect(checkAgentsMdLineLimit(linesOf(201))).toMatch(/201 lines \(limit 200, over by 1\)/);
    expect(checkAgentsMdLineLimit(linesOf(201, '\r\n'))).toMatch(/201 lines/);
  });

  it('names where to move content in the failure message', () => {
    const message = checkAgentsMdLineLimit(linesOf(201));
    expect(message).toContain('.claude/skills/');
    expect(message).toContain('.claude/rules/');
    expect(message).toContain('docs/');
    expect(message).toContain('.claude/rules/bd-init-agents-md.md');
  });
});

describe('AGENTS.md', () => {
  it(`stays within ${AGENTS_MD_MAX_LINES} lines`, () => {
    const text = fs.readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8');
    const failure = checkAgentsMdLineLimit(text);
    // expect.fail なら移設先の手がかりが改行付きのまま 1 回だけ表示される
    // (toBeNull に message を渡すと、エスケープされた差分と合わせて 2 回出る)。
    if (failure !== null) expect.fail(failure);
  });
});
