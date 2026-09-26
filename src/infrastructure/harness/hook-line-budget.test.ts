import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HOOKS_DIR = fileURLToPath(new URL('../../../harness/packs/bdboard-harness/hooks/', import.meta.url));

// H-7 (bdboard-cm2q.10) でこれらが消えたら README の行数検査を自動的に有効化する。
const H7_PENDING = ['server-guard.sh', 'worktree-owner-guard.sh', 'lib-main-checkout.sh'].some((name) =>
  existsSync(join(HOOKS_DIR, name)),
);

// 3538 = 2026-09-26 の origin/main の実測 (bdboard-cm2q.5)。H-7 (bdboard-cm2q.10) で実測 +10% に
// 下げる。上げるときは、ここに理由のチケット ID を書き足す。
const HOOK_LINE_BUDGET = 3538;
// Raising this budget requires recording the reason as a ticket ID in the same commit/PR.
const README_LINE_BUDGET = 400;

const FIX_HINT =
  '直し方: 削る / 既知の限界に回す (references/ 等) / 上げるなら理由のチケット ID をこの定数の' +
  '横に書く。コメントを削って収めない。';

const countLines = (path: string): number => readFileSync(path, 'utf8').split(/\r?\n/).length - 1;

// hooks/ 配下の README.md を除く通常ファイルすべて (サブディレクトリ・拡張子問わず) を数える。
const hookFiles = (): { path: string; lines: number }[] =>
  readdirSync(HOOKS_DIR, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== 'README.md')
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return { path, lines: countLines(path) };
    });

describe('harness hook line budgets', () => {
  it('keeps hook files within the budget', () => {
    const files = hookFiles();
    expect(files.length).toBeGreaterThan(0);
    const total = files.reduce((sum, file) => sum + file.lines, 0);
    if (total <= HOOK_LINE_BUDGET) return;
    const breakdown = files.map((file) => `  ${file.path}: ${file.lines}`).join('\n');
    expect.fail(`hooks total ${total} lines exceeds budget ${HOOK_LINE_BUDGET}.\n${breakdown}\n\n${FIX_HINT}`);
  });

  it('keeps the budget from drifting above the measured total', () => {
    const total = hookFiles().reduce((sum, file) => sum + file.lines, 0);
    expect(HOOK_LINE_BUDGET).toBeLessThanOrEqual(Math.ceil(total * 1.1));
  });

  it.skipIf(H7_PENDING)('keeps hooks README within 400 lines after H-7 (bdboard-cm2q.10)', () => {
    expect(countLines(join(HOOKS_DIR, 'README.md'))).toBeLessThanOrEqual(README_LINE_BUDGET);
  });
});
