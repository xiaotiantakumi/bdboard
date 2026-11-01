import { chmodSync, mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RM_OPTIONS } from '../../../scripts/test-support/quiet-git.mjs';
import type { CommandResult } from '../../application/ports/command-runner.js';
import { NodeCommandRunner } from '../process/node-command-runner.js';

/**
 * bdboard-harness パックの hooks/deferred-due.sh の統合テスト (bdboard-aqyg)。
 * PATH に stub の bd を置き、呼ばれた引数を calls.log に残す。実の台帳には触れない。
 */

const SCRIPT = fileURLToPath(
  new URL('../../../harness/packs/bdboard-harness/hooks/deferred-due.sh', import.meta.url),
);

const STUB = `#!/bin/bash
echo "$*" >> "$STUB_DIR/calls.log"
case "$1 $2" in
  "list --deferred") cat "$STUB_DIR/deferred.json" ;;
  "list --label") cat "$STUB_DIR/due.json" ;;
esac
exit 0
`;

const runner = new NodeCommandRunner();

describe.skipIf(process.platform === 'win32')('bdboard-harness deferred-due.sh', { timeout: 30_000 }, () => {
  let root: string;
  let binDir: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'bdboard-deferred-due-'));
    binDir = path.join(root, 'bin');
    mkdirSync(binDir);
    writeFileSync(path.join(binDir, 'bd'), STUB);
    chmodSync(path.join(binDir, 'bd'), 0o755);
    setLists([], []);
  });

  afterEach(() => {
    rmSync(root, RM_OPTIONS);
  });

  function setLists(deferred: unknown[], due: unknown[]): void {
    writeFileSync(path.join(root, 'deferred.json'), JSON.stringify(deferred));
    writeFileSync(path.join(root, 'due.json'), JSON.stringify(due));
  }

  function calls(): string[] {
    const log = path.join(root, 'calls.log');
    return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((l) => l !== '') : [];
  }

  async function run(pathValue?: string): Promise<CommandResult> {
    return runner.run('bash', [SCRIPT], {
      input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' }),
      cwd: root,
      timeoutMs: 20_000,
      env: { PATH: pathValue ?? `${binDir}:${process.env.PATH ?? '/usr/bin:/bin'}`, STUB_DIR: root },
    });
  }

  const ITEM = { id: 'x-1', title: 'メモを読む', defer_until: '2026-11-07T00:00:00Z', labels: [] as string[] };

  it('stays silent and writes nothing when nothing is due', async () => {
    const result = await run();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(calls().filter((c) => c.startsWith('label') || c.startsWith('comment'))).toEqual([]);
  });

  it('lists a due deferred ticket first and marks it once with a label and a comment', async () => {
    setLists([ITEM], []);
    const result = await run();
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(output.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(output.hookSpecificOutput.additionalContext.startsWith('⏰ 期日到来: x-1 メモを読む (期日 2026-11-07)')).toBe(
      true,
    );
    expect(calls().filter((c) => c === 'label add x-1 due')).toHaveLength(1);
    expect(calls().filter((c) => c === 'comment x-1 期日到来 (deferred until 2026-11-07)')).toHaveLength(1);
  });

  it('does not write again when the label already exists, but keeps showing the ticket', async () => {
    setLists([{ ...ITEM, labels: ['due'] }], [{ id: 'x-2', title: '印済み', labels: ['due'] }]);
    const result = await run();
    const context = (JSON.parse(result.stdout) as { hookSpecificOutput: { additionalContext: string } })
      .hookSpecificOutput.additionalContext;
    expect(context).toContain('⏰ 期日到来: x-1 メモを読む (期日 2026-11-07)');
    expect(context).toContain('⏰ 期日到来: x-2 印済み');
    expect(calls().filter((c) => c.startsWith('label add') || c.startsWith('comment'))).toEqual([]);
  });

  it('exits 0 silently when bd is not installed', async () => {
    const bare = path.join(root, 'bare-bin');
    mkdirSync(bare);
    for (const name of ['bash', 'cat']) {
      const dir = (process.env.PATH ?? '/usr/bin:/bin').split(path.delimiter).find((d) => existsSync(path.join(d, name)));
      if (dir !== undefined) symlinkSync(path.join(dir, name), path.join(bare, name));
    }
    const result = await run(bare);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  });
});
