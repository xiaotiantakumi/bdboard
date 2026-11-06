// bdboard-l1m1.7: scripts/harness-uninject.mjs を実プロセスで起動して、TTY ゲートと dry-run を確かめる。
// vitest の子プロセスは標準入力がパイプ (TTY ではない) で、エージェントの Bash と同じ条件になる。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('./harness-uninject.mjs', import.meta.url));

describe('harness-uninject.mjs', () => {
  let tmpDir;
  let projectRoot;
  let skillFile;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'bdboard-uninject-script-'));
    projectRoot = path.join(tmpDir, 'project');
    skillFile = path.join(projectRoot, '.claude/skills/bdboard-harness/SKILL.md');
    mkdirSync(path.dirname(skillFile), { recursive: true });
    writeFileSync(skillFile, '# pack\n', 'utf8');
    writeFileSync(
      path.join(projectRoot, '.claude/bdboard-packs.json'),
      JSON.stringify({
        packs: [
          {
            name: 'bdboard-harness',
            version: '1.0.0',
            injectedAt: '2026-11-06T00:00:00Z',
            files: ['.claude/skills/bdboard-harness/SKILL.md'],
          },
        ],
      }),
      'utf8',
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function run(args) {
    return spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      input: '',
      timeout: 60_000,
    });
  }

  it('refuses --yes without a TTY: exit 2, tells the user to run it themselves, removes nothing', () => {
    const result = run(['--project', projectRoot, '--pack', 'bdboard-harness', '--yes']);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('ユーザーが自分の端末');
    expect(existsSync(skillFile)).toBe(true);
  });

  it('runs as a dry-run by default and removes nothing', () => {
    const result = run(['--project', projectRoot, '--pack', 'bdboard-harness']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('.claude/skills/bdboard-harness/SKILL.md');
    expect(result.stdout).toContain('dry-run');
    expect(existsSync(skillFile)).toBe(true);
  });

  it('prints usage and exits 2 without arguments', () => {
    const result = run([]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--project');
  });
});
