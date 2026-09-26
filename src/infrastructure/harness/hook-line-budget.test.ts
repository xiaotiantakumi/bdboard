import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HOOKS_DIR = fileURLToPath(new URL('../../../harness/packs/bdboard-harness/hooks/', import.meta.url));
// Raising this budget requires recording the reason as a ticket ID in the same commit/PR.
const HOOK_LINE_BUDGET = 3538;
// Raising this budget requires recording the reason as a ticket ID in the same commit/PR.
const README_LINE_BUDGET = 400;

describe('harness hook line budgets', () => {
  it('keeps shell hooks within the budget', () => {
    const lines = readdirSync(HOOKS_DIR).filter((name) => name.endsWith('.sh'))
      .reduce((total, name) => total + readFileSync(join(HOOKS_DIR, name), 'utf8').split(/\r?\n/).length - 1, 0);
    expect(lines).toBeLessThanOrEqual(HOOK_LINE_BUDGET);
  });

  it.skip('keeps hooks README within 400 lines after H-7 (bdboard-cm2q.10)', () => {
    const readme = join(HOOKS_DIR, 'README.md');
    const lines = readFileSync(readme, 'utf8').split(/\r?\n/).length - 1;
    expect(lines).toBeLessThanOrEqual(README_LINE_BUDGET);
  });
});
